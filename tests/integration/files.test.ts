// SQLite ve DuckDB (dosya tabanlı) sağlayıcıları: Docker gerektirmez.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteProvider } from '../../src/core/providers/sqlite';
import { duckdbProvider } from '../../src/core/providers/duckdb';
import { exportQuery } from '../../src/core/engine/export';
import type { IDataSourceConnection } from '../../src/core/provider';
import { expectCancel, findPath, firstError, rowsOf, run } from './shared';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlm-files-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('SQLite provider', () => {
  const file = path.join(dir, 'app.db');
  let conn: IDataSourceConnection;

  beforeAll(async () => {
    const db = new DatabaseSync(file);
    db.exec(`
      create table customers (id integer primary key, name text not null, big integer, score real, photo blob);
      create table orders (id integer primary key, customer_id integer references customers(id), total numeric);
      create index orders_c on orders(customer_id);
      create view rich as select * from customers where score > 5;
      create trigger tr after insert on orders begin update customers set score = score + 1 where id = new.customer_id; end;
      insert into customers values (1, 'Ada', 9007199254740993, 7.5, x'0102'), (2, 'Linus', 3, 1.0, null);
      with recursive g(n) as (select 1 union all select n + 1 from g where n < 300000) insert into orders select n, 1 + n % 2, n * 1.5 from g;
    `);
    db.close();
    conn = await sqliteProvider.connect({ provider: 'sqlite', filePath: file, readOnly: false });
  });
  afterAll(() => conn?.close());

  it('lists objects lazily', async () => {
    const roots = await conn.getChildren(null);
    expect(roots.map((r) => r.name)).toEqual(['main']);
    const folders = await conn.getChildren(roots[0]);
    expect(Object.fromEntries(folders.map((f) => [f.path.folder, f.count]))).toEqual({ tables: 2, views: 1, triggers: 1, indexes: 1 });
    const t = await findPath(conn, ['main', 'tables', 'customers']);
    const cols = await conn.getChildren((await conn.getChildren(t)).find((f) => f.path.folder === 'columns')!);
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'big', 'score', 'photo']);
    expect(await conn.getObjectDdl(await findPath(conn, ['main', 'views', 'rich']))).toMatch(/create view rich as/i);
    expect(await conn.getObjectDdl(await findPath(conn, ['main', 'triggers', 'tr']))).toMatch(/create trigger tr/i);
  });

  it('queries with big integers, blobs and limits', async () => {
    const ev = await run(conn, { sql: 'select id, name, big, photo, 2.5 r from customers order by id' });
    expect(rowsOf(ev)).toEqual([[1, 'Ada', '9007199254740993', '0x0102', 2.5], [2, 'Linus', 3, null, 2.5]]);
    const big = await run(conn, { sql: 'select * from orders', limit: 1000 });
    expect(rowsOf(big)).toHaveLength(1000);
    expect(big.find((e) => e.type === 'end')).toMatchObject({ truncated: true });
    const dml = await run(conn, { sql: "insert into customers(id, name) values (3, 'Grace'); delete from customers where id = 3" });
    expect(dml.filter((e) => e.type === 'command').map((e) => (e as { rowsAffected: number }).rowsAffected)).toEqual([1, 1]);
  });

  it('cancels between batches', async () => {
    // Sınırsız akış: iptal parçalar arasında yakalanır. (Tek bir uzun hesaplama senkron çalışır;
    // onu ana süreç 5 sn sonra veritabanı sürecini sonlandırarak keser — bkz. main.ts db:cancel.)
    await expectCancel(conn, 'select a.id from orders a, orders b', 0);
  });

  it('read-only mode never writes the file', async () => {
    const ro = await sqliteProvider.connect({ provider: 'sqlite', filePath: file, readOnly: true });
    try {
      expect((await run(ro, { sql: 'delete from orders', readOnly: true }))[0]).toMatchObject({ type: 'blocked' });
      // sınıflandırıcıyı atlatsa bile PRAGMA query_only reddeder
      expect(firstError(await run(ro, { sql: 'delete from orders' }))?.message).toMatch(/readonly|read-only|query_only/i);
      const ok = await run(ro, { sql: 'delete from orders where id = 1', readOnly: true, allowWrite: true });
      expect(ok.find((e) => e.type === 'command')).toMatchObject({ rowsAffected: 1 });
      expect(firstError(await run(ro, { sql: 'delete from orders where id = 2' }))).toBeTruthy();
    } finally {
      await ro.close();
    }
    await expect(sqliteProvider.connect({ provider: 'sqlite', filePath: path.join(dir, 'yok.db'), readOnly: true })).rejects.toThrow(/bulunamadı/);
  });

  it('exports 300k rows to CSV with constant memory', async () => {
    const out = path.join(dir, 'orders.csv');
    const before = process.memoryUsage().heapUsed;
    const r = await exportQuery(conn, 'select * from orders', { format: 'csv', filePath: out, signal: new AbortController().signal });
    expect(r.rows).toBe(299_999);
    const lines = fs.readFileSync(out, 'utf8').trimEnd().split('\r\n');
    expect(lines[0]).toBe('﻿id,customer_id,total');
    expect(lines).toHaveLength(300_000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(200 * 1024 * 1024);
  });
});

describe('DuckDB provider (files)', () => {
  let conn: IDataSourceConnection;
  const csv = path.join(dir, 'sales.csv');
  const parquet = path.join(dir, 'products.parquet');
  const json = path.join(dir, 'stores.json');

  beforeAll(async () => {
    fs.writeFileSync(csv, 'id,product_id,qty,store\n1,10,3,A\n2,11,1,B\n3,10,5,A\n');
    fs.writeFileSync(json, JSON.stringify([{ store: 'A', city: 'İstanbul' }, { store: 'B', city: 'Ankara' }]));
    conn = await duckdbProvider.connect({ provider: 'duckdb', filePath: '', readOnly: false });
    const lit = (p: string) => `'${p.replace(/'/g, "''")}'`;
    await run(conn, { sql: `copy (select * from (values (10, 'Kalem', 2.5), (11, 'Defter', 10.0)) t(id, name, price)) to ${lit(parquet)} (format parquet)` });
  });
  afterAll(() => conn?.close());

  it('joins CSV, Parquet and JSON files in a single query', async () => {
    const lit = (p: string) => `'${p.replace(/'/g, "''")}'`;
    const ev = await run(conn, {
      sql: `select p.name, st.city, sum(s.qty * p.price) revenue
            from ${lit(csv)} s join ${lit(parquet)} p on p.id = s.product_id join read_json_auto(${lit(json)}) st using (store)
            group by all order by revenue desc`,
    });
    expect(firstError(ev)).toBeUndefined();
    // DECIMAL değerleri hassasiyet kaybı olmasın diye metin olarak gelir
    expect(rowsOf(ev)).toEqual([['Kalem', 'İstanbul', '20.0'], ['Defter', 'Ankara', '10.0']]);
  });

  it('opens a CSV directly as a view and lists it in the tree', async () => {
    const c = await duckdbProvider.connect({ provider: 'duckdb', filePath: csv, readOnly: true });
    try {
      const v = await findPath(c, ['memory', 'main', 'views', 'sales']);
      expect(v.openAs).toBe('data');
      expect((await c.getColumns({ database: 'memory', schema: 'main', name: 'sales' })).map((x) => [x.name, x.numeric])).toEqual([['id', true], ['product_id', true], ['qty', true], ['store', false]]);
      expect(rowsOf(await run(c, { sql: 'select count(*) from sales', readOnly: true }))).toEqual([[3]]);
    } finally {
      await c.close();
    }
  });

  it('works with a database file, DDL and read-only mode', async () => {
    const dbFile = path.join(dir, 'w.duckdb');
    const rw = await duckdbProvider.connect({ provider: 'duckdb', filePath: dbFile, readOnly: false });
    await run(rw, { sql: 'create table t(id integer primary key, v varchar); insert into t select i, md5(i::varchar) from range(200000) r(i); create view tv as select * from t where id < 10; create macro twice(x) as x * 2' });
    expect(await rw.getObjectDdl(await findPath(rw, ['w', 'main', 'tables', 't']))).toMatch(/CREATE TABLE t\(id INTEGER PRIMARY KEY, v VARCHAR\)/i);
    expect(await rw.getObjectDdl(await findPath(rw, ['w', 'main', 'functions', 'twice']))).toMatch(/MACRO main\.twice\(x\) AS \(?x \* 2\)?/);
    const lim = await run(rw, { sql: 'select * from t', limit: 700, batchSize: 500 });
    expect(rowsOf(lim)).toHaveLength(700);
    expect(lim.find((e) => e.type === 'end')).toMatchObject({ truncated: true });
    await expectCancel(rw, 'select count(*) from range(10000000000) a');
    await rw.close();
    const ro = await duckdbProvider.connect({ provider: 'duckdb', filePath: dbFile, readOnly: true });
    try {
      expect(firstError(await run(ro, { sql: 'delete from t' }))?.message).toMatch(/read-only/i);
    } finally {
      await ro.close();
    }
  });
});
