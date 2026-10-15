// PostgreSQL sağlayıcısı (pg + pg-cursor, MIT).
// - Sonuçlar sunucu tarafı imleçle 500'lük parçalar halinde okunur; ilk parça hemen arayüze gider.
// - Tarih/saat, numeric, int8, json gibi tipler sunucunun metin biçiminde bırakılır (saat dilimi kayması yok).
// - Salt okunur kip oturum düzeyinde: SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY.
// - Her veritabanı için ayrı istemci açılır (ağaçta başka veritabanını genişletmek / sekmede seçmek için).
import { Client, type ClientConfig, type FieldDef } from 'pg';
import Cursor from 'pg-cursor';
import type {
  Capabilities, ColumnMeta, CompletionSchema, ConnectionConfig, IDataSourceConnection, IDataSourceProvider,
  NodePath, QueryOptions, ServerInfo, StatementEvent, TreeNode,
} from '../provider';
import { toRow } from '../values';
import { ident, qualified } from '../sql/dialect';

const CAPS: Capabilities = {
  dialect: 'postgres', kind: 'server', databases: true, schemas: true, materializedViews: true, functions: true,
  procedures: true, triggers: true, sequences: true, types: true, indexes: true, cancel: 'native', readOnly: 'session',
};

// Yalnız bu tipler JS değerine çevrilir; diğerleri metin olarak kalır
const PARSED: Record<number, (v: string) => unknown> = {
  16: (v) => v === 't', // bool
  21: Number, 23: Number, 26: Number, 700: Number, 701: Number, // int2 int4 oid float4 float8
};
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);
const types = { getTypeParser: (oid: number) => PARSED[oid] ?? ((v: string) => v) } as unknown as ClientConfig['types'];

const SYS_SCHEMAS = "('pg_catalog','information_schema','pg_toast')";

function sslOption(cfg: ConnectionConfig): ClientConfig['ssl'] {
  const mode = cfg.ssl?.mode ?? 'prefer';
  if (mode === 'disable') return false;
  if (mode === 'verify-full') return { rejectUnauthorized: true, ca: cfg.ssl?.ca || undefined };
  return { rejectUnauthorized: false };
}

const isNoSslError = (e: unknown) => /does not support SSL|SSL off|no pg_hba.conf entry.*SSL off/i.test(String((e as Error)?.message ?? e));

class PgConnection implements IDataSourceConnection {
  readonly capabilities = CAPS;
  private clients = new Map<string, Promise<Client>>();
  /** Veritabanı başına oid → tip adı (özel tiplerin oid'leri veritabanına göre değişir) */
  private typeNames = new Map<string, Map<number, string>>();
  private typesStale = new Set<string>();
  private active: { client: Client; cursor?: Cursor } | null = null;
  private readOnly: boolean;
  private tls = false;
  private ssl: ClientConfig['ssl'];
  readonly defaultDb: string;

  constructor(private cfg: ConnectionConfig) {
    this.readOnly = cfg.readOnly;
    this.defaultDb = cfg.database || cfg.user || 'postgres';
    this.ssl = sslOption(cfg);
  }

  private config(database: string, ssl: ClientConfig['ssl']): ClientConfig {
    return {
      host: this.cfg.host || 'localhost',
      port: this.cfg.port || 5432,
      user: this.cfg.user,
      password: this.cfg.password,
      database,
      ssl,
      types,
      application_name: this.cfg.appName || 'SQL Master',
      connectionTimeoutMillis: this.cfg.connectTimeoutMs ?? 15000,
      keepAlive: true,
    };
  }

  private async openClient(database: string): Promise<Client> {
    const tryOpen = async (ssl: ClientConfig['ssl']) => {
      const c = new Client(this.config(database, ssl));
      c.on('error', () => this.clients.delete(database)); // bağlantı koptu: bir sonraki istekte yeniden açılır
      await c.connect();
      return c;
    };
    let c: Client;
    try {
      c = await tryOpen(this.ssl);
      this.tls = !!this.ssl;
    } catch (e) {
      // "prefer": sunucu TLS desteklemiyorsa şifresiz bağlan (arayüz uyarı gösterir)
      if ((this.cfg.ssl?.mode ?? 'prefer') !== 'prefer' || !isNoSslError(e)) throw e;
      this.ssl = false;
      c = await tryOpen(false);
      this.tls = false;
    }
    if (this.readOnly) await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    return c;
  }

  client(database = this.defaultDb): Promise<Client> {
    let p = this.clients.get(database);
    if (!p) {
      p = this.openClient(database);
      p.catch(() => this.clients.delete(database));
      this.clients.set(database, p);
    }
    return p;
  }

  async init(): Promise<void> {
    await this.client();
  }

  private async q<T = Record<string, unknown>>(sql: string, params: unknown[] = [], database?: string): Promise<T[]> {
    const c = await this.client(database);
    const r = await c.query(sql, params);
    return r.rows as T[];
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.q<{ v: string; db: string; u: string }>("select current_setting('server_version') v, current_database() db, current_user u");
    return { product: `PostgreSQL ${r.v}`, version: r.v, database: r.db, user: r.u, tls: this.tls };
  }

  async setReadOnly(on: boolean): Promise<void> {
    this.readOnly = on;
    const sql = on ? 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY' : 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE';
    for (const p of this.clients.values()) {
      const c = await p.catch(() => null);
      if (c) await c.query(sql);
    }
  }

  // --- Sorgu ------------------------------------------------------------------
  // Tip adları imleç açılmadan önce yüklenir: imleç sürerken aynı istemcide başka sorgu kuyrukta bekler (kilitlenir)
  private async loadTypes(c: Client, db: string) {
    const r = await c.query('select oid::int oid, format_type(oid, null) n from pg_type');
    this.typeNames.set(db, new Map((r.rows as { oid: number; n: string }[]).map((x) => [x.oid, x.n])));
    this.typesStale.delete(db);
  }

  private typeName(db: string, oid: number): string {
    const n = this.typeNames.get(db)?.get(oid);
    if (n === undefined) this.typesStale.add(db); // yeni oluşturulmuş tip: bir sonraki sorguda yenilenir
    return n ?? String(oid);
  }

  async *query(sql: string, opts: QueryOptions): AsyncIterable<StatementEvent> {
    const db = opts.database ?? this.defaultDb;
    const c = await this.client(db);
    if (!this.typeNames.has(db) || this.typesStale.has(db)) await this.loadTypes(c, db);
    const notices: string[] = [];
    const onNotice = (n: { message?: string; severity?: string }) => notices.push(`${n.severity ?? 'NOTICE'}: ${n.message ?? ''}`);
    c.on('notice', onNotice);
    const cursor = c.query(new Cursor(sql, [], { rowMode: 'array' }));
    this.active = { client: c, cursor };
    const read = (n: number) =>
      new Promise<{ rows: unknown[][]; fields: FieldDef[]; command: string | null; rowCount: number | null }>((resolve, reject) =>
        cursor.read(n, (err, rows, result) => (err ? reject(err) : resolve({ rows: rows as unknown[][], fields: result?.fields ?? [], command: result?.command ?? null, rowCount: result?.rowCount ?? null })))
      );
    try {
      const limit = opts.limit > 0 ? opts.limit : Infinity;
      let total = 0;
      let first = true;
      let fields: FieldDef[] = [];
      for (;;) {
        const want = Math.min(opts.batchSize, limit - total);
        const r = await read(want > 0 ? want : 1);
        if (first) {
          first = false;
          fields = r.fields;
          if (!fields.length) {
            // DDL/DML: satır yok, etkilenen satır sayısı
            const cmd = r.command ?? 'OK';
            const affected = /^(INSERT|UPDATE|DELETE|MERGE|COPY|SELECT|MOVE|FETCH)$/.test(cmd) ? r.rowCount : null;
            yield* this.flushNotices(notices);
            yield { type: 'command', command: cmd, rowsAffected: affected };
            return;
          }
          const columns: ColumnMeta[] = [];
          for (const f of fields) columns.push({ name: f.name, type: this.typeName(db, f.dataTypeID), numeric: NUMERIC_OIDS.has(f.dataTypeID) });
          yield { type: 'columns', columns };
        }
        if (want <= 0) {
          // Sınıra ulaşıldı: bir satır daha var mı?
          yield* this.flushNotices(notices);
          yield { type: 'end', rowCount: total, truncated: r.rows.length > 0 };
          return;
        }
        if (r.rows.length) {
          total += r.rows.length;
          yield { type: 'rows', rows: r.rows.map(toRow) };
        }
        if (r.rows.length < want || opts.signal.aborted) {
          yield* this.flushNotices(notices);
          yield { type: 'end', rowCount: total, truncated: false };
          return;
        }
      }
    } finally {
      c.off('notice', onNotice);
      this.active = null;
      // İmleç kapanmazsa (bağlantı bozulduysa) istemciyi bırak; sıradaki istek yeni istemci açar
      const closed = await Promise.race([
        new Promise<boolean>((resolve) => cursor.close(() => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!closed) {
        this.clients.delete(db);
        void c.end().catch(() => {});
      }
    }
  }

  private *flushNotices(list: string[]): Iterable<StatementEvent> {
    while (list.length) yield { type: 'notice', message: list.shift()! };
  }

  async cancel(): Promise<void> {
    const a = this.active;
    if (!a) return;
    const pid = (a.client as unknown as { processID: number }).processID;
    const c = new Client(this.config(this.defaultDb, this.ssl));
    try {
      await c.connect();
      await c.query('select pg_cancel_backend($1)', [pid]);
    } finally {
      await c.end().catch(() => {});
    }
  }

  // --- Ağaç ---------------------------------------------------------------------
  async getChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const rows = await this.q<{ datname: string }>('select datname from pg_database where not datistemplate and datallowconn order by datname');
      // Bağlantının veritabanı en üstte
      rows.sort((a, b) => (a.datname === this.defaultDb ? -1 : b.datname === this.defaultDb ? 1 : 0));
      return rows.map((r) => ({ id: `db:${r.datname}`, kind: 'database', name: r.datname, hasChildren: true, path: { database: r.datname } }));
    }
    const p = parent.path;
    const db = p.database ?? this.defaultDb;
    switch (parent.kind) {
      case 'database': {
        const rows = await this.q<{ nspname: string }>(
          `select nspname from pg_namespace where nspname not in ${SYS_SCHEMAS} and nspname not like 'pg_temp_%' and nspname not like 'pg_toast_temp_%' order by nspname = 'public' desc, nspname`, [], db);
        return rows.map((r) => ({ id: `db:${db}/s:${r.nspname}`, kind: 'schema', name: r.nspname, hasChildren: true, path: { database: db, schema: r.nspname } }));
      }
      case 'schema':
        return this.schemaFolders(db, p.schema!);
      case 'folder':
        return this.folderItems(parent);
      case 'table':
      case 'view':
      case 'matview':
      case 'foreign-table':
        return this.tableFolders(parent);
      default:
        return [];
    }
  }

  private async schemaFolders(db: string, schema: string): Promise<TreeNode[]> {
    const [c] = await this.q<Record<string, string>>(
      `select
        (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) tables,
        (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind = 'v') views,
        (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind = 'm') matviews,
        (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind = 'f') foreign_tables,
        (select count(*) from pg_proc p where p.pronamespace = n.oid and p.prokind in ('f','a','w')) functions,
        (select count(*) from pg_proc p where p.pronamespace = n.oid and p.prokind = 'p') procedures,
        (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = n.oid and not t.tgisinternal) triggers,
        (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind = 'S') sequences,
        (select count(*) from pg_type t where t.typnamespace = n.oid and (t.typtype in ('e','d','r') or (t.typtype = 'c' and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c')))) types
       from pg_namespace n where n.nspname = $1`, [schema], db);
    const folders: [string, string][] = [
      ['tables', 'Tables'], ['views', 'Views'], ['matviews', 'Materialized views'], ['foreign_tables', 'Foreign tables'],
      ['functions', 'Functions'], ['procedures', 'Procedures'], ['triggers', 'Triggers'], ['sequences', 'Sequences'], ['types', 'Types'],
    ];
    return folders
      .filter(([k]) => k !== 'foreign_tables' || Number(c?.[k]) > 0)
      .map(([k, name]) => ({
        id: `db:${db}/s:${schema}/f:${k}`, kind: 'folder' as const, name, count: Number(c?.[k] ?? 0),
        hasChildren: Number(c?.[k] ?? 0) > 0, path: { database: db, schema, folder: k },
      }));
  }

  private async folderItems(parent: TreeNode): Promise<TreeNode[]> {
    const { database: db, schema, folder, table } = parent.path;
    const base = `db:${db}/s:${schema}`;
    const mk = (kind: TreeNode['kind'], name: string, extra: Partial<TreeNode> & { pathExtra?: Partial<NodePath> } = {}): TreeNode => {
      const { pathExtra, ...rest } = extra;
      const path: NodePath = { database: db, schema, name, ...(table ? { table } : {}), ...pathExtra };
      const id = `${base}/${path.table ? `t:${path.table}/` : ''}${kind}:${path.objectId ?? name}`;
      return { id, kind, name, hasChildren: false, path, ...rest };
    };
    const relkinds: Record<string, [string, TreeNode['kind']]> = {
      tables: ["'r','p'", 'table'], views: ["'v'", 'view'], matviews: ["'m'", 'matview'], foreign_tables: ["'f'", 'foreign-table'], sequences: ["'S'", 'sequence'],
    };
    if (!table && relkinds[folder!]) {
      const [kinds, kind] = relkinds[folder!];
      const rows = await this.q<{ relname: string; est: string }>(
        `select c.relname, c.reltuples::bigint est from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind in (${kinds}) and not c.relispartition order by c.relname`, [schema], db);
      const isData = kind !== 'sequence';
      return rows.map((r) => mk(kind, r.relname, {
        hasChildren: isData, openAs: isData ? 'data' : 'code',
        detail: kind === 'table' && Number(r.est) >= 0 ? `~${Number(r.est).toLocaleString('tr-TR')}` : undefined,
      }));
    }
    if (!table && (folder === 'functions' || folder === 'procedures')) {
      const rows = await this.q<{ oid: string; proname: string; args: string; ret: string }>(
        `select p.oid::text oid, p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) ret
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = $1 and p.prokind ${folder === 'procedures' ? "= 'p'" : "in ('f','a','w')"} order by p.proname, args`, [schema], db);
      return rows.map((r) => mk(folder === 'procedures' ? 'procedure' : 'function', r.proname, {
        detail: `(${r.args})${r.ret ? ' → ' + r.ret : ''}`, openAs: 'code', pathExtra: { objectId: r.oid },
      }));
    }
    if (folder === 'triggers') {
      const rows = await this.q<{ oid: string; tgname: string; relname: string }>(
        `select t.oid::text oid, t.tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and not t.tgisinternal ${table ? 'and c.relname = $2' : ''} order by c.relname, t.tgname`, table ? [schema, table] : [schema], db);
      return rows.map((r) => mk('trigger', r.tgname, { detail: table ? undefined : r.relname, openAs: 'code', pathExtra: { objectId: r.oid, table: r.relname } }));
    }
    if (!table && folder === 'types') {
      const rows = await this.q<{ oid: string; typname: string; typtype: string }>(
        `select t.oid::text oid, t.typname, t.typtype from pg_type t join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = $1 and (t.typtype in ('e','d','r') or (t.typtype = 'c' and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c')))
         order by t.typname`, [schema], db);
      const label: Record<string, string> = { e: 'enum', d: 'domain', r: 'range', c: 'composite' };
      return rows.map((r) => mk('type', r.typname, { detail: label[r.typtype], openAs: 'code', pathExtra: { objectId: r.oid } }));
    }
    if (table && folder === 'columns') {
      const rows = await this.q<{ attname: string; t: string; nn: boolean; pk: boolean }>(
        `select a.attname, format_type(a.atttypid, a.atttypmod) t, a.attnotnull nn,
           exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)) pk
         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [schema, table], db);
      return rows.map((r) => mk('column', r.attname, { detail: `${r.t}${r.nn ? ' NOT NULL' : ''}${r.pk ? ' · PK' : ''}` }));
    }
    if (table && folder === 'indexes') {
      const rows = await this.q<{ oid: string; relname: string; uniq: boolean; prim: boolean }>(
        `select i.indexrelid::text oid, ic.relname, i.indisunique uniq, i.indisprimary prim from pg_index i
         join pg_class ic on ic.oid = i.indexrelid join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relname = $2 order by ic.relname`, [schema, table], db);
      return rows.map((r) => mk('index', r.relname, { detail: r.prim ? 'PRIMARY' : r.uniq ? 'UNIQUE' : undefined, openAs: 'code', pathExtra: { objectId: r.oid } }));
    }
    if (table && folder === 'constraints') {
      const rows = await this.q<{ oid: string; conname: string; contype: string }>(
        `select k.oid::text oid, k.conname, k.contype from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relname = $2 order by k.contype, k.conname`, [schema, table], db);
      const label: Record<string, string> = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE' };
      return rows.map((r) => mk('constraint', r.conname, { detail: label[r.contype] ?? r.contype, openAs: 'code', pathExtra: { objectId: r.oid } }));
    }
    return [];
  }

  private tableFolders(parent: TreeNode): TreeNode[] {
    const { database, schema, name } = parent.path;
    const isTable = parent.kind === 'table';
    const list: [string, string][] = isTable
      ? [['columns', 'Columns'], ['indexes', 'Indexes'], ['constraints', 'Constraints'], ['triggers', 'Triggers']]
      : parent.kind === 'matview' ? [['columns', 'Columns'], ['indexes', 'Indexes']] : [['columns', 'Columns'], ['triggers', 'Triggers']];
    return list.map(([k, label]) => ({
      id: `${parent.id}/f:${k}`, kind: 'folder' as const, name: label, hasChildren: true, path: { database, schema, table: name, folder: k },
    }));
  }

  // --- Kolonlar / tamamlama ---------------------------------------------------------
  async getColumns(p: NodePath): Promise<ColumnMeta[]> {
    const rows = await this.q<{ attname: string; t: string; cat: string }>(
      `select a.attname, format_type(a.atttypid, a.atttypmod) t, ty.typcategory cat
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace join pg_type ty on ty.oid = a.atttypid
       where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [p.schema ?? 'public', p.table ?? p.name], p.database);
    return rows.map((r) => ({ name: r.attname, type: r.t, numeric: r.cat === 'N' }));
  }

  async getCompletionSchema(database?: string): Promise<CompletionSchema> {
    const rows = await this.q<{ s: string; t: string; c: string }>(
      `select n.nspname s, c.relname t, a.attname c from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where c.relkind in ('r','p','v','m','f') and n.nspname not in ${SYS_SCHEMAS} and n.nspname not like 'pg_temp_%'
       order by n.nspname, c.relname, a.attnum limit 50000`, [], database);
    const tables: CompletionSchema['tables'] = {};
    for (const r of rows) ((tables[r.s] ??= {})[r.t] ??= []).push(r.c);
    const [sp] = await this.q<{ s: string }>('select current_schema() s', [], database);
    return { tables, defaultSchema: sp?.s ?? 'public' };
  }

  // --- DDL --------------------------------------------------------------------------
  async getObjectDdl(node: TreeNode): Promise<string> {
    const p = node.path;
    const db = p.database;
    const one = async (sql: string, params: unknown[]) => {
      const [r] = await this.q<{ d: string }>(sql, params, db);
      return r?.d ?? '';
    };
    const rel = `(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2)`;
    switch (node.kind) {
      case 'view':
        return `CREATE OR REPLACE VIEW ${qualified({ schema: p.schema, name: p.name! }, 'postgres')} AS\n` + (await one(`select pg_get_viewdef(${rel}, true) d`, [p.schema, p.name])).trimEnd();
      case 'matview': {
        const body = (await one(`select pg_get_viewdef(${rel}, true) d`, [p.schema, p.name])).trim().replace(/;$/, '');
        const idx = await this.q<{ d: string }>(`select pg_get_indexdef(i.indexrelid) d from pg_index i where i.indrelid = ${rel}`, [p.schema, p.name], db);
        return `CREATE MATERIALIZED VIEW ${qualified({ schema: p.schema, name: p.name! }, 'postgres')} AS\n${body};\n` + idx.map((r) => `\n${r.d};`).join('');
      }
      case 'function':
      case 'procedure':
        return (await one('select pg_get_functiondef($1::oid) d', [p.objectId])).trimEnd() + ';';
      case 'trigger': {
        const [r] = await this.q<{ d: string; f: string }>('select pg_get_triggerdef(t.oid, true) d, pg_get_functiondef(t.tgfoid) f from pg_trigger t where t.oid = $1::oid', [p.objectId], db);
        return r ? `${r.d};\n\n-- Trigger function\n${r.f.trimEnd()};` : '';
      }
      case 'index':
        return (await one('select pg_get_indexdef($1::oid) d', [p.objectId])) + ';';
      case 'constraint': {
        const [r] = await this.q<{ d: string; tbl: string }>(
          'select pg_get_constraintdef(k.oid, true) d, k.conrelid::regclass::text tbl from pg_constraint k where k.oid = $1::oid', [p.objectId], db);
        return r ? `ALTER TABLE ${r.tbl}\n  ADD CONSTRAINT ${ident(p.name!, 'postgres')} ${r.d};` : '';
      }
      case 'sequence': {
        const [s] = await this.q<Record<string, string | boolean>>(
          `select data_type::text, start_value, min_value, max_value, increment_by, cycle, cache_size, last_value from pg_sequences where schemaname = $1 and sequencename = $2`, [p.schema, p.name], db);
        if (!s) return '';
        return `CREATE SEQUENCE ${qualified({ schema: p.schema, name: p.name! }, 'postgres')}\n  AS ${s.data_type}\n  INCREMENT BY ${s.increment_by}\n  MINVALUE ${s.min_value}\n  MAXVALUE ${s.max_value}\n  START WITH ${s.start_value}\n  CACHE ${s.cache_size}${s.cycle ? '\n  CYCLE' : ''};` +
          (s.last_value != null ? `\n\n-- last_value: ${s.last_value}` : '');
      }
      case 'type':
        return this.typeDdl(p);
      case 'table':
      case 'foreign-table':
        return this.tableDdl(p);
      default:
        return '';
    }
  }

  private async typeDdl(p: NodePath): Promise<string> {
    const db = p.database;
    const name = qualified({ schema: p.schema, name: p.name! }, 'postgres');
    const [t] = await this.q<{ typtype: string; base: string | null; nn: boolean; def: string | null; typrelid: string }>(
      `select t.typtype, format_type(t.typbasetype, t.typtypmod) base, t.typnotnull nn, t.typdefault def, t.typrelid::text typrelid from pg_type t where t.oid = $1::oid`, [p.objectId], db);
    if (!t) return '';
    if (t.typtype === 'e') {
      const labels = await this.q<{ l: string }>('select enumlabel l from pg_enum where enumtypid = $1::oid order by enumsortorder', [p.objectId], db);
      return `CREATE TYPE ${name} AS ENUM (\n${labels.map((x) => `  '${x.l.replace(/'/g, "''")}'`).join(',\n')}\n);`;
    }
    if (t.typtype === 'd') {
      const checks = await this.q<{ d: string; n: string }>('select conname n, pg_get_constraintdef(oid, true) d from pg_constraint where contypid = $1::oid', [p.objectId], db);
      return `CREATE DOMAIN ${name} AS ${t.base}${t.def ? `\n  DEFAULT ${t.def}` : ''}${t.nn ? '\n  NOT NULL' : ''}${checks.map((c) => `\n  CONSTRAINT ${ident(c.n, 'postgres')} ${c.d}`).join('')};`;
    }
    if (t.typtype === 'r') {
      const [r] = await this.q<{ sub: string }>('select format_type(rngsubtype, null) sub from pg_range where rngtypid = $1::oid', [p.objectId], db);
      return `CREATE TYPE ${name} AS RANGE (\n  SUBTYPE = ${r?.sub}\n);`;
    }
    const attrs = await this.q<{ n: string; t: string }>(
      'select attname n, format_type(atttypid, atttypmod) t from pg_attribute where attrelid = $1::oid and attnum > 0 and not attisdropped order by attnum', [t.typrelid], db);
    return `CREATE TYPE ${name} AS (\n${attrs.map((a) => `  ${ident(a.n, 'postgres')} ${a.t}`).join(',\n')}\n);`;
  }

  private async tableDdl(p: NodePath): Promise<string> {
    const db = p.database;
    const name = qualified({ schema: p.schema, name: p.name! }, 'postgres');
    const [rel] = await this.q<{ oid: string; relkind: string; part: string | null; comment: string | null; persistence: string }>(
      `select c.oid::text oid, c.relkind, case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end part, obj_description(c.oid, 'pg_class') comment, c.relpersistence persistence
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`, [p.schema, p.name], db);
    if (!rel) return '';
    const cols = await this.q<{ n: string; t: string; nn: boolean; def: string | null; ident: string; gen: string; comment: string | null; coll: string | null }>(
      `select a.attname n, format_type(a.atttypid, a.atttypmod) t, a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) def,
         a.attidentity ident, a.attgenerated gen, col_description(a.attrelid, a.attnum) comment,
         case when a.attcollation <> ty.typcollation then (select collname from pg_collation where oid = a.attcollation) end coll
       from pg_attribute a join pg_type ty on ty.oid = a.atttypid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped order by a.attnum`, [rel.oid], db);
    const cons = await this.q<{ n: string; d: string }>(
      `select conname n, pg_get_constraintdef(oid, true) d from pg_constraint where conrelid = $1::oid order by case contype when 'p' then 0 when 'u' then 1 when 'f' then 2 else 3 end, conname`, [rel.oid], db);
    const idx = await this.q<{ d: string }>(
      `select pg_get_indexdef(i.indexrelid) d from pg_index i where i.indrelid = $1::oid and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.conrelid = i.indrelid) order by 1`, [rel.oid], db);
    const lines = cols.map((c) => {
      let s = `  ${ident(c.n, 'postgres')} ${c.t}`;
      if (c.coll) s += ` COLLATE ${ident(c.coll, 'postgres')}`;
      if (c.ident) s += ` GENERATED ${c.ident === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
      else if (c.gen === 's' && c.def) s += ` GENERATED ALWAYS AS (${c.def}) STORED`;
      else if (c.def) s += ` DEFAULT ${c.def}`;
      if (c.nn) s += ' NOT NULL';
      return s;
    });
    for (const k of cons) lines.push(`  CONSTRAINT ${ident(k.n, 'postgres')} ${k.d}`);
    const kind = rel.relkind === 'f' ? 'FOREIGN TABLE' : rel.persistence === 'u' ? 'UNLOGGED TABLE' : 'TABLE';
    let sql = `CREATE ${kind} ${name} (\n${lines.join(',\n')}\n)${rel.part ? `\nPARTITION BY ${rel.part}` : ''};\n`;
    for (const i of idx) sql += `\n${i.d};`;
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    if (rel.comment) sql += `\n\nCOMMENT ON TABLE ${name} IS ${q(rel.comment)};`;
    for (const c of cols) if (c.comment) sql += `\nCOMMENT ON COLUMN ${name}.${ident(c.n, 'postgres')} IS ${q(c.comment)};`;
    return sql.trimEnd();
  }

  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((p) => p.then((c) => c.end()).catch(() => {})));
  }
}

export const postgresProvider: IDataSourceProvider = {
  id: 'postgres',
  displayName: 'PostgreSQL',
  capabilities: CAPS,
  defaultPort: 5432,
  async connect(cfg) {
    const c = new PgConnection(cfg);
    try {
      await c.init();
    } catch (e) {
      await c.close();
      throw e;
    }
    return c;
  },
};
