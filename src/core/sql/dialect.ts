// Lehçe farkları: tanımlayıcı tırnaklama, metin sabitleri, satır sınırı sözdizimi.
import type { SqlDialect } from '../provider';

export interface TableRef {
  database?: string;
  schema?: string;
  name: string;
}

export function quoteIdent(name: string, d: SqlDialect): string {
  switch (d) {
    case 'mysql':
      return '`' + name.replace(/`/g, '``') + '`';
    case 'mssql':
      return '[' + name.replace(/]/g, ']]') + ']';
    default:
      return '"' + name.replace(/"/g, '""') + '"';
  }
}

/** Sade adları (küçük harf/rakam/_) tırnaksız bırakır; okunur SQL üretmek için. */
export function ident(name: string, d: SqlDialect): string {
  const plain = d === 'mssql' || d === 'mysql' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[a-z_][a-z0-9_]*$/;
  return plain.test(name) && !isReserved(name) ? name : quoteIdent(name, d);
}

export function qualified(t: TableRef, d: SqlDialect): string {
  const parts: string[] = [];
  if ((d === 'mssql' || d === 'duckdb') && t.database) {
    parts.push(ident(t.database, d), t.schema ? ident(t.schema, d) : '');
  } else if (d === 'mysql') {
    // MySQL'de şema = veritabanı
    const db = t.schema ?? t.database;
    if (db) parts.push(ident(db, d));
  } else if (t.schema) {
    parts.push(ident(t.schema, d));
  }
  parts.push(ident(t.name, d));
  return parts.join('.');
}

export function literal(v: string, d: SqlDialect): string {
  const body = v.replace(/'/g, "''");
  if (d === 'mysql') return "'" + body.replace(/\\/g, '\\\\') + "'";
  if (d === 'mssql' && /[^\x00-\x7f]/.test(v)) return "N'" + body + "'";
  return "'" + body + "'";
}

/** İfadeyi ilk n satırla sınırlar (yalnızca SELECT için kullanılır) */
export function limitClause(n: number, d: SqlDialect): { top: string; tail: string } {
  if (d === 'mssql') return { top: `TOP (${n}) `, tail: '' };
  return { top: '', tail: `\nLIMIT ${n}` };
}

// Kısa ayrılmış sözcük listesi: bunlar tırnaklanarak yazılır
const RESERVED = new Set(
  ('all and any as asc between by case check column constraint create cross current_date current_time current_user default ' +
    'delete desc distinct drop else end except exists false fetch for foreign from full grant group having in index inner insert ' +
    'intersect into is join key left like limit natural not null offset on or order outer primary references right select ' +
    'session_user set some table then to top true union unique update user using values view when where with')
    .split(' ')
);
export const isReserved = (w: string) => RESERVED.has(w.toLowerCase());
