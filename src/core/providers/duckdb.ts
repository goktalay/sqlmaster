// DuckDB sağlayıcısı (@duckdb/node-api, MIT; N-API — Electron için yeniden derleme gerekmez).
// Dosyaları doğrudan sorgular: SELECT * FROM 'satis.csv' JOIN 'urunler.parquet' USING (id);
// read_json_auto('x.json'), read_xlsx('x.xlsx') (excel eklentisi ilk kullanımda otomatik kurulur).
import { DuckDBInstance, JsonDuckDBValueConverter, ResultReturnType, type DuckDBConnection } from '@duckdb/node-api';
import fs from 'node:fs';
import type {
  Capabilities, ColumnMeta, CompletionSchema, ConnectionConfig, IDataSourceConnection, IDataSourceProvider,
  NodePath, QueryOptions, ServerInfo, StatementEvent, TreeNode,
} from '../provider';
import { toCell } from '../values';
import { literal } from '../sql/dialect';

const CAPS: Capabilities = {
  dialect: 'duckdb', kind: 'file', databases: true, schemas: true, materializedViews: false, functions: true,
  procedures: false, triggers: false, sequences: true, types: true, indexes: true, cancel: 'native', readOnly: 'connection', files: true,
};

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL)/i;
const FILE_EXT = /\.(csv|tsv|parquet|json|jsonl|ndjson|xlsx)$/i;
const SYSTEM_DBS = new Set(['system', 'temp']);
const lit = (s: string) => literal(s, 'duckdb');

class DuckConnection implements IDataSourceConnection {
  readonly capabilities = CAPS;
  private instance!: DuckDBInstance;
  private conn!: DuckDBConnection;
  private readOnly: boolean;
  /** Seçilen dosya bir veri dosyasıysa (CSV/Parquet…) bellek içi veritabanında görünüm olarak açılır */
  private dataFile: string | null = null;

  constructor(private cfg: ConnectionConfig) {
    this.readOnly = cfg.readOnly;
  }

  private dbPath(): string {
    const f = this.cfg.filePath?.trim() ?? '';
    if (!f || FILE_EXT.test(f)) return ':memory:';
    return f;
  }

  async open() {
    const path = this.dbPath();
    const f = this.cfg.filePath?.trim() ?? '';
    if (path !== ':memory:' && this.readOnly && !fs.existsSync(path)) throw new Error(`Dosya bulunamadı: ${path}`);
    this.instance = await DuckDBInstance.create(path, {
      access_mode: path !== ':memory:' && this.readOnly ? 'READ_ONLY' : 'AUTOMATIC',
      autoinstall_known_extensions: 'true',
      autoload_known_extensions: 'true',
    });
    this.conn = await this.instance.connect();
    if (f && FILE_EXT.test(f)) {
      this.dataFile = f;
      const name = (f.split(/[\\/]/).pop() ?? 'veri').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'veri';
      const reader = /\.xlsx$/i.test(f) ? `read_xlsx(${lit(f)})` : lit(f);
      await this.conn.run(`CREATE VIEW "${name}" AS SELECT * FROM ${reader}`);
    }
  }

  private async rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const r = await this.conn.runAndReadAll(sql);
    return r.getRowObjectsJson() as unknown as T[];
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.rows<{ v: string }>('select version() v');
    return { product: `DuckDB ${r.v}`, version: r.v, database: this.cfg.filePath || ':memory:' };
  }

  async setReadOnly(on: boolean): Promise<void> {
    // Dosya veritabanında erişim kipi yalnızca açılışta belirlenir: yeniden aç
    if (on === this.readOnly) return;
    this.readOnly = on;
    if (this.dbPath() === ':memory:') return; // bellek içi: sınıflandırıcı korur
    this.conn.closeSync();
    this.instance.closeSync();
    await this.open();
  }

  async *query(sql: string, opts: QueryOptions): AsyncIterable<StatementEvent> {
    const result = await this.conn.stream(sql);
    if (result.returnType !== ResultReturnType.QUERY_RESULT) {
      const cmd = (sql.trim().match(/^\w+/)?.[0] ?? 'OK').toUpperCase();
      yield { type: 'command', command: cmd, rowsAffected: result.returnType === ResultReturnType.CHANGED_ROWS ? Number(result.rowsChanged) : null };
      return;
    }
    const columns: ColumnMeta[] = result.columnNames().map((name, i) => {
      const type = result.columnType(i).toString();
      return { name, type, numeric: NUMERIC.test(type) };
    });
    // DuckDB yalnız sonucu olan sorgularda (SELECT, PRAGMA, DESCRIBE…) kolon verir; CREATE gibi komutlar tek "Count" kolonu döndürebilir
    yield { type: 'columns', columns };
    const limit = opts.limit > 0 ? opts.limit : Infinity;
    let total = 0;
    // BIGINT/HUGEINT JSON'da metin gelir: güvenli aralıktaysa sayıya çevir (DECIMAL metin kalır)
    const bigCols = columns.map((c) => /^(BIGINT|HUGEINT|UBIGINT|UHUGEINT)$/i.test(c.type));
    const conv = (v: unknown, i: number) => {
      if (bigCols[i] && typeof v === 'string' && /^-?\d{1,15}$/.test(v)) return Number(v);
      return toCell(v);
    };
    let pending: ReturnType<typeof toCell>[][] = [];
    for (;;) {
      if (opts.signal.aborted) break;
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      for (const r of chunk.convertRows(JsonDuckDBValueConverter)) {
        if (total >= limit) {
          if (pending.length) yield { type: 'rows', rows: pending };
          yield { type: 'end', rowCount: total, truncated: true };
          return;
        }
        pending.push(r.map(conv));
        total++;
        if (pending.length >= opts.batchSize) {
          yield { type: 'rows', rows: pending };
          pending = [];
        }
      }
    }
    if (pending.length) yield { type: 'rows', rows: pending };
    yield { type: 'end', rowCount: total, truncated: false };
  }

  async cancel(): Promise<void> {
    this.conn.interrupt();
  }

  // --- Ağaç -----------------------------------------------------------------------
  async getChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const dbs = await this.rows<{ database_name: string; path: string | null }>('select database_name, path from duckdb_databases() where not internal order by database_name');
      return dbs.filter((d) => !SYSTEM_DBS.has(d.database_name)).map((d) => ({
        id: `db:${d.database_name}`, kind: 'database', name: d.database_name, detail: d.path ?? (this.dataFile ? this.dataFile : undefined), hasChildren: true, path: { database: d.database_name },
      }));
    }
    const p = parent.path;
    const db = p.database!;
    if (parent.kind === 'database') {
      const rows = await this.rows<{ schema_name: string }>(`select schema_name from duckdb_schemas() where database_name = ${lit(db)} and schema_name not in ('information_schema','pg_catalog') order by schema_name = 'main' desc, schema_name`);
      return rows.map((r) => ({ id: `${parent.id}/s:${r.schema_name}`, kind: 'schema', name: r.schema_name, hasChildren: true, path: { database: db, schema: r.schema_name } }));
    }
    const where = `database_name = ${lit(db)} and schema_name = ${lit(p.schema ?? 'main')}`;
    if (parent.kind === 'schema') {
      const [c] = await this.rows<Record<string, number>>(`select
        (select count(*) from duckdb_tables() where ${where} and not internal) "tables",
        (select count(*) from duckdb_views() where ${where} and not internal) "views",
        (select count(*) from duckdb_functions() where ${where} and not internal and function_type in ('macro','table_macro')) "functions",
        (select count(*) from duckdb_sequences() where ${where}) "sequences",
        (select count(*) from duckdb_types() where ${where} and not internal) "types"`);
      return (['tables', 'views', 'functions', 'sequences', 'types'] as const).map((f) => ({
        id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, count: Number(c?.[f] ?? 0), hasChildren: Number(c?.[f] ?? 0) > 0, path: { database: db, schema: p.schema, folder: f },
      }));
    }
    if (parent.kind === 'folder' && !p.table) {
      const mk = (kind: TreeNode['kind'], name: string, extra: Partial<TreeNode> = {}): TreeNode => ({
        id: `${parent.id}/${kind}:${name}`, kind, name, hasChildren: false, path: { database: db, schema: p.schema, name }, ...extra,
      });
      switch (p.folder) {
        case 'tables': {
          const rows = await this.rows<{ table_name: string; estimated_size: number }>(`select table_name, estimated_size from duckdb_tables() where ${where} and not internal order by table_name`);
          return rows.map((r) => mk('table', r.table_name, { hasChildren: true, openAs: 'data', detail: `~${Number(r.estimated_size).toLocaleString('tr-TR')}` }));
        }
        case 'views': {
          const rows = await this.rows<{ view_name: string }>(`select view_name from duckdb_views() where ${where} and not internal order by view_name`);
          return rows.map((r) => mk('view', r.view_name, { hasChildren: true, openAs: 'data' }));
        }
        case 'functions': {
          const rows = await this.rows<{ function_name: string; parameters: string[] }>(`select distinct function_name, parameters from duckdb_functions() where ${where} and not internal and function_type in ('macro','table_macro') order by function_name`);
          return rows.map((r) => mk('function', r.function_name, { openAs: 'code', detail: `(${(r.parameters ?? []).join(', ')})` }));
        }
        case 'sequences': {
          const rows = await this.rows<{ sequence_name: string }>(`select sequence_name from duckdb_sequences() where ${where} order by sequence_name`);
          return rows.map((r) => mk('sequence', r.sequence_name, { openAs: 'code' }));
        }
        case 'types': {
          const rows = await this.rows<{ type_name: string; logical_type: string }>(`select type_name, logical_type from duckdb_types() where ${where} and not internal order by type_name`);
          return rows.map((r) => mk('type', r.type_name, { openAs: 'code', detail: r.logical_type }));
        }
      }
      return [];
    }
    if (parent.kind === 'table' || parent.kind === 'view') {
      const folders = parent.kind === 'table' ? ['columns', 'indexes'] : ['columns'];
      return folders.map((f) => ({ id: `${parent.id}/f:${f}`, kind: 'folder' as const, name: f, hasChildren: true, path: { database: db, schema: p.schema, table: p.name, folder: f } }));
    }
    if (parent.kind === 'folder' && p.table) {
      if (p.folder === 'columns') {
        const cols = await this.columnRows(db, p.schema ?? 'main', p.table);
        return cols.map((c) => ({ id: `${parent.id}/c:${c.column_name}`, kind: 'column', name: c.column_name, detail: `${c.data_type}${c.is_nullable ? '' : ' NOT NULL'}`, hasChildren: false, path: { database: db, schema: p.schema, table: p.table, name: c.column_name } }));
      }
      const rows = await this.rows<{ index_name: string }>(`select index_name from duckdb_indexes() where ${where} and table_name = ${lit(p.table)} order by index_name`);
      return rows.map((r) => ({ id: `${parent.id}/i:${r.index_name}`, kind: 'index', name: r.index_name, hasChildren: false, openAs: 'code', path: { database: db, schema: p.schema, table: p.table, name: r.index_name } }));
    }
    return [];
  }

  private columnRows(db: string, schema: string, table: string) {
    return this.rows<{ column_name: string; data_type: string; is_nullable: boolean }>(
      `select column_name, data_type, is_nullable from duckdb_columns() where database_name = ${lit(db)} and schema_name = ${lit(schema)} and table_name = ${lit(table)} order by column_index`);
  }

  async getObjectDdl(node: TreeNode): Promise<string> {
    const p = node.path;
    const where = `database_name = ${lit(p.database ?? 'memory')} and schema_name = ${lit(p.schema ?? 'main')}`;
    const one = async (sql: string) => (await this.rows<{ d: string | null }>(sql))[0]?.d ?? '';
    switch (node.kind) {
      case 'table': return one(`select sql d from duckdb_tables() where ${where} and table_name = ${lit(p.name!)}`);
      case 'view': return one(`select sql d from duckdb_views() where ${where} and view_name = ${lit(p.name!)}`);
      case 'index': return one(`select sql d from duckdb_indexes() where ${where} and index_name = ${lit(p.name!)}`);
      case 'sequence': return one(`select sql d from duckdb_sequences() where ${where} and sequence_name = ${lit(p.name!)}`);
      case 'function': {
        const rows = await this.rows<{ parameters: string[]; macro_definition: string; function_type: string }>(
          `select parameters, macro_definition, function_type from duckdb_functions() where ${where} and function_name = ${lit(p.name!)}`);
        return rows.map((r) => `CREATE OR REPLACE MACRO ${p.schema}.${p.name}(${(r.parameters ?? []).join(', ')}) AS ${r.function_type === 'table_macro' ? 'TABLE ' : ''}${r.macro_definition};`).join('\n\n');
      }
      case 'type': return one(`select 'CREATE TYPE ' || type_name || ' AS ' || logical_type || ';' d from duckdb_types() where ${where} and type_name = ${lit(p.name!)}`);
      default: return '';
    }
  }

  async getColumns(p: NodePath): Promise<ColumnMeta[]> {
    const rows = await this.columnRows(p.database ?? 'memory', p.schema ?? 'main', p.table ?? p.name ?? '');
    return rows.map((r) => ({ name: r.column_name, type: r.data_type, numeric: NUMERIC.test(r.data_type) }));
  }

  async getCompletionSchema(): Promise<CompletionSchema> {
    const rows = await this.rows<{ s: string; t: string; c: string }>(
      `select schema_name s, table_name t, column_name c from duckdb_columns() where not internal and database_name not in ('system','temp') order by schema_name, table_name, column_index limit 50000`);
    const tables: CompletionSchema['tables'] = {};
    for (const r of rows) ((tables[r.s] ??= {})[r.t] ??= []).push(r.c);
    return { tables, defaultSchema: 'main' };
  }

  async close(): Promise<void> {
    try { this.conn?.closeSync(); } catch { /* zaten kapalı */ }
    try { this.instance?.closeSync(); } catch { /* zaten kapalı */ }
  }
}

export const duckdbProvider: IDataSourceProvider = {
  id: 'duckdb',
  displayName: 'DuckDB',
  capabilities: CAPS,
  async connect(cfg) {
    const c = new DuckConnection(cfg);
    await c.open();
    return c;
  },
};
