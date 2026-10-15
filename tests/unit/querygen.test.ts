import { describe, expect, it } from 'vitest';
import { buildGridSelect, type GridQueryModel } from '../../src/core/sql/gridQuery';
import { buildQuery, emptyModel, makeAlias, type QbModel } from '../../src/core/sql/queryBuilder';
import type { ColumnMeta } from '../../src/core/provider';

const cols: ColumnMeta[] = [
  { name: 'id', type: 'integer', numeric: true },
  { name: 'name', type: 'text' },
  { name: 'Email', type: 'varchar' },
  { name: 'created', type: 'timestamp' },
];

const grid = (patch: Partial<GridQueryModel> = {}): GridQueryModel => ({
  table: { schema: 'public', name: 'users' }, columns: cols, hidden: [], sort: [], filters: [], limit: 100, ...patch,
});

describe('buildGridSelect', () => {
  it('starts with SELECT * and the default limit', () => {
    expect(buildGridSelect(grid(), 'postgres')).toBe('SELECT *\nFROM public.users\nLIMIT 100');
  });

  it('reflects hidden columns in the SELECT list', () => {
    expect(buildGridSelect(grid({ hidden: ['name'] }), 'postgres')).toBe('SELECT id, "Email", created\nFROM public.users\nLIMIT 100');
  });

  it('reflects sorting and filters', () => {
    const sql = buildGridSelect(grid({
      hidden: ['created'],
      sort: [{ column: 'name', dir: 'desc' }, { column: 'id', dir: 'asc' }],
      filters: [{ column: 'id', op: '>', value: '10' }, { column: 'name', op: 'contains', value: "o'k" }, { column: 'Email', op: 'is not null' }, { column: 'name', op: '=', value: '' }],
    }), 'postgres');
    expect(sql).toBe(`SELECT id, name, "Email"\nFROM public.users\nWHERE id > 10\n  AND name ILIKE '%o''k%'\n  AND "Email" IS NOT NULL\nORDER BY name DESC, id\nLIMIT 100`);
  });

  it('uses TOP for SQL Server and casts non-text columns for contains', () => {
    const sql = buildGridSelect(grid({ table: { database: 'app', schema: 'dbo', name: 'users' }, filters: [{ column: 'id', op: 'contains', value: '4' }], hidden: ['Email'] }), 'mssql');
    expect(sql).toBe(`SELECT TOP (100) id, name, created\nFROM app.dbo.users\nWHERE CAST(id AS NVARCHAR(4000)) LIKE '%4%'`);
  });

  it('supports IN lists and no limit', () => {
    expect(buildGridSelect(grid({ limit: null, filters: [{ column: 'id', op: 'in', value: '1, 2,x' }] }), 'mysql')).toBe("SELECT *\nFROM public.users\nWHERE id IN (1, 2, 'x')");
  });
});

describe('query builder', () => {
  const base = (): QbModel => ({
    ...emptyModel(),
    tables: [
      { id: 't1', ref: { schema: 'public', name: 'customers' }, alias: 'c', columns: [{ name: 'id', type: 'int', numeric: true }, { name: 'name', type: 'text' }, { name: 'country', type: 'text' }], x: 0, y: 0 },
      { id: 't2', ref: { schema: 'public', name: 'orders' }, alias: 'o', columns: [{ name: 'id', type: 'int', numeric: true }, { name: 'customer_id', type: 'int', numeric: true }, { name: 'total', type: 'numeric', numeric: true }], x: 0, y: 0 },
    ],
    limit: null,
  });

  it('generates joins, selected columns and conditions', () => {
    const m = base();
    m.joins.push({ id: 'j1', type: 'LEFT', left: { table: 't1', column: 'id' }, right: { table: 't2', column: 'customer_id' } });
    m.columns.push({ table: 't1', column: 'name', output: true }, { table: 't2', column: 'total', output: true, alias: 'Toplam' });
    m.conditions.push({ id: 'c1', table: 't1', column: 'country', op: '=', value: 'TR', connector: 'AND' });
    expect(buildQuery(m, 'postgres')).toBe(
      `SELECT c.name,\n       o.total AS "Toplam"\nFROM public.customers c\nLEFT OUTER JOIN public.orders o ON c.id = o.customer_id\nWHERE c.country = 'TR'`
    );
  });

  it('flips join direction when the joined table is on the left', () => {
    const m = base();
    m.joins.push({ id: 'j1', type: 'LEFT', left: { table: 't2', column: 'customer_id' }, right: { table: 't1', column: 'id' } });
    expect(buildQuery(m, 'postgres')).toContain('RIGHT OUTER JOIN public.orders o ON o.customer_id = c.id');
  });

  it('adds GROUP BY for aggregates and ORDER BY', () => {
    const m = base();
    m.joins.push({ id: 'j1', type: 'INNER', left: { table: 't1', column: 'id' }, right: { table: 't2', column: 'customer_id' } });
    m.columns.push({ table: 't1', column: 'country', output: true, sort: 'ASC' }, { table: 't2', column: 'total', output: true, aggregate: 'SUM', alias: 'sum_total', sort: 'DESC' });
    m.limit = 10;
    expect(buildQuery(m, 'mssql')).toBe(
      `SELECT TOP (10) c.country,\n       SUM(o.total) AS sum_total\nFROM public.customers c\nINNER JOIN public.orders o ON c.id = o.customer_id\nGROUP BY c.country\nORDER BY c.country, sum_total DESC`
    );
  });

  it('cross joins unconnected tables and omits aliases for a single table', () => {
    const m = base();
    expect(buildQuery(m, 'postgres')).toBe('SELECT *\nFROM public.customers c\nCROSS JOIN public.orders o');
    m.tables.pop();
    m.columns.push({ table: 't1', column: 'name', output: true });
    expect(buildQuery(m, 'postgres')).toBe('SELECT name\nFROM public.customers');
  });

  it('makes unique aliases', () => {
    expect(makeAlias('customer_orders', [])).toBe('co');
    expect(makeAlias('customers', ['c'])).toBe('c2');
    expect(makeAlias('OrderItems', [])).toBe('oi');
  });
});
