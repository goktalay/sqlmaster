// Yerleşik sağlayıcıları kaydeder. Yeni sağlayıcı = yeni dosya + buraya bir satır.
import { registerProvider } from '../registry';
import { postgresProvider } from './postgres';
import { mssqlProvider } from './mssql';
import { mysqlProvider } from './mysql';
import { sqliteProvider } from './sqlite';
import { duckdbProvider } from './duckdb';

let done = false;
export function registerBuiltinProviders(): void {
  if (done) return;
  done = true;
  for (const p of [postgresProvider, mssqlProvider, mysqlProvider, sqliteProvider, duckdbProvider]) registerProvider(p);
}
