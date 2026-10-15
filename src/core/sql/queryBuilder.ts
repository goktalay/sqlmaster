// Görsel sorgu oluşturucunun modeli ve SQL üretimi (Navicat Query Builder benzeri).
// Tuval: tablolar, aralarında çizilen JOIN'ler, seçilen kolonlar (takma ad, toplama, sıralama) ve koşullar.
import type { ColumnMeta, SqlDialect } from '../provider';
import { ident, limitClause, qualified, type TableRef } from './dialect';
import { conditionSql, opNeedsValue, type FilterOp } from './gridQuery';

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
export type Aggregate = '' | 'COUNT' | 'COUNT DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export interface QbTable {
  id: string;
  ref: TableRef;
  alias: string;
  columns: ColumnMeta[];
  x: number;
  y: number;
}

export interface QbJoin {
  id: string;
  type: JoinType;
  left: { table: string; column: string };
  right: { table: string; column: string };
}

export interface QbColumn {
  table: string;
  column: string;
  alias?: string;
  aggregate?: Aggregate;
  sort?: '' | 'ASC' | 'DESC';
  output: boolean;
}

export interface QbCondition {
  id: string;
  table: string;
  column: string;
  op: FilterOp;
  value?: string;
  connector: 'AND' | 'OR';
}

export interface QbModel {
  tables: QbTable[];
  joins: QbJoin[];
  columns: QbColumn[];
  conditions: QbCondition[];
  distinct: boolean;
  limit: number | null;
}

export const emptyModel = (): QbModel => ({ tables: [], joins: [], columns: [], conditions: [], distinct: false, limit: 1000 });

/** Tablo adından benzersiz kısa takma ad: customer_orders → co, co2… */
export function makeAlias(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((x) => x.toLowerCase()));
  const parts = name.replace(/[^A-Za-z0-9_]/g, '_').split(/_+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  let base = (parts.length > 1 ? parts.map((p) => p[0]).join('') : (parts[0] ?? 't').slice(0, 1)).toLowerCase();
  if (!/^[a-z]/.test(base)) base = 't' + base;
  let alias = base;
  for (let i = 2; used.has(alias); i++) alias = base + i;
  return alias;
}

const FLIP: Record<JoinType, JoinType> = { INNER: 'INNER', LEFT: 'RIGHT', RIGHT: 'LEFT', FULL: 'FULL' };

export function buildQuery(m: QbModel, d: SqlDialect): string {
  if (!m.tables.length) return '';
  const byId = new Map(m.tables.map((t) => [t.id, t]));
  const useAlias = m.tables.length > 1;
  const col = (tableId: string, column: string) => {
    const t = byId.get(tableId);
    return useAlias && t ? `${t.alias}.${ident(column, d)}` : ident(column, d);
  };
  const meta = (tableId: string, column: string) => byId.get(tableId)?.columns.find((c) => c.name === column);
  const tableSql = (t: QbTable) => (useAlias ? `${qualified(t.ref, d)} ${t.alias}` : qualified(t.ref, d));

  // --- SELECT listesi
  const out = m.columns.filter((c) => c.output && byId.has(c.table));
  const anyAgg = out.some((c) => c.aggregate);
  const selectItems = out.map((c) => {
    const e = col(c.table, c.column);
    const expr = !c.aggregate ? e : c.aggregate === 'COUNT DISTINCT' ? `COUNT(DISTINCT ${e})` : `${c.aggregate}(${e})`;
    return c.alias ? `${expr} AS ${ident(c.alias, d)}` : expr;
  });
  const lim = m.limit ? limitClause(m.limit, d) : { top: '', tail: '' };
  let sql = `SELECT ${m.distinct ? 'DISTINCT ' : ''}${lim.top}${selectItems.length ? selectItems.join(',\n       ') : '*'}`;

  // --- FROM + JOIN'ler: ilk tablodan başlayıp bağlı tabloları sırayla ekle
  const [base] = m.tables;
  const visited = new Set([base.id]);
  const used = new Set<string>();
  sql += `\nFROM ${tableSql(base)}`;
  for (;;) {
    let next: QbTable | null = null;
    let type: JoinType = 'INNER';
    const conds: string[] = [];
    for (const j of m.joins) {
      if (used.has(j.id) || !byId.has(j.left.table) || !byId.has(j.right.table)) continue;
      const lv = visited.has(j.left.table);
      const rv = visited.has(j.right.table);
      if (lv === rv) continue;
      const target = byId.get(lv ? j.right.table : j.left.table)!;
      if (next && target.id !== next.id) continue;
      if (!next) { next = target; type = lv ? j.type : FLIP[j.type]; }
      used.add(j.id);
      conds.push(`${col(j.left.table, j.left.column)} = ${col(j.right.table, j.right.column)}`);
    }
    if (!next) break;
    visited.add(next.id);
    // Yeni tablo ile önceden eklenmiş tablolar arasındaki diğer bağlantılar da ON'a girer
    for (const j of m.joins) {
      if (used.has(j.id)) continue;
      if (visited.has(j.left.table) && visited.has(j.right.table) && (j.left.table === next.id || j.right.table === next.id)) {
        used.add(j.id);
        conds.push(`${col(j.left.table, j.left.column)} = ${col(j.right.table, j.right.column)}`);
      }
    }
    sql += `\n${type === 'INNER' ? 'INNER' : type + ' OUTER'} JOIN ${tableSql(next)} ON ${conds.join(' AND ')}`;
  }
  for (const t of m.tables) if (!visited.has(t.id)) sql += `\nCROSS JOIN ${tableSql(t)}`;
  // Aynı iki tablo arasında kalan ek bağlantılar
  const extra = m.joins.filter((j) => !used.has(j.id) && byId.has(j.left.table) && byId.has(j.right.table));

  // --- WHERE / HAVING
  const where: string[] = extra.map((j) => `${col(j.left.table, j.left.column)} = ${col(j.right.table, j.right.column)}`);
  const conds = m.conditions.filter((c) => byId.has(c.table) && c.column && (!opNeedsValue(c.op) || (c.value ?? '') !== ''));
  if (conds.length) {
    const parts = conds.map((c, i) => `${i ? c.connector + ' ' : ''}${conditionSql(col(c.table, c.column), c, meta(c.table, c.column), d)}`);
    where.push(conds.length > 1 && conds.some((c) => c.connector === 'OR') ? `(${parts.join('\n  ')})` : parts.join('\n  '));
  }
  if (where.length) sql += `\nWHERE ${where.join('\n  AND ')}`;

  if (anyAgg) {
    const groups = out.filter((c) => !c.aggregate).map((c) => col(c.table, c.column));
    if (groups.length) sql += `\nGROUP BY ${groups.join(', ')}`;
  }

  const sorts = m.columns.filter((c) => c.sort && byId.has(c.table));
  if (sorts.length) {
    sql += `\nORDER BY ${sorts
      .map((c) => {
        const target = c.output && c.alias ? ident(c.alias, d) : c.aggregate ? (c.aggregate === 'COUNT DISTINCT' ? `COUNT(DISTINCT ${col(c.table, c.column)})` : `${c.aggregate}(${col(c.table, c.column)})`) : col(c.table, c.column);
        return `${target}${c.sort === 'DESC' ? ' DESC' : ''}`;
      })
      .join(', ')}`;
  }
  return sql + lim.tail;
}
