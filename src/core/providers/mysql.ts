// MySQL / MariaDB sağlayıcısı (mysql2, MIT).
// - Satırlar akışla okunur; sınıra ulaşınca ya da iptal edilince sunucuda KILL QUERY gönderilir.
// - Tarih ve büyük sayılar metin olarak alınır (saat dilimi/precision kaybı yok).
// - Salt okunur kip: SET SESSION TRANSACTION READ ONLY.
import mysql, { type Connection, type ConnectionOptions, type FieldPacket } from 'mysql2';
import type {
  Capabilities, Cell, ColumnMeta, CompletionSchema, ConnectionConfig, IDataSourceConnection, IDataSourceProvider,
  NodePath, QueryOptions, ServerInfo, StatementEvent, TreeNode,
} from '../provider';
import { toCell } from '../values';
import { quoteIdent } from '../sql/dialect';

const CAPS: Capabilities = {
  dialect: 'mysql', kind: 'server', databases: true, schemas: false, materializedViews: false, functions: true,
  procedures: true, triggers: true, sequences: false, types: false, indexes: true, cancel: 'native', readOnly: 'session',
};

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const TYPE_NAMES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint', 9: 'mediumint',
  10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 14: 'date', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 247: 'enum',
  248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry',
};
const NUMERIC_CODES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);
const NUMERIC_TYPES = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year|bit)/i;
const qi = (s: string) => quoteIdent(s, 'mysql');

const isNoSsl = (e: unknown) => /does not support secure|SSL connection error|HANDSHAKE_NO_SSL_SUPPORT/i.test(String((e as Error)?.message ?? '') + String((e as { code?: string })?.code ?? ''));

class MysqlConnection implements IDataSourceConnection {
  readonly capabilities = CAPS;
  private conn!: Connection;
  private currentDb: string | null = null;
  private readOnly: boolean;
  private tls = false;
  private activeThread: number | null = null;

  constructor(private cfg: ConnectionConfig) {
    this.readOnly = cfg.readOnly;
  }

  private options(ssl: ConnectionOptions['ssl'] | undefined): ConnectionOptions {
    return {
      host: this.cfg.host || 'localhost',
      port: this.cfg.port || 3306,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database || undefined,
      ssl,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
      connectTimeout: this.cfg.connectTimeoutMs ?? 15000,
      charset: 'utf8mb4',
    };
  }

  private connectWith(ssl: ConnectionOptions['ssl'] | undefined): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const c = mysql.createConnection(this.options(ssl));
      c.connect((err) => (err ? (c.destroy(), reject(err)) : resolve(c)));
    });
  }

  async open() {
    const mode = this.cfg.ssl?.mode ?? 'prefer';
    const ssl = mode === 'disable' ? undefined : mode === 'verify-full' ? { rejectUnauthorized: true, ca: this.cfg.ssl?.ca || undefined } : { rejectUnauthorized: false };
    try {
      this.conn = await this.connectWith(ssl);
      this.tls = !!ssl;
    } catch (e) {
      if (mode !== 'prefer' || !isNoSsl(e)) throw e;
      this.conn = await this.connectWith(undefined);
      this.tls = false;
    }
    this.conn.on('error', () => {}); // kopma hataları sorgu çağrısında raporlanır
    this.currentDb = this.cfg.database || null;
    if (this.readOnly) await this.exec('SET SESSION TRANSACTION READ ONLY');
  }

  private exec<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => this.conn.query({ sql }, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))));
  }

  private async use(db?: string) {
    if (db && db !== this.currentDb) {
      await this.exec(`USE ${qi(db)}`);
      this.currentDb = db;
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.exec<{ v: string; db: string | null; u: string }>('select version() v, database() db, current_user() u');
    const product = /mariadb/i.test(r.v) ? `MariaDB ${r.v.replace(/-MariaDB.*/i, '')}` : `MySQL ${r.v}`;
    return { product, version: r.v, database: r.db ?? undefined, user: r.u, tls: this.tls };
  }

  async setReadOnly(on: boolean): Promise<void> {
    this.readOnly = on;
    await this.exec(on ? 'SET SESSION TRANSACTION READ ONLY' : 'SET SESSION TRANSACTION READ WRITE');
  }

  async useDatabase(db: string) {
    await this.use(db);
  }

  async *query(sql: string, opts: QueryOptions): AsyncIterable<StatementEvent> {
    await this.use(opts.database);
    const threadId = this.conn.threadId;
    this.activeThread = threadId;
    const q = this.conn.query({ sql, rowsAsArray: true });
    let fields: FieldPacket[] | null = null;
    q.on('fields', (f: FieldPacket[]) => { if (!fields) fields = f; });
    const stream = q.stream({ highWaterMark: opts.batchSize });
    const limit = opts.limit > 0 ? opts.limit : Infinity;
    let total = 0;
    let batch: Cell[][] = [];
    let announced = false;
    let killed = false;
    let bigCols: boolean[] | undefined;
    try {
      for await (const item of stream as AsyncIterable<unknown>) {
        if (killed) continue;
        if (!Array.isArray(item)) {
          // DML/DDL sonucu (ResultSetHeader)
          const h = item as { affectedRows?: number };
          const cmd = (sql.trim().match(/^\w+/)?.[0] ?? 'OK').toUpperCase();
          if (!announced) yield { type: 'command', command: cmd, rowsAffected: /^(INSERT|UPDATE|DELETE|REPLACE|LOAD)$/.test(cmd) ? h.affectedRows ?? null : null };
          announced = true;
          continue;
        }
        if (!announced) {
          announced = true;
          const fs = (fields ?? []) as FieldPacket[];
          yield { type: 'columns', columns: fs.map((f) => ({ name: f.name, type: TYPE_NAMES[f.columnType ?? -1] ?? String(f.columnType), numeric: NUMERIC_CODES.has(f.columnType ?? -1) })) };
        }
        if (total >= limit || opts.signal.aborted) {
          killed = true;
          await this.kill(threadId);
          continue;
        }
        // BIGINT metin gelir (bigNumberStrings); güvenli aralıktaysa sayıya çevir. DECIMAL metin kalır.
        const big = bigCols ??= ((fields ?? []) as FieldPacket[]).map((f) => f.columnType === 8);
        batch.push((item as unknown[]).map((v, i) => (big[i] && typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : toCell(v))));
        total++;
        if (batch.length >= opts.batchSize) {
          yield { type: 'rows', rows: batch };
          batch = [];
        }
      }
    } catch (e) {
      if (!killed) throw e; // KILL QUERY sonrası "Query execution was interrupted" beklenen hata
    } finally {
      this.activeThread = null;
    }
    if (!announced && fields) {
      const fs = fields as FieldPacket[];
      yield { type: 'columns', columns: fs.map((f) => ({ name: f.name, type: TYPE_NAMES[f.columnType ?? -1] ?? String(f.columnType), numeric: NUMERIC_CODES.has(f.columnType ?? -1) })) };
      announced = true;
    }
    if (!announced) { yield { type: 'command', command: (sql.trim().match(/^\w+/)?.[0] ?? 'OK').toUpperCase(), rowsAffected: null }; return; }
    if (batch.length) yield { type: 'rows', rows: batch };
    if (fields) yield { type: 'end', rowCount: total, truncated: killed && !opts.signal.aborted };
  }

  /** Ayrı bir bağlantıdan sunucudaki sorguyu durdurur */
  private async kill(threadId: number) {
    const c = await this.connectWith(this.tls ? { rejectUnauthorized: false } : undefined).catch(() => null);
    if (!c) return;
    await new Promise<void>((resolve) => c.query(`KILL QUERY ${Number(threadId)}`, () => resolve()));
    c.end();
  }

  async cancel(): Promise<void> {
    if (this.activeThread !== null) await this.kill(this.activeThread);
  }

  // --- Ağaç -----------------------------------------------------------------------
  async getChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const rows = await this.exec<{ Database: string }>('SHOW DATABASES');
      const dbs = rows.map((r) => r.Database).filter((d) => !SYSTEM_DBS.has(d.toLowerCase()));
      dbs.sort((a, b) => (a === this.cfg.database ? -1 : b === this.cfg.database ? 1 : a.localeCompare(b)));
      return dbs.map((d) => ({ id: `db:${d}`, kind: 'database', name: d, hasChildren: true, path: { database: d } }));
    }
    const p = parent.path;
    const db = p.database!;
    if (parent.kind === 'database') {
      const [c] = await this.exec<Record<string, number>>(
        `select
          (select count(*) from information_schema.tables where table_schema = ? and table_type = 'BASE TABLE') tables,
          (select count(*) from information_schema.tables where table_schema = ? and table_type = 'VIEW') views,
          (select count(*) from information_schema.routines where routine_schema = ? and routine_type = 'FUNCTION') functions,
          (select count(*) from information_schema.routines where routine_schema = ? and routine_type = 'PROCEDURE') procedures,
          (select count(*) from information_schema.triggers where trigger_schema = ?) triggers`, [db, db, db, db, db]);
      return (['tables', 'views', 'functions', 'procedures', 'triggers'] as const).map((f) => ({
        id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, count: Number(c?.[f] ?? 0), hasChildren: Number(c?.[f] ?? 0) > 0, path: { database: db, folder: f },
      }));
    }
    if (parent.kind === 'folder' && !p.table) {
      const mk = (kind: TreeNode['kind'], name: string, extra: Partial<TreeNode> = {}): TreeNode => ({
        id: `${parent.id}/${kind}:${name}`, kind, name, hasChildren: false, path: { database: db, name, ...(extra.path ?? {}) }, ...extra,
      });
      if (p.folder === 'tables' || p.folder === 'views') {
        const rows = await this.exec<{ n: string; r: number | null }>(
          `select table_name n, table_rows r from information_schema.tables where table_schema = ? and table_type = ? order by table_name`, [db, p.folder === 'tables' ? 'BASE TABLE' : 'VIEW']);
        const kind = p.folder === 'tables' ? 'table' : 'view';
        return rows.map((r) => mk(kind, r.n, { hasChildren: true, openAs: 'data', detail: kind === 'table' && r.r != null ? `~${Number(r.r).toLocaleString('tr-TR')}` : undefined }));
      }
      if (p.folder === 'functions' || p.folder === 'procedures') {
        const rows = await this.exec<{ n: string }>(`select routine_name n from information_schema.routines where routine_schema = ? and routine_type = ? order by routine_name`, [db, p.folder === 'functions' ? 'FUNCTION' : 'PROCEDURE']);
        return rows.map((r) => mk(p.folder === 'functions' ? 'function' : 'procedure', r.n, { openAs: 'code' }));
      }
      if (p.folder === 'triggers') {
        const rows = await this.exec<{ n: string; t: string }>(`select trigger_name n, event_object_table t from information_schema.triggers where trigger_schema = ? order by trigger_name`, [db]);
        return rows.map((r) => mk('trigger', r.n, { openAs: 'code', detail: r.t, path: { database: db, name: r.n, table: r.t } }));
      }
      return [];
    }
    if (parent.kind === 'table' || parent.kind === 'view') {
      const folders = parent.kind === 'table' ? ['columns', 'indexes', 'triggers'] : ['columns'];
      return folders.map((f) => ({ id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, hasChildren: true, path: { database: db, table: p.name, folder: f } }));
    }
    if (parent.kind === 'folder' && p.table) {
      if (p.folder === 'columns') {
        const rows = await this.exec<{ n: string; t: string; nul: string; k: string }>(
          `select column_name n, column_type t, is_nullable nul, column_key k from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`, [db, p.table]);
        return rows.map((r) => ({ id: `${parent.id}/c:${r.n}`, kind: 'column', name: r.n, detail: `${r.t}${r.nul === 'NO' ? ' NOT NULL' : ''}${r.k === 'PRI' ? ' · PK' : ''}`, hasChildren: false, path: { database: db, table: p.table, name: r.n } }));
      }
      if (p.folder === 'indexes') {
        const rows = await this.exec<{ n: string; u: number }>(`select index_name n, min(non_unique) u from information_schema.statistics where table_schema = ? and table_name = ? group by index_name order by index_name`, [db, p.table]);
        return rows.map((r) => ({ id: `${parent.id}/i:${r.n}`, kind: 'index', name: r.n, detail: r.n === 'PRIMARY' ? 'PRIMARY' : Number(r.u) === 0 ? 'UNIQUE' : undefined, hasChildren: false, openAs: 'code', path: { database: db, table: p.table, name: r.n } }));
      }
      const rows = await this.exec<{ n: string }>(`select trigger_name n from information_schema.triggers where trigger_schema = ? and event_object_table = ? order by trigger_name`, [db, p.table]);
      return rows.map((r) => ({ id: `${parent.id}/tr:${r.n}`, kind: 'trigger', name: r.n, hasChildren: false, openAs: 'code', path: { database: db, table: p.table, name: r.n } }));
    }
    return [];
  }

  async getObjectDdl(node: TreeNode): Promise<string> {
    const p = node.path;
    const full = `${qi(p.database!)}.${qi(p.name ?? node.name)}`;
    const show = async (what: string, col: string) => {
      const [r] = await this.exec<Record<string, string>>(`SHOW CREATE ${what} ${full}`);
      return r ? `${r[col]};` : '';
    };
    switch (node.kind) {
      case 'table': return show('TABLE', 'Create Table');
      case 'view': return show('VIEW', 'Create View');
      case 'function': return show('FUNCTION', 'Create Function');
      case 'procedure': return show('PROCEDURE', 'Create Procedure');
      case 'trigger': return show('TRIGGER', 'SQL Original Statement');
      case 'index': {
        const cols = await this.exec<{ c: string; u: number; sub: number | null }>(
          `select column_name c, non_unique u, sub_part sub from information_schema.statistics where table_schema = ? and table_name = ? and index_name = ? order by seq_in_index`, [p.database, p.table, p.name]);
        if (!cols.length) return '';
        const list = cols.map((c) => `${qi(c.c)}${c.sub ? `(${c.sub})` : ''}`).join(', ');
        if (p.name === 'PRIMARY') return `ALTER TABLE ${qi(p.database!)}.${qi(p.table!)} ADD PRIMARY KEY (${list});`;
        return `CREATE ${Number(cols[0].u) === 0 ? 'UNIQUE ' : ''}INDEX ${qi(p.name!)} ON ${qi(p.database!)}.${qi(p.table!)} (${list});`;
      }
      default: return '';
    }
  }

  async getColumns(p: NodePath): Promise<ColumnMeta[]> {
    const rows = await this.exec<{ n: string; t: string; dt: string }>(
      `select column_name n, column_type t, data_type dt from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`, [p.database ?? this.currentDb, p.table ?? p.name]);
    return rows.map((r) => ({ name: r.n, type: r.t, numeric: NUMERIC_TYPES.test(r.dt) }));
  }

  async getCompletionSchema(database?: string): Promise<CompletionSchema> {
    const rows = await this.exec<{ s: string; t: string; c: string }>(
      `select table_schema s, table_name t, column_name c from information_schema.columns
       where table_schema not in ('information_schema','mysql','performance_schema','sys') order by table_schema, table_name, ordinal_position limit 50000`);
    const tables: CompletionSchema['tables'] = {};
    for (const r of rows) ((tables[r.s] ??= {})[r.t] ??= []).push(r.c);
    return { tables, defaultSchema: database ?? this.currentDb ?? undefined };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.conn.end(() => resolve()));
  }
}

export const mysqlProvider: IDataSourceProvider = {
  id: 'mysql',
  displayName: 'MySQL / MariaDB',
  capabilities: CAPS,
  defaultPort: 3306,
  async connect(cfg) {
    const c = new MysqlConnection(cfg);
    await c.open();
    return c;
  },
};
