// SQL Server sağlayıcısı (mssql + tedious, MIT).
// - Betik "GO" ile partilere bölünür; bir parti birden çok sonuç kümesi döndürebilir.
// - Satırlar akışla gelir; sınıra ulaşınca ya da iptalde istek sunucuda iptal edilir (attention).
// - SQL Server'da oturum düzeyinde salt okunur kip yok: koruma sınıflandırıcıyla yapılır.
import sql from 'mssql';
import type {
  Capabilities, Cell, ColumnMeta, CompletionSchema, ConnectionConfig, IDataSourceConnection, IDataSourceProvider,
  NodePath, QueryOptions, ServerInfo, StatementEvent, TreeNode,
} from '../provider';
import { toCell } from '../values';
import { quoteIdent } from '../sql/dialect';

const CAPS: Capabilities = {
  dialect: 'mssql', kind: 'server', databases: true, schemas: true, materializedViews: false, functions: true,
  procedures: true, triggers: true, sequences: true, types: true, indexes: true, cancel: 'native', readOnly: 'classifier',
};

const NUMERIC = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney|bit)/i;
const qi = (s: string) => quoteIdent(s, 'mssql');
const nlit = (s: string) => `N'${s.replace(/'/g, "''")}'`;

interface MsColumn { name: string; type?: { declaration?: string; name?: string }; length?: number; precision?: number; scale?: number }

function typeName(c: MsColumn): string {
  const base = (c.type?.declaration ?? c.type?.name ?? 'sql_variant').toLowerCase();
  if (/char|binary/.test(base) && c.length) return `${base}(${c.length > 8000 || c.length < 0 ? 'max' : c.length})`;
  if (/decimal|numeric/.test(base) && c.precision) return `${base}(${c.precision},${c.scale ?? 0})`;
  return base;
}

class MssqlConnection implements IDataSourceConnection {
  readonly capabilities = CAPS;
  private pool!: sql.ConnectionPool;
  private currentDb: string | null = null;
  private active: sql.Request | null = null;
  private encrypted = false;

  constructor(private cfg: ConnectionConfig) {}

  async open() {
    const mode = this.cfg.ssl?.mode ?? 'prefer';
    this.pool = new sql.ConnectionPool({
      server: this.cfg.host || 'localhost',
      port: this.cfg.port || 1433,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database || undefined,
      connectionTimeout: this.cfg.connectTimeoutMs ?? 15000,
      requestTimeout: 0,
      // Oturum durumu (USE, SET, geçici tablolar) korunsun diye tek bağlantı
      pool: { max: 1, min: 1, idleTimeoutMillis: 2_147_483_647 },
      options: {
        encrypt: mode !== 'disable',
        trustServerCertificate: mode !== 'verify-full',
        appName: this.cfg.appName || 'SQL Master',
        useUTC: true,
        enableArithAbort: true,
      },
      arrayRowMode: true,
    } as sql.config);
    this.pool.on('error', () => {});
    await this.pool.connect();
    this.encrypted = mode !== 'disable';
    const [r] = await this.q<{ db: string }>('select db_name() db');
    this.currentDb = r?.db ?? null;
  }

  private async q<T = Record<string, unknown>>(text: string): Promise<T[]> {
    const req = this.pool.request();
    (req as unknown as { arrayRowMode: boolean }).arrayRowMode = false;
    const r = await req.query(text);
    return r.recordset as unknown as T[];
  }

  private async use(db?: string) {
    if (db && db !== this.currentDb) {
      await this.q(`USE ${qi(db)}`);
      this.currentDb = db;
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.q<{ v: string; ver: string; db: string; u: string; ed: string }>(
      `select cast(serverproperty('ProductVersion') as nvarchar(64)) v, @@version ver, db_name() db, suser_sname() u, cast(serverproperty('Edition') as nvarchar(128)) ed`);
    let tls = this.encrypted;
    try {
      const [e] = await this.q<{ enc: string }>('select encrypt_option enc from sys.dm_exec_connections where session_id = @@spid');
      if (e) tls = String(e.enc).toUpperCase() === 'TRUE';
    } catch { /* yetki yok */ }
    const year = (/Microsoft SQL Server (\d{4})/.exec(r.ver) ?? [])[1];
    return { product: `SQL Server ${year ?? ''} ${r.v}`.replace(/\s+/g, ' ').trim(), version: r.v, database: r.db, user: r.u, tls };
  }

  async setReadOnly(): Promise<void> {
    /* oturum düzeyinde desteklenmiyor; sınıflandırıcı korur */
  }

  async useDatabase(db: string) {
    await this.use(db);
  }

  async *query(text: string, opts: QueryOptions): AsyncIterable<StatementEvent> {
    await this.use(opts.database);
    const req = this.pool.request();
    req.stream = true;
    (req as unknown as { arrayRowMode: boolean }).arrayRowMode = true;
    this.active = req;

    // Olayları kuyruğa alıp tüketici hızında ilerle (geri basınç: pause/resume)
    type Item = StatementEvent | { type: 'error'; error: unknown } | { type: 'done' };
    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    const push = (it: Item) => { queue.push(it); wake?.(); wake = null; };
    const limit = opts.limit > 0 ? opts.limit : Infinity;
    let setRows = 0;
    let batch: Cell[][] = [];
    let cancelledForLimit = false;
    let inResult = false;
    let resultSets = 0;

    const flush = () => { if (batch.length) { push({ type: 'rows', rows: batch }); batch = []; } };
    req.on('recordset', (cols: Record<string, MsColumn> | MsColumn[]) => {
      if (inResult) { flush(); push({ type: 'end', rowCount: setRows, truncated: false }); }
      const list = (Array.isArray(cols) ? cols : Object.values(cols)) as MsColumn[];
      inResult = true;
      lastWasResult = true;
      resultSets++;
      setRows = 0;
      push({ type: 'columns', columns: list.map((c): ColumnMeta => ({ name: c.name, type: typeName(c), numeric: NUMERIC.test(typeName(c)) })) });
    });
    req.on('row', (row: unknown[]) => {
      if (cancelledForLimit) return;
      if (setRows >= limit) {
        cancelledForLimit = true;
        req.cancel();
        return;
      }
      batch.push(row.map(toCell));
      setRows++;
      if (batch.length >= opts.batchSize) {
        flush();
        if (queue.length > 4) req.pause();
      }
    });
    req.on('info', (m: { message: string }) => push({ type: 'notice', message: m.message }));
    // Her ifade bitişinde (DONE) etkilenen satır sayısı gelir; SELECT'in kendi sayısını komut sanma
    let lastWasResult = false;
    req.on('rowsaffected', (n: number) => {
      if (lastWasResult) { lastWasResult = false; return; }
      if (inResult) { flush(); push({ type: 'end', rowCount: setRows, truncated: false }); inResult = false; }
      push({ type: 'command', command: 'ROWS', rowsAffected: n });
    });
    req.on('error', (e: unknown) => push({ type: 'error', error: e }));
    req.on('done', () => push({ type: 'done' }));
    req.query(text);

    let sawCommand = false;
    try {
      for (;;) {
        if (!queue.length) {
          if ((req as unknown as { _paused?: boolean })._paused !== false) req.resume();
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        const it = queue.shift()!;
        if (it.type === 'error') {
          const err = it.error as { code?: string };
          if (cancelledForLimit || opts.signal.aborted || err.code === 'ECANCEL') continue;
          throw it.error;
        }
        if (it.type === 'done') break;
        if (it.type === 'command') sawCommand = true;
        yield it;
        if (queue.length < 2) req.resume();
      }
    } finally {
      this.active = null;
    }
    flush();
    while (queue.length) {
      const it = queue.shift()!;
      if (it.type !== 'error' && it.type !== 'done') yield it;
    }
    if (inResult) yield { type: 'end', rowCount: setRows, truncated: cancelledForLimit };
    else if (!sawCommand && !resultSets) yield { type: 'command', command: (text.trim().match(/^\w+/)?.[0] ?? 'OK').toUpperCase(), rowsAffected: null };
  }

  async cancel(): Promise<void> {
    this.active?.cancel();
  }

  // --- Ağaç -----------------------------------------------------------------------
  async getChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const rows = await this.q<{ name: string }>(`select name from sys.databases where state = 0 and has_dbaccess(name) = 1 order by case when database_id <= 4 then 1 else 0 end, name`);
      rows.sort((a, b) => (a.name === this.cfg.database ? -1 : b.name === this.cfg.database ? 1 : 0));
      return rows.map((r) => ({ id: `db:${r.name}`, kind: 'database', name: r.name, hasChildren: true, path: { database: r.name } }));
    }
    const p = parent.path;
    const db = p.database!;
    const D = qi(db);
    if (parent.kind === 'database') {
      const rows = await this.q<{ name: string }>(
        `select s.name from ${D}.sys.schemas s where s.name not in ('sys','INFORMATION_SCHEMA','guest') and s.name not like 'db[_]%'
         and (s.name = 'dbo' or exists (select 1 from ${D}.sys.objects o where o.schema_id = s.schema_id)) order by case when s.name = 'dbo' then 0 else 1 end, s.name`);
      return rows.map((r) => ({ id: `${parent.id}/s:${r.name}`, kind: 'schema', name: r.name, hasChildren: true, path: { database: db, schema: r.name } }));
    }
    const S = nlit(p.schema ?? 'dbo');
    if (parent.kind === 'schema') {
      // Üç parçalı adlarla: geçerli veritabanından bağımsız
      const [counts] = await this.q<Record<string, number>>(
        `select
          sum(case when o.type = 'U' then 1 else 0 end) tables, sum(case when o.type = 'V' then 1 else 0 end) views,
          sum(case when o.type in ('FN','IF','TF','FS','FT') then 1 else 0 end) functions, sum(case when o.type in ('P','PC') then 1 else 0 end) procedures,
          sum(case when o.type = 'TR' then 1 else 0 end) triggers, sum(case when o.type = 'SO' then 1 else 0 end) sequences,
          (select count(*) from ${D}.sys.types t join ${D}.sys.schemas ts on ts.schema_id = t.schema_id where t.is_user_defined = 1 and ts.name = ${S}) types
         from ${D}.sys.objects o join ${D}.sys.schemas s on s.schema_id = o.schema_id where s.name = ${S} and o.is_ms_shipped = 0`);
      return (['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences', 'types'] as const).map((f) => ({
        id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, count: Number(counts?.[f] ?? 0), hasChildren: Number(counts?.[f] ?? 0) > 0, path: { database: db, schema: p.schema, folder: f },
      }));
    }
    const objs = (types: string, extra = '') =>
      this.q<{ name: string; id: number; parent: string | null; rows: number | null }>(
        `select o.name, o.object_id id, object_name(o.parent_object_id, db_id(${nlit(db)})) parent,
           (select sum(p.rows) from ${D}.sys.partitions p where p.object_id = o.object_id and p.index_id in (0,1)) rows
         from ${D}.sys.objects o join ${D}.sys.schemas s on s.schema_id = o.schema_id
         where s.name = ${S} and o.type in (${types}) and o.is_ms_shipped = 0 ${extra} order by o.name`);
    if (parent.kind === 'folder' && !p.table) {
      const mk = (kind: TreeNode['kind'], name: string, extra: Partial<TreeNode> = {}): TreeNode => ({
        id: `${parent.id}/${kind}:${name}`, kind, name, hasChildren: false, path: { database: db, schema: p.schema, name, ...(extra.path ?? {}) }, ...extra,
      });
      switch (p.folder) {
        case 'tables': return (await objs("'U'")).map((r) => mk('table', r.name, { hasChildren: true, openAs: 'data', detail: r.rows != null ? `~${Number(r.rows).toLocaleString('tr-TR')}` : undefined }));
        case 'views': return (await objs("'V'")).map((r) => mk('view', r.name, { hasChildren: true, openAs: 'data' }));
        case 'functions': return (await objs("'FN','IF','TF','FS','FT'")).map((r) => mk('function', r.name, { openAs: 'code' }));
        case 'procedures': return (await objs("'P','PC'")).map((r) => mk('procedure', r.name, { openAs: 'code' }));
        case 'triggers': return (await objs("'TR'")).map((r) => mk('trigger', r.name, { openAs: 'code', detail: r.parent ?? undefined, path: { database: db, schema: p.schema, name: r.name, table: r.parent ?? undefined } }));
        case 'sequences': return (await objs("'SO'")).map((r) => mk('sequence', r.name, { openAs: 'code' }));
        case 'types': {
          const rows = await this.q<{ name: string; base: string }>(
            `select t.name, type_name(t.system_type_id) base from ${D}.sys.types t join ${D}.sys.schemas s on s.schema_id = t.schema_id where t.is_user_defined = 1 and s.name = ${S} order by t.name`);
          return rows.map((r) => mk('type', r.name, { openAs: 'code', detail: r.base }));
        }
      }
      return [];
    }
    if (parent.kind === 'table' || parent.kind === 'view') {
      const folders = parent.kind === 'table' ? ['columns', 'indexes', 'triggers'] : ['columns', 'triggers'];
      return folders.map((f) => ({ id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, hasChildren: true, path: { database: db, schema: p.schema, table: p.name, folder: f } }));
    }
    if (parent.kind === 'folder' && p.table) {
      const T = nlit(p.table);
      const objId = `(select o.object_id from ${D}.sys.objects o join ${D}.sys.schemas s on s.schema_id = o.schema_id where s.name = ${S} and o.name = ${T})`;
      if (p.folder === 'columns') {
        const cols = await this.columnRows(db, p.schema ?? 'dbo', p.table);
        return cols.map((c) => ({ id: `${parent.id}/c:${c.name}`, kind: 'column', name: c.name, detail: `${c.type}${c.nullable ? '' : ' NOT NULL'}${c.pk ? ' · PK' : ''}`, hasChildren: false, path: { database: db, schema: p.schema, table: p.table, name: c.name } }));
      }
      if (p.folder === 'indexes') {
        const rows = await this.q<{ name: string; pk: boolean; uq: boolean; type: string }>(
          `select i.name, i.is_primary_key pk, i.is_unique uq, i.type_desc type from ${D}.sys.indexes i where i.object_id = ${objId} and i.name is not null order by i.name`);
        return rows.map((r) => ({ id: `${parent.id}/i:${r.name}`, kind: 'index', name: r.name, detail: r.pk ? 'PRIMARY KEY' : r.uq ? 'UNIQUE' : r.type.toLowerCase(), hasChildren: false, openAs: 'code', path: { database: db, schema: p.schema, table: p.table, name: r.name } }));
      }
      const rows = await this.q<{ name: string }>(`select t.name from ${D}.sys.triggers t where t.parent_id = ${objId} order by t.name`);
      return rows.map((r) => ({ id: `${parent.id}/tr:${r.name}`, kind: 'trigger', name: r.name, hasChildren: false, openAs: 'code', path: { database: db, schema: p.schema, table: p.table, name: r.name } }));
    }
    return [];
  }

  private columnRows(db: string, schema: string, table: string) {
    const D = qi(db);
    return this.q<{ name: string; type: string; nullable: boolean; pk: boolean; identity: boolean; def: string | null; computed: string | null; cat: string }>(
      `select c.name,
         case when t.name in ('varchar','char','varbinary','binary') then t.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length as varchar(10)) end + ')'
              when t.name in ('nvarchar','nchar') then t.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length / 2 as varchar(10)) end + ')'
              when t.name in ('decimal','numeric') then t.name + '(' + cast(c.precision as varchar(5)) + ',' + cast(c.scale as varchar(5)) + ')'
              when t.name in ('datetime2','time','datetimeoffset') then t.name + '(' + cast(c.scale as varchar(5)) + ')'
              else t.name end type,
         c.is_nullable nullable, c.is_identity [identity], dc.definition def, cc.definition computed, t.name cat,
         case when exists (select 1 from ${D}.sys.index_columns ic join ${D}.sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
                           where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id) then 1 else 0 end pk
       from ${D}.sys.columns c
       join ${D}.sys.types t on t.user_type_id = c.user_type_id
       join ${D}.sys.objects o on o.object_id = c.object_id
       join ${D}.sys.schemas s on s.schema_id = o.schema_id
       left join ${D}.sys.default_constraints dc on dc.object_id = c.default_object_id
       left join ${D}.sys.computed_columns cc on cc.object_id = c.object_id and cc.column_id = c.column_id
       where s.name = ${nlit(schema)} and o.name = ${nlit(table)} order by c.column_id`);
  }

  async getObjectDdl(node: TreeNode): Promise<string> {
    const p = node.path;
    const D = qi(p.database!);
    const full = `${qi(p.schema ?? 'dbo')}.${qi(p.name ?? node.name)}`;
    const objId = `(select o.object_id from ${D}.sys.objects o join ${D}.sys.schemas s on s.schema_id = o.schema_id where s.name = ${nlit(p.schema ?? 'dbo')} and o.name = ${nlit(p.name ?? node.name)})`;
    switch (node.kind) {
      case 'view':
      case 'function':
      case 'procedure':
      case 'trigger': {
        const [r] = await this.q<{ d: string | null }>(`select m.definition d from ${D}.sys.sql_modules m where m.object_id = ${objId}`);
        return r?.d ? r.d.trim() + '\nGO' : '-- Tanım şifreli ya da erişilemiyor (WITH ENCRYPTION)';
      }
      case 'sequence': {
        const [s] = await this.q<Record<string, string | boolean>>(
          `select type_name(system_type_id) t, cast(start_value as nvarchar(64)) st, cast(increment as nvarchar(64)) inc, cast(minimum_value as nvarchar(64)) mn,
             cast(maximum_value as nvarchar(64)) mx, is_cycling cyc, cast(current_value as nvarchar(64)) cur from ${D}.sys.sequences where object_id = ${objId}`);
        return s ? `CREATE SEQUENCE ${full}\n  AS ${s.t}\n  START WITH ${s.st}\n  INCREMENT BY ${s.inc}\n  MINVALUE ${s.mn}\n  MAXVALUE ${s.mx}${s.cyc ? '\n  CYCLE' : ''};\n\n-- current_value: ${s.cur}` : '';
      }
      case 'type': {
        const [t] = await this.q<{ base: string; len: number; prec: number; scale: number; nul: boolean }>(
          `select type_name(t.system_type_id) base, t.max_length len, t.precision prec, t.scale scale, t.is_nullable nul from ${D}.sys.types t join ${D}.sys.schemas s on s.schema_id = t.schema_id where s.name = ${nlit(p.schema ?? 'dbo')} and t.name = ${nlit(p.name!)}`);
        if (!t) return '';
        const size = /char|binary/.test(t.base) ? `(${t.len === -1 ? 'max' : /^n/.test(t.base) ? t.len / 2 : t.len})` : /decimal|numeric/.test(t.base) ? `(${t.prec},${t.scale})` : '';
        return `CREATE TYPE ${full} FROM ${t.base}${size}${t.nul ? ' NULL' : ' NOT NULL'};`;
      }
      case 'index': {
        const cols = await this.q<{ c: string; desc: boolean; inc: boolean; uq: boolean; pk: boolean; type: string }>(
          `select col.name c, ic.is_descending_key [desc], ic.is_included_column inc, i.is_unique uq, i.is_primary_key pk, i.type_desc type
           from ${D}.sys.indexes i join ${D}.sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
           join ${D}.sys.columns col on col.object_id = ic.object_id and col.column_id = ic.column_id
           where i.object_id = (select o.object_id from ${D}.sys.objects o join ${D}.sys.schemas s on s.schema_id = o.schema_id where s.name = ${nlit(p.schema ?? 'dbo')} and o.name = ${nlit(p.table!)})
             and i.name = ${nlit(p.name!)} order by ic.key_ordinal, ic.index_column_id`);
        if (!cols.length) return '';
        const key = cols.filter((c) => !c.inc).map((c) => `${qi(c.c)}${c.desc ? ' DESC' : ''}`).join(', ');
        const inc = cols.filter((c) => c.inc).map((c) => qi(c.c)).join(', ');
        const tbl = `${qi(p.schema ?? 'dbo')}.${qi(p.table!)}`;
        if (cols[0].pk) return `ALTER TABLE ${tbl} ADD CONSTRAINT ${qi(p.name!)} PRIMARY KEY ${cols[0].type === 'CLUSTERED' ? 'CLUSTERED' : 'NONCLUSTERED'} (${key});`;
        return `CREATE ${cols[0].uq ? 'UNIQUE ' : ''}${cols[0].type === 'CLUSTERED' ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${qi(p.name!)} ON ${tbl} (${key})${inc ? ` INCLUDE (${inc})` : ''};`;
      }
      case 'table':
        return this.tableDdl(p);
      default:
        return '';
    }
  }

  private async tableDdl(p: NodePath): Promise<string> {
    const D = qi(p.database!);
    const schema = p.schema ?? 'dbo';
    const full = `${qi(schema)}.${qi(p.name!)}`;
    const cols = await this.columnRows(p.database!, schema, p.name!);
    const objId = `(select o.object_id from ${D}.sys.objects o join ${D}.sys.schemas s on s.schema_id = o.schema_id where s.name = ${nlit(schema)} and o.name = ${nlit(p.name!)})`;
    const [ident] = await this.q<{ seed: string; inc: string }>(`select cast(seed_value as nvarchar(40)) seed, cast(increment_value as nvarchar(40)) inc from ${D}.sys.identity_columns where object_id = ${objId}`);
    const lines = cols.map((c) => {
      if (c.computed) return `  ${qi(c.name)} AS ${c.computed}`;
      let s = `  ${qi(c.name)} ${c.type}`;
      if (c.identity) s += ` IDENTITY(${ident?.seed ?? 1},${ident?.inc ?? 1})`;
      s += c.nullable ? ' NULL' : ' NOT NULL';
      if (c.def) s += ` DEFAULT ${c.def}`;
      return s;
    });
    const pk = await this.q<{ name: string; c: string; type: string }>(
      `select i.name, col.name c, i.type_desc type from ${D}.sys.indexes i join ${D}.sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
       join ${D}.sys.columns col on col.object_id = ic.object_id and col.column_id = ic.column_id where i.object_id = ${objId} and i.is_primary_key = 1 order by ic.key_ordinal`);
    if (pk.length) lines.push(`  CONSTRAINT ${qi(pk[0].name)} PRIMARY KEY ${pk[0].type === 'CLUSTERED' ? 'CLUSTERED' : 'NONCLUSTERED'} (${pk.map((x) => qi(x.c)).join(', ')})`);
    const fks = await this.q<{ name: string; c: string; rs: string; rt: string; rc: string }>(
      `select fk.name, pc.name c, rs.name rs, rt.name rt, rc.name rc from ${D}.sys.foreign_keys fk
       join ${D}.sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
       join ${D}.sys.columns pc on pc.object_id = fkc.parent_object_id and pc.column_id = fkc.parent_column_id
       join ${D}.sys.objects rt on rt.object_id = fkc.referenced_object_id join ${D}.sys.schemas rs on rs.schema_id = rt.schema_id
       join ${D}.sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
       where fk.parent_object_id = ${objId} order by fk.name, fkc.constraint_column_id`);
    const byFk = new Map<string, typeof fks>();
    for (const f of fks) (byFk.get(f.name) ?? byFk.set(f.name, []).get(f.name)!).push(f);
    for (const [name, list] of byFk) {
      lines.push(`  CONSTRAINT ${qi(name)} FOREIGN KEY (${list.map((x) => qi(x.c)).join(', ')}) REFERENCES ${qi(list[0].rs)}.${qi(list[0].rt)} (${list.map((x) => qi(x.rc)).join(', ')})`);
    }
    let ddl = `CREATE TABLE ${full} (\n${lines.join(',\n')}\n);`;
    const idx = await this.q<{ name: string }>(`select name from ${D}.sys.indexes where object_id = ${objId} and is_primary_key = 0 and name is not null and is_unique_constraint = 0 order by name`);
    for (const i of idx) ddl += '\n\n' + (await this.getObjectDdl({ id: '', kind: 'index', name: i.name, hasChildren: false, path: { database: p.database, schema, table: p.name, name: i.name } }));
    return ddl + '\nGO';
  }

  async getColumns(p: NodePath): Promise<ColumnMeta[]> {
    const rows = await this.columnRows(p.database ?? this.currentDb ?? 'master', p.schema ?? 'dbo', p.table ?? p.name ?? '');
    return rows.map((r) => ({ name: r.name, type: r.type, numeric: NUMERIC.test(r.cat) }));
  }

  async getCompletionSchema(database?: string): Promise<CompletionSchema> {
    const D = qi(database ?? this.currentDb ?? 'master');
    const rows = await this.q<{ s: string; t: string; c: string }>(
      `select top 50000 table_schema s, table_name t, column_name c from ${D}.INFORMATION_SCHEMA.COLUMNS order by table_schema, table_name, ordinal_position`);
    const tables: CompletionSchema['tables'] = {};
    for (const r of rows) ((tables[r.s] ??= {})[r.t] ??= []).push(r.c);
    return { tables, defaultSchema: 'dbo' };
  }

  async close(): Promise<void> {
    await this.pool?.close().catch(() => {});
  }
}

export const mssqlProvider: IDataSourceProvider = {
  id: 'mssql',
  displayName: 'SQL Server',
  capabilities: CAPS,
  defaultPort: 1433,
  async connect(cfg) {
    const c = new MssqlConnection(cfg);
    try {
      await c.open();
    } catch (e) {
      await c.close();
      throw e;
    }
    return c;
  },
};
