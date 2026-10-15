// Arayüzün bildiği sağlayıcı bilgileri (sürücü yüklemeden). Ayrıntılı yetenekler bağlanınca sağlayıcıdan gelir.
import type { ProviderId, SqlDialect } from '../core/provider';

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  short: string;
  kind: 'server' | 'file';
  dialect: SqlDialect;
  defaultPort?: number;
  defaultUser?: string;
  color: string;
  /** Dosya seçicide gösterilecek uzantılar */
  fileExtensions?: string[];
}

export const PROVIDERS: ProviderMeta[] = [
  { id: 'postgres', name: 'PostgreSQL', short: 'PG', kind: 'server', dialect: 'postgres', defaultPort: 5432, defaultUser: 'postgres', color: '#3b82f6' },
  { id: 'mssql', name: 'SQL Server', short: 'MSSQL', kind: 'server', dialect: 'mssql', defaultPort: 1433, defaultUser: 'sa', color: '#ef4444' },
  { id: 'mysql', name: 'MySQL / MariaDB', short: 'MySQL', kind: 'server', dialect: 'mysql', defaultPort: 3306, defaultUser: 'root', color: '#f97316' },
  { id: 'sqlite', name: 'SQLite', short: 'SQLite', kind: 'file', dialect: 'sqlite', color: '#22d3ee', fileExtensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
  { id: 'duckdb', name: 'DuckDB / Dosyalar (CSV, Parquet, JSON, Excel)', short: 'DuckDB', kind: 'file', dialect: 'duckdb', color: '#fbbf24', fileExtensions: ['duckdb', 'db', 'csv', 'parquet', 'json', 'xlsx'] },
];

export const providerMeta = (id: ProviderId): ProviderMeta => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
