import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { postgresProvider } from '../../src/core/providers/postgres';
import type { IDataSourceConnection, ConnectionConfig } from '../../src/core/provider';
import { dockerAvailable, externalTarget, startContainer, waitFor, type Container } from './docker';
import { expectCancel, findPath, firstError, rowsOf, run } from './shared';

const ext = externalTarget('POSTGRES');
const enabled = !!ext || dockerAvailable();
if (!enabled) console.warn('[integration] Docker yok ve SQLM_EXTERNAL_POSTGRES tanımlı değil: PostgreSQL testleri atlandı.');

describe.skipIf(!enabled)('PostgreSQL provider', () => {
  let container: Container | null = null;
  let cfg: ConnectionConfig;
  let conn: IDataSourceConnection;

  beforeAll(async () => {
    if (ext) {
      cfg = { provider: 'postgres', ...ext, readOnly: false, ssl: { mode: 'prefer' } };
    } else {
      container = startContainer('postgres:16-alpine', { port: 5432, env: { POSTGRES_PASSWORD: 'Secret_123', POSTGRES_DB: 'app' } });
      cfg = { provider: 'postgres', host: container.host, port: container.port, user: 'postgres', password: 'Secret_123', database: 'app', readOnly: false, ssl: { mode: 'prefer' } };
    }
    await waitFor(async () => {
      const c = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
      await c.connect();
      await c.end();
    });
    // Örnek şema
    const c = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
    await c.connect();
    await c.query(`
      drop schema if exists sales cascade;
      create schema sales;
      create type sales.status as enum ('new', 'paid', 'shipped');
      create table sales.customers (id serial primary key, name text not null, country char(2) default 'TR', created timestamptz default now());
      create table sales.orders (id bigint generated always as identity primary key, customer_id int references sales.customers(id), total numeric(12,2), status sales.status default 'new', meta jsonb);
      create index orders_customer_idx on sales.orders(customer_id);
      create view sales.big_orders as select * from sales.orders where total > 100;
      create materialized view sales.country_totals as select c.country, sum(o.total) total from sales.customers c join sales.orders o on o.customer_id = c.id group by 1;
      create sequence sales.invoice_no start 1000;
      create function sales.add(a int, b int) returns int language sql as $$ select a + b $$;
      create procedure sales.touch() language plpgsql as $$ begin perform 1; end $$;
      create function sales.trg() returns trigger language plpgsql as $$ begin new.name := trim(new.name); return new; end $$;
      create trigger customers_trim before insert on sales.customers for each row execute function sales.trg();
      insert into sales.customers(name, country) values ('Ada', 'TR'), ('Linus', 'FI'), ('Grace', 'US');
      insert into sales.orders(customer_id, total, status, meta) values (1, 250.50, 'paid', '{"a":1}'), (2, 40, 'new', null), (1, 120, 'shipped', '[1,2]');
      drop table if exists public.big;
      create table public.big as select g as id, md5(g::text) as h from generate_series(1, 1000000) g;
    `);
    await c.end();
    conn = await postgresProvider.connect(cfg);
  });

  afterAll(async () => {
    await conn?.close();
    container?.stop();
  });

  it('connects and reports server info', async () => {
    const info = await conn.serverInfo();
    expect(info.product).toMatch(/^PostgreSQL 1\d/);
    expect(info.database).toBe(cfg.database);
    expect(typeof info.tls).toBe('boolean');
  });

  it('fails with a clear error on bad password', async () => {
    await expect(postgresProvider.connect({ ...cfg, password: 'wrong' })).rejects.toThrow(/password authentication failed/);
  });

  it('lists databases, schemas, folders and objects lazily', async () => {
    const roots = await conn.getChildren(null);
    expect(roots[0].name).toBe(cfg.database);
    const schema = await findPath(conn, [cfg.database!, 'sales']);
    const folders = await conn.getChildren(schema);
    const counts = Object.fromEntries(folders.map((f) => [f.path.folder, f.count]));
    expect(counts).toMatchObject({ tables: 2, views: 1, matviews: 1, functions: 2, procedures: 1, triggers: 1, sequences: 3, types: 1 });
    const tables = await conn.getChildren(folders.find((f) => f.path.folder === 'tables')!);
    expect(tables.map((t) => t.name)).toEqual(['customers', 'orders']);
    expect(tables[0].openAs).toBe('data');
    const cols = await conn.getChildren((await conn.getChildren(tables[1])).find((f) => f.path.folder === 'columns')!);
    expect(cols.map((c) => c.name)).toEqual(['id', 'customer_id', 'total', 'status', 'meta']);
    expect(cols[0].detail).toContain('PK');
    const fns = await conn.getChildren(folders.find((f) => f.path.folder === 'functions')!);
    expect(fns.map((f) => f.name).sort()).toEqual(['add', 'trg']);
    expect(fns.every((f) => f.openAs === 'code' && f.path.objectId)).toBe(true);
  });

  it('produces DDL for code objects', async () => {
    const schema = await findPath(conn, [cfg.database!, 'sales']);
    const folders = await conn.getChildren(schema);
    const get = async (folder: string, name: string) => (await conn.getChildren(folders.find((f) => f.path.folder === folder)!)).find((n) => n.name === name)!;
    expect(await conn.getObjectDdl(await get('views', 'big_orders'))).toMatch(/^CREATE OR REPLACE VIEW sales\.big_orders AS\n.*total > 100/s);
    expect(await conn.getObjectDdl(await get('functions', 'add'))).toMatch(/CREATE OR REPLACE FUNCTION sales\.add\(a integer, b integer\)/);
    expect(await conn.getObjectDdl(await get('procedures', 'touch'))).toMatch(/CREATE OR REPLACE PROCEDURE sales\.touch\(\)/);
    const trg = await conn.getObjectDdl(await get('triggers', 'customers_trim'));
    expect(trg).toMatch(/CREATE TRIGGER customers_trim BEFORE INSERT ON sales\.customers/);
    expect(trg).toMatch(/Trigger function/);
    expect(await conn.getObjectDdl(await get('types', 'status'))).toBe("CREATE TYPE sales.status AS ENUM (\n  'new',\n  'paid',\n  'shipped'\n);");
    expect(await conn.getObjectDdl(await get('sequences', 'invoice_no'))).toMatch(/CREATE SEQUENCE sales\.invoice_no[\s\S]*START WITH 1000/);
    const table = await conn.getObjectDdl(await get('tables', 'orders'));
    expect(table).toMatch(/CREATE TABLE sales\.orders \(\n  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL/);
    expect(table).toMatch(/FOREIGN KEY \(customer_id\) REFERENCES sales\.customers\(id\)/);
    expect(table).toMatch(/CREATE INDEX orders_customer_idx/);
    expect(await conn.getObjectDdl(await get('matviews', 'country_totals'))).toMatch(/^CREATE MATERIALIZED VIEW sales\.country_totals AS/);
  });

  it('streams query results in batches with types kept as text', async () => {
    const ev = await run(conn, { sql: 'select id, name, created, country from sales.customers order by id; select total, meta, status from sales.orders order by id' });
    const cols = ev.filter((e) => e.type === 'columns');
    expect(cols).toHaveLength(2);
    expect((cols[0] as { columns: { name: string; numeric?: boolean }[] }).columns.map((c) => [c.name, !!c.numeric])).toEqual([['id', true], ['name', false], ['created', false], ['country', false]]);
    expect(rowsOf(ev, 0).map((r) => r[1])).toEqual(['Ada', 'Linus', 'Grace']);
    expect(typeof rowsOf(ev, 0)[0][2]).toBe('string');
    expect(rowsOf(ev, 1)[0]).toEqual(['250.50', '{"a": 1}', 'paid']);
  });

  it('honours the row limit and reports truncation; first batch arrives fast on 1M rows', async () => {
    const started = Date.now();
    let firstBatchMs = -1;
    const events = [];
    const { executeScript } = await import('../../src/core/engine/executor');
    for await (const e of executeScript(conn, { sql: 'select * from public.big', readOnly: false }, new AbortController().signal)) {
      if (e.type === 'rows' && firstBatchMs < 0) firstBatchMs = Date.now() - started;
      events.push(e);
    }
    expect(firstBatchMs).toBeGreaterThanOrEqual(0);
    expect(firstBatchMs).toBeLessThan(2000);
    const batches = events.filter((e) => e.type === 'rows') as { rows: unknown[] }[];
    expect(batches[0].rows).toHaveLength(500);
    expect(batches.reduce((n, b) => n + b.rows.length, 0)).toBe(10_000);
    expect(events.find((e) => e.type === 'end')).toMatchObject({ rowCount: 10_000, truncated: true });
  });

  it('does not deadlock when the first batch exactly fills the limit on a fresh connection', async () => {
    const fresh = await postgresProvider.connect(cfg);
    try {
      const ev = await run(fresh, { sql: 'select * from public.big limit 100', limit: 100 });
      expect(rowsOf(ev)).toHaveLength(100);
      expect(ev.find((e) => e.type === 'end')).toMatchObject({ rowCount: 100, truncated: false });
    } finally {
      await fresh.close();
    }
  });

  it('reports DML row counts, notices and errors', async () => {
    const ev = await run(conn, { sql: "create temp table t(a int); insert into t select generate_series(1,5); do $$ begin raise notice 'merhaba'; end $$; select 1/0; select 2" });
    expect(ev.filter((e) => e.type === 'command').map((e) => (e as { command: string }).command)).toEqual(['CREATE', 'INSERT', 'DO']);
    expect(ev.find((e) => e.type === 'command' && (e as { command: string }).command === 'INSERT')).toMatchObject({ rowsAffected: 5 });
    expect(ev.find((e) => e.type === 'notice')).toMatchObject({ message: 'NOTICE: merhaba' });
    expect(firstError(ev)?.message).toMatch(/division by zero/);
    expect(ev.some((e) => e.type === 'statement' && e.index === 4)).toBe(false); // hata sonrası durur
  });

  it('cancels a running query and keeps the connection usable', async () => {
    await expectCancel(conn, 'select pg_sleep(30)');
  });

  it('enforces read-only mode at classifier and session level', async () => {
    const ro = await postgresProvider.connect({ ...cfg, readOnly: true });
    try {
      const blocked = await run(ro, { sql: "select 1; update sales.customers set name = 'x'", readOnly: true });
      expect(blocked[0]).toMatchObject({ type: 'blocked', statements: [{ index: 1, keyword: 'UPDATE' }] });
      // Sınıflandırıcıyı atlatan yazma (nextval) oturum düzeyinde reddedilir
      const hidden = await run(ro, { sql: "select nextval('sales.invoice_no')", readOnly: true });
      expect(firstError(hidden)?.message).toMatch(/read-only transaction/);
      // Kullanıcı onayıyla yazma tek seferlik serbest, sonra kip geri gelir
      const ok = await run(ro, { sql: "update sales.customers set country = 'TR' where id = 1", readOnly: true, allowWrite: true });
      expect(ok.find((e) => e.type === 'command')).toMatchObject({ command: 'UPDATE', rowsAffected: 1 });
      const again = await run(ro, { sql: "select nextval('sales.invoice_no')", readOnly: true });
      expect(firstError(again)?.message).toMatch(/read-only transaction/);
    } finally {
      await ro.close();
    }
  });

  it('provides columns and completion metadata', async () => {
    expect((await conn.getColumns({ schema: 'sales', table: 'orders' })).map((c) => [c.name, c.type, !!c.numeric])).toEqual([
      ['id', 'bigint', true], ['customer_id', 'integer', true], ['total', 'numeric(12,2)', true], ['status', 'sales.status', false], ['meta', 'jsonb', false],
    ]);
    const cs = await conn.getCompletionSchema();
    expect(cs.tables.sales.customers).toEqual(['id', 'name', 'country', 'created']);
    expect(cs.defaultSchema).toBe('public');
  });

  it('browses another database on the same server', async () => {
    const roots = await conn.getChildren(null);
    const pg = roots.find((r) => r.name === 'postgres');
    expect(pg).toBeTruthy();
    const schemas = await conn.getChildren(pg!);
    expect(schemas.map((s) => s.name)).toContain('public');
    const ev = await run(conn, { sql: 'select current_database()', database: 'postgres' });
    expect(rowsOf(ev)).toEqual([['postgres']]);
  });
});
