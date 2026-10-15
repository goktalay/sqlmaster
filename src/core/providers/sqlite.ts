// SQLite sağlayıcısı: Node/Electron'a gömülü node:sqlite (yerel derleme gerektirmez).
// Salt okunur kip "PRAGMA query_only" ile uygulanır (dosya hiç değiştirilmez); iptal parçalar arasında yapılır.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import type {
  Capabilities, Cell, ColumnMeta, CompletionSchema, ConnectionConfig, IDataSourceConnection, IDataSourceProvider,
  NodePath, QueryOptions, ServerInfo, StatementEvent, TreeNode,
} from '../provider';
import { toCell } from '../values';
import { qualified } from '../sql/dialect';

const CAPS: Capabilities = {
  dialect: 'sqlite', kind: 'file', databases: true, schemas: false, materializedViews: false, functions: false,
  procedures: false, triggers: true, sequences: false, types: false, indexes: true, cancel: 'between-batches', readOnly: 'connection',
};

export const isNumericType = (t: string) => /INT|REAL|FLOA|DOUB|NUM|DEC|BIT|SERIAL|MONEY/i.test(t);

const cell = (v: unknown): Cell => {
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  return toCell(v);
};

const tick = () => new Promise<void>((r) => setImmediate(r));
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

class SqliteConnection implements IDataSourceConnection {
  readonly capabilities = CAPS;
  private db: DatabaseSync;
  private cancelled = false;

  constructor(private cfg: ConnectionConfig) {
    const file = cfg.filePath?.trim() || ':memory:';
    if (file !== ':memory:' && cfg.readOnly && !fs.existsSync(file)) throw new Error(`Dosya bulunamadı: ${file}`);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON');
    if (cfg.readOnly) this.db.exec('PRAGMA query_only = ON');
  }

  private all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = this.all<{ v: string }>('select sqlite_version() v');
    return { product: `SQLite ${r.v}`, version: r.v, database: this.cfg.filePath || ':memory:' };
  }

  async setReadOnly(on: boolean): Promise<void> {
    this.db.exec(`PRAGMA query_only = ${on ? 'ON' : 'OFF'}`);
  }

  async *query(sql: string, opts: QueryOptions): AsyncIterable<StatementEvent> {
    this.cancelled = false;
    let stmt: StatementSync;
    stmt = this.db.prepare(sql);
    const cols = stmt.columns();
    if (!cols.length) {
      const r = stmt.run();
      const cmd = (sql.trim().match(/^\w+/)?.[0] ?? 'OK').toUpperCase();
      yield { type: 'command', command: cmd, rowsAffected: /^(INSERT|UPDATE|DELETE|REPLACE)$/.test(cmd) ? Number(r.changes) : null };
      return;
    }
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    yield { type: 'columns', columns: cols.map((c) => ({ name: c.name, type: c.type ?? '', numeric: isNumericType(c.type ?? '') })) };
    const limit = opts.limit > 0 ? opts.limit : Infinity;
    let total = 0;
    let batch: Cell[][] = [];
    const it = stmt.iterate() as Iterator<unknown[]>;
    for (;;) {
      const n = it.next();
      if (n.done) break;
      if (total >= limit) {
        if (batch.length) yield { type: 'rows', rows: batch };
        it.return?.();
        yield { type: 'end', rowCount: total, truncated: true };
        return;
      }
      batch.push((n.value as unknown[]).map(cell));
      total++;
      if (batch.length >= opts.batchSize) {
        yield { type: 'rows', rows: batch };
        batch = [];
        await tick(); // iptal ve diğer istekler için olay döngüsüne nefes aldır
        if (opts.signal.aborted || this.cancelled) { it.return?.(); break; }
      }
    }
    if (batch.length) yield { type: 'rows', rows: batch };
    yield { type: 'end', rowCount: total, truncated: false };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  // --- Ağaç -----------------------------------------------------------------------
  async getChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const dbs = this.all<{ name: string; file: string }>('PRAGMA database_list').filter((d) => d.name !== 'temp');
      return dbs.map((d) => ({ id: `db:${d.name}`, kind: 'database', name: d.name, detail: d.file || undefined, hasChildren: true, path: { database: d.name, schema: d.name } }));
    }
    const p = parent.path;
    const schema = p.schema ?? 'main';
    const master = `${qualified({ name: schema }, 'sqlite')}.sqlite_master`;
    if (parent.kind === 'database') {
      const counts = this.all<{ type: string; n: number }>(`select type, count(*) n from ${master} where name not like 'sqlite_%' group by type`);
      const c = (t: string) => Number(counts.find((x) => x.type === t)?.n ?? 0);
      return (['tables', 'views', 'triggers', 'indexes'] as const).map((f) => {
        const n = c(f.slice(0, -1).replace('indexe', 'index'));
        return { id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, count: n, hasChildren: n > 0, path: { database: p.database, schema, folder: f } };
      });
    }
    if (parent.kind === 'folder' && !p.table) {
      const type = { tables: 'table', views: 'view', triggers: 'trigger', indexes: 'index' }[p.folder ?? ''] ?? 'table';
      const rows = this.all<{ name: string; tbl: string }>(`select name, tbl_name tbl from ${master} where type = ? and name not like 'sqlite_%' order by name`, type);
      const kind = type as TreeNode['kind'];
      return rows.map((r) => ({
        id: `${parent.id}/${type}:${r.name}`, kind, name: r.name, detail: type === 'trigger' || type === 'index' ? r.tbl : undefined,
        hasChildren: type === 'table' || type === 'view', openAs: type === 'table' || type === 'view' ? 'data' : 'code',
        path: { database: p.database, schema, name: r.name, table: type === 'trigger' || type === 'index' ? r.tbl : undefined },
      }));
    }
    if (parent.kind === 'table' || parent.kind === 'view') {
      const folders = parent.kind === 'table' ? ['columns', 'indexes', 'triggers'] : ['columns'];
      return folders.map((f) => ({ id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, hasChildren: true, path: { database: p.database, schema, table: p.name, folder: f } }));
    }
    if (parent.kind === 'folder' && p.table) {
      const t = q(p.table);
      if (p.folder === 'columns') {
        const rows = this.all<{ name: string; type: string; notnull: number; pk: number }>(`select name, type, "notnull", pk from pragma_table_info(${t}, ${q(schema)})`);
        return rows.map((r) => ({ id: `${parent.id}/c:${r.name}`, kind: 'column', name: r.name, detail: `${r.type || 'ANY'}${r.notnull ? ' NOT NULL' : ''}${r.pk ? ' · PK' : ''}`, hasChildren: false, path: { database: p.database, schema, table: p.table, name: r.name } }));
      }
      const type = p.folder === 'indexes' ? 'index' : 'trigger';
      const rows = this.all<{ name: string }>(`select name from ${master} where type = ? and tbl_name = ? and name not like 'sqlite_%' order by name`, type, p.table);
      return rows.map((r) => ({ id: `${parent.id}/${type}:${r.name}`, kind: type as TreeNode['kind'], name: r.name, hasChildren: false, openAs: 'code', path: { database: p.database, schema, table: p.table, name: r.name } }));
    }
    return [];
  }

  async getObjectDdl(node: TreeNode): Promise<string> {
    const schema = node.path.schema ?? 'main';
    const rows = this.all<{ sql: string | null }>(`select sql from ${qualified({ name: schema }, 'sqlite')}.sqlite_master where name = ?`, node.path.name ?? node.name);
    let ddl = rows[0]?.sql ? rows[0].sql + ';' : '';
    if (node.kind === 'table') {
      const extra = this.all<{ sql: string }>(`select sql from ${qualified({ name: schema }, 'sqlite')}.sqlite_master where tbl_name = ? and type in ('index','trigger') and sql is not null order by type, name`, node.path.name ?? node.name);
      for (const e of extra) ddl += `\n\n${e.sql};`;
    }
    return ddl;
  }

  async getColumns(p: NodePath): Promise<ColumnMeta[]> {
    const rows = this.all<{ name: string; type: string }>(`select name, type from pragma_table_info(${q(p.table ?? p.name ?? '')}, ${q(p.schema ?? 'main')})`);
    return rows.map((r) => ({ name: r.name, type: r.type || 'ANY', numeric: isNumericType(r.type) }));
  }

  async getCompletionSchema(): Promise<CompletionSchema> {
    const tables: CompletionSchema['tables'] = {};
    for (const d of this.all<{ name: string }>('PRAGMA database_list').filter((x) => x.name !== 'temp')) {
      const rows = this.all<{ t: string; c: string }>(
        `select m.name t, p.name c from ${qualified({ name: d.name }, 'sqlite')}.sqlite_master m join pragma_table_info(m.name, ${q(d.name)}) p where m.type in ('table','view') and m.name not like 'sqlite_%' order by m.name, p.cid`);
      for (const r of rows) ((tables[d.name] ??= {})[r.t] ??= []).push(r.c);
    }
    return { tables, defaultSchema: 'main' };
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }
}

export const sqliteProvider: IDataSourceProvider = {
  id: 'sqlite',
  displayName: 'SQLite',
  capabilities: CAPS,
  async connect(cfg) {
    return new SqliteConnection(cfg);
  },
};
