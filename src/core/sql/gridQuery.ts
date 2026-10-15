// Tablo verisi ızgarasının SQL'i: kolon gizle/göster, sıralama ve filtreler SELECT ifadesine yansır.
// Arayüz her değişiklikte buildGridSelect() ile SQL'i yeniden üretir, kullanıcıya gösterir ve çalıştırır.
import type { ColumnMeta, SqlDialect } from '../provider';
import { ident, limitClause, literal, qualified, type TableRef } from './dialect';

export type FilterOp =
  | '=' | '<>' | '<' | '>' | '<=' | '>='
  | 'contains' | 'not contains' | 'starts' | 'ends'
  | 'like' | 'not like' | 'in' | 'not in'
  | 'is null' | 'is not null';

export const FILTER_OPS: FilterOp[] = ['=', '<>', '<', '>', '<=', '>=', 'contains', 'not contains', 'starts', 'ends', 'like', 'not like', 'in', 'not in', 'is null', 'is not null'];
export const opNeedsValue = (op: FilterOp) => op !== 'is null' && op !== 'is not null';

export interface GridFilter {
  column: string;
  op: FilterOp;
  value?: string;
}

export interface GridSort {
  column: string;
  dir: 'asc' | 'desc';
}

export interface GridQueryModel {
  table: TableRef;
  /** Tablodaki tüm kolonlar (sıra korunur) */
  columns: ColumnMeta[];
  hidden: string[];
  sort: GridSort[];
  filters: GridFilter[];
  /** Serbest WHERE ifadesi (filtrelerle AND'lenir) */
  where?: string;
  limit: number | null;
}

export function castText(expr: string, d: SqlDialect): string {
  switch (d) {
    case 'postgres':
    case 'duckdb':
      return `CAST(${expr} AS text)`;
    case 'mssql':
      return `CAST(${expr} AS NVARCHAR(4000))`;
    case 'mysql':
      return `CAST(${expr} AS CHAR)`;
    default:
      return `CAST(${expr} AS TEXT)`;
  }
}

const isNumberLike = (v: string) => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim());

/** Filtre değeri: sayısal kolona sayı tırnaksız, diğerleri metin sabiti */
export function valueSql(v: string, col: ColumnMeta | undefined, d: SqlDialect): string {
  if (col?.numeric && isNumberLike(v)) return v.trim();
  if (/^bool/i.test(col?.type ?? '') && /^(true|false)$/i.test(v.trim())) return v.trim().toUpperCase();
  return literal(v, d);
}

export function conditionSql(expr: string, f: { op: FilterOp; value?: string }, col: ColumnMeta | undefined, d: SqlDialect): string {
  const v = f.value ?? '';
  const ci = d === 'postgres' || d === 'duckdb' ? 'ILIKE' : 'LIKE';
  const textExpr = col?.numeric || (col && !/char|text|string|clob|uuid|enum|name|json|xml/i.test(col.type)) ? castText(expr, d) : expr;
  switch (f.op) {
    case 'is null': return `${expr} IS NULL`;
    case 'is not null': return `${expr} IS NOT NULL`;
    case 'contains': return `${textExpr} ${ci} ${literal(`%${v}%`, d)}`;
    case 'not contains': return `${textExpr} NOT ${ci} ${literal(`%${v}%`, d)}`;
    case 'starts': return `${textExpr} ${ci} ${literal(`${v}%`, d)}`;
    case 'ends': return `${textExpr} ${ci} ${literal(`%${v}`, d)}`;
    case 'like': return `${textExpr} LIKE ${literal(v, d)}`;
    case 'not like': return `${textExpr} NOT LIKE ${literal(v, d)}`;
    case 'in':
    case 'not in': {
      const items = v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => valueSql(x, col, d));
      return `${expr} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${items.join(', ') || 'NULL'})`;
    }
    default:
      return `${expr} ${f.op} ${valueSql(v, col, d)}`;
  }
}

export function buildGridSelect(m: GridQueryModel, d: SqlDialect): string {
  const hidden = new Set(m.hidden);
  const visible = m.columns.filter((c) => !hidden.has(c.name));
  const byName = new Map(m.columns.map((c) => [c.name, c]));
  const allVisible = visible.length === m.columns.length;
  const lim = m.limit ? limitClause(m.limit, d) : { top: '', tail: '' };

  const list = allVisible || !visible.length ? '*' : visible.map((c) => ident(c.name, d)).join(', ');
  let sql = `SELECT ${lim.top}${list}\nFROM ${qualified(m.table, d)}`;

  const conds = m.filters
    .filter((f) => byName.has(f.column) && (!opNeedsValue(f.op) || (f.value ?? '') !== ''))
    .map((f) => conditionSql(ident(f.column, d), f, byName.get(f.column), d));
  if (m.where && m.where.trim()) conds.push(`(${m.where.trim()})`);
  if (conds.length) sql += `\nWHERE ${conds.join('\n  AND ')}`;

  const sorts = m.sort.filter((s) => byName.has(s.column));
  if (sorts.length) sql += `\nORDER BY ${sorts.map((s) => `${ident(s.column, d)}${s.dir === 'desc' ? ' DESC' : ''}`).join(', ')}`;
  return sql + lim.tail;
}
