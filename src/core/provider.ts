// Sağlayıcı modeli: arayüz hiçbir veritabanı sürücüsünü doğrudan tanımaz.
// Her sağlayıcı (PostgreSQL, SQL Server, MySQL, SQLite, DuckDB dosyaları…) IDataSourceProvider'ı uygular
// ve registry'ye kaydolur. Bağlantı penceresi yalnızca bu arayüzler ve TreeNode/ExecEvent modelleriyle konuşur.

export type ProviderId = 'postgres' | 'mssql' | 'mysql' | 'sqlite' | 'duckdb';

export type SqlDialect = 'postgres' | 'mssql' | 'mysql' | 'sqlite' | 'duckdb';

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: 'key' | 'password' | 'agent';
  privateKey?: string; // anahtar içeriği (dosya yolundan ana süreç okur)
  passphrase?: string;
  password?: string;
  hostKey?: string | null; // SHA256 parmak izi; ilk bağlantıda kaydedilir
}

/** Çözülmüş (parolası açılmış) bağlantı yapılandırması; yalnızca bellekte yaşar, loglanmaz. */
export interface ConnectionConfig {
  provider: ProviderId;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  filePath?: string; // SQLite / DuckDB veritabanı dosyası (boş = bellek içi)
  ssl?: { mode: SslMode; ca?: string };
  readOnly: boolean;
  options?: Record<string, string | number | boolean>;
  ssh?: SshConfig;
  appName?: string;
  connectTimeoutMs?: number;
}

export interface Capabilities {
  dialect: SqlDialect;
  kind: 'server' | 'file';
  databases: boolean; // sunucu altında birden çok veritabanı listelenir
  schemas: boolean;
  materializedViews: boolean;
  functions: boolean;
  procedures: boolean;
  triggers: boolean;
  sequences: boolean;
  types: boolean;
  indexes: boolean;
  cancel: 'native' | 'between-batches';
  /** Salt okunur modun veritabanı tarafında nasıl uygulandığı (sınıflandırıcı her zaman çalışır). */
  readOnly: 'session' | 'connection' | 'classifier';
  /** Tek sorguda dosya (CSV/Parquet/JSON/Excel) okuyabilir. */
  files?: boolean;
}

export type NodeKind =
  | 'server' | 'database' | 'schema' | 'folder'
  | 'table' | 'view' | 'matview' | 'foreign-table'
  | 'function' | 'procedure' | 'trigger' | 'sequence' | 'type' | 'index'
  | 'column' | 'constraint' | 'file';

/** Ağaçtaki bir nesnenin konumu; sağlayıcılar bu alanlarla nesneyi bulur. */
export interface NodePath {
  database?: string;
  schema?: string;
  /** Klasör düğümlerinde klasörün türü: tables, views, functions… */
  folder?: string;
  /** Tablo/görünüm (kolon, indeks, trigger düğümlerinde üst nesne) */
  table?: string;
  name?: string;
  /** Aynı adlı aşırı yüklenmiş fonksiyonları ayırt etmek için (örn. PG oid ya da imza) */
  objectId?: string;
}

export interface TreeNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Kolon tipi, satır sayısı, imza gibi ikincil bilgi */
  detail?: string;
  hasChildren: boolean;
  path: NodePath;
  /** Çift tıklama davranışı: tablo verisi (ilk 100 kayıt) ya da kod/DDL editörü */
  openAs?: 'data' | 'code';
  /** Klasör düğümlerinde alt öğe sayısı biliniyorsa */
  count?: number;
}

export interface ServerInfo {
  product: string; // "PostgreSQL 16.4"
  version: string;
  database?: string;
  user?: string;
  /** Bağlantı TLS ile şifreli mi (sunucu sağlayıcıları) */
  tls?: boolean;
}

export interface ColumnMeta {
  name: string;
  type: string;
  /** Sayısal kolonlar ızgarada sağa yaslanır, filtrelerde tırnaksız yazılır */
  numeric?: boolean;
}

/** Tek bir ifadenin akışı */
export type StatementEvent =
  | { type: 'columns'; columns: ColumnMeta[] }
  | { type: 'rows'; rows: Cell[][] }
  | { type: 'end'; rowCount: number; truncated: boolean }
  | { type: 'command'; rowsAffected: number | null; command: string }
  | { type: 'notice'; message: string };

/** Hücre değerleri süreçler arası güvenle taşınabilen ilkel tiplere indirgenir. */
export type Cell = string | number | boolean | null;

export interface QueryOptions {
  /** Sorgunun çalışacağı veritabanı (sunucu sağlayıcılarında; boşsa bağlantının varsayılanı) */
  database?: string;
  /** Sonuç kümesi başına en fazla satır (varsayılan 10.000; 0 = sınırsız, dışa aktarımda) */
  limit: number;
  /** Akış parçası boyutu (varsayılan 500) */
  batchSize: number;
  signal: AbortSignal;
}

export interface CompletionSchema {
  /** { şema: { tablo: [kolonlar] } } — CodeMirror sql() ad alanı biçimi */
  tables: Record<string, Record<string, string[]>>;
  defaultSchema?: string;
}

export interface IDataSourceConnection {
  readonly capabilities: Capabilities;
  serverInfo(): Promise<ServerInfo>;
  /** Lazy ağaç: parent null ise kök düğümler */
  getChildren(parent: TreeNode | null): Promise<TreeNode[]>;
  /** Tek bir SQL ifadesini çalıştırır ve sonuçları parça parça verir. */
  query(sql: string, opts: QueryOptions): AsyncIterable<StatementEvent>;
  /** Süren sorguyu iptal eder (sunucu tarafında). */
  cancel(): Promise<void>;
  getObjectDdl(node: TreeNode): Promise<string>;
  /** Tablo/görünüm kolonları (ızgara SQL'i ve sorgu oluşturucu için) */
  getColumns(path: NodePath): Promise<ColumnMeta[]>;
  getCompletionSchema(database?: string): Promise<CompletionSchema>;
  /** Oturumun salt okunur kipini değiştirir (session/connection düzeyi destekleyenler) */
  setReadOnly(on: boolean): Promise<void>;
  /** Etkin veritabanını değiştirir (sunucu sağlayıcıları) */
  useDatabase?(database: string): Promise<void>;
  close(): Promise<void>;
}

export interface IDataSourceProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  readonly defaultPort?: number;
  connect(cfg: ConnectionConfig): Promise<IDataSourceConnection>;
}

export const DEFAULT_LIMIT = 10_000;
export const DEFAULT_BATCH = 500;
