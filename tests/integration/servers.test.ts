// SQL Server ve MySQL/MariaDB entegrasyon testleri (Docker konteynerleriyle).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mssqlProvider } from '../../src/core/providers/mssql';
import { mysqlProvider } from '../../src/core/providers/mysql';
import type { ConnectionConfig, IDataSourceConnection } from '../../src/core/provider';
import { dockerAvailable, externalTarget, startContainer, waitFor, type Container } from './docker';
import { expectCancel, findPath, firstError, rowsOf, run } from './shared';

const docker = dockerAvailable();
const hasImage = (img: string) => docker && spawnSync('docker', ['image', 'inspect', img]).status === 0;

// --- SQL Server ------------------------------------------------------------------
const MSSQL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
const extMs = externalTarget('MSSQL');
const msEnabled = !!extMs || hasImage(MSSQL_IMAGE) || (docker && !!process.env.CI);
if (!msEnabled) console.warn('[integration] SQL Server görüntüsü yok: testler atlandı.');

describe.skipIf(!msEnabled)('SQL Server provider', () => {
  let container: Container | null = null;
  let cfg: ConnectionConfig;
  let conn: IDataSourceConnection;

  beforeAll(async () => {
    if (extMs) cfg = { provider: 'mssql', ...extMs, readOnly: false };
    else {
      container = startContainer(MSSQL_IMAGE, { port: 1433, env: { ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: 'Str0ng!Passw0rd', MSSQL_PID: 'Developer' } });
      cfg = { provider: 'mssql', host: container.host, port: container.port, user: 'sa', password: 'Str0ng!Passw0rd', database: 'master', readOnly: false };
    }
    const admin = await waitFor(() => mssqlProvider.connect(cfg), 240_000, 3000);
    await run(admin, { sql: "if db_id('shop') is not null begin alter database shop set single_user with rollback immediate; drop database shop; end\nGO\ncreate database shop" });
    await admin.close();
    cfg = { ...cfg, database: 'shop' };
    conn = await mssqlProvider.connect(cfg);
    const setup = await run(conn, { sql: `
      create schema sales;
      GO
      create table sales.customers (id int identity(1,1) primary key, name nvarchar(100) not null, created datetime2(3) default sysutcdatetime(), score decimal(10,2));
      create table sales.orders (id int primary key, customer_id int references sales.customers(id), total money);
      create index ix_orders_customer on sales.orders(customer_id) include (total);
      GO
      create view sales.big_orders as select * from sales.orders where total > 100;
      GO
      create function sales.add2(@a int, @b int) returns int as begin return @a + @b; end;
      GO
      create procedure sales.touch as begin set nocount on; select 1 as one; end;
      GO
      create trigger sales.tr_orders on sales.orders after insert as begin set nocount on; end;
      GO
      create sequence sales.invoice_no start with 1000;
      insert into sales.customers(name, score) values (N'Ayşe', 7.5), (N'Linus', 1);
      insert into sales.orders select top 200000 row_number() over (order by (select null)), 1 + abs(checksum(newid())) % 2, 50 from sys.all_objects a cross join sys.all_objects b;
    ` });
    expect(firstError(setup)).toBeUndefined();
  });

  afterAll(async () => {
    await conn?.close();
    container?.stop();
  });

  it('connects and lists objects', async () => {
    expect((await conn.serverInfo()).product).toMatch(/^SQL Server 2022/);
    const schema = await findPath(conn, ['shop', 'sales']);
    const folders = await conn.getChildren(schema);
    expect(Object.fromEntries(folders.map((f) => [f.path.folder, f.count]))).toMatchObject({ tables: 2, views: 1, functions: 1, procedures: 1, triggers: 1, sequences: 1 });
    const t = await findPath(conn, ['shop', 'sales', 'tables', 'customers']);
    const cols = await conn.getChildren((await conn.getChildren(t)).find((f) => f.path.folder === 'columns')!);
    expect(cols.map((c) => `${c.name} ${c.detail}`)).toEqual(['id int NOT NULL · PK', 'name nvarchar(100) NOT NULL', 'created datetime2(3)', 'score decimal(10,2)']);
  });

  it('produces DDL', async () => {
    const get = (folder: string, name: string) => findPath(conn, ['shop', 'sales', folder, name]);
    expect(await conn.getObjectDdl(await get('views', 'big_orders'))).toMatch(/create view sales\.big_orders as/i);
    expect(await conn.getObjectDdl(await get('procedures', 'touch'))).toMatch(/create procedure sales\.touch/i);
    expect(await conn.getObjectDdl(await get('functions', 'add2'))).toMatch(/create function sales\.add2/i);
    const table = await conn.getObjectDdl(await get('tables', 'orders'));
    expect(table).toMatch(/CREATE TABLE \[sales\]\.\[orders\]/);
    expect(table).toMatch(/FOREIGN KEY \(\[customer_id\]\) REFERENCES \[sales\]\.\[customers\] \(\[id\]\)/);
    expect(table).toMatch(/CREATE NONCLUSTERED INDEX \[ix_orders_customer\] ON \[sales\]\.\[orders\] \(\[customer_id\]\) INCLUDE \(\[total\]\)/);
    expect(await conn.getObjectDdl(await get('sequences', 'invoice_no'))).toMatch(/START WITH 1000/);
  });

  it('streams results, multiple result sets per batch and row counts', async () => {
    const ev = await run(conn, { sql: "select id, name, created, score from sales.customers order by id; select count(*) n from sales.orders\nupdate sales.customers set score = score where id = 1" });
    const cols = ev.filter((e) => e.type === 'columns');
    expect(cols).toHaveLength(2);
    expect(rowsOf(ev).slice(0, 2).map((r) => r[1])).toEqual(['Ayşe', 'Linus']);
    expect(typeof rowsOf(ev)[0][2]).toBe('string');
    expect(ev.filter((e) => e.type === 'command').map((e) => (e as { rowsAffected: number }).rowsAffected)).toEqual([1]);
    const lim = await run(conn, { sql: 'select * from sales.orders', limit: 1000 });
    expect(rowsOf(lim)).toHaveLength(1000);
    expect(lim.find((e) => e.type === 'end')).toMatchObject({ truncated: true });
    expect(rowsOf(await run(conn, { sql: 'select 2 as x' }))).toEqual([[2]]);
  });

  it('cancels a running query', async () => {
    await expectCancel(conn, "waitfor delay '00:00:30'");
  });

  it('read-only mode blocks writes via the classifier', async () => {
    const r = await run(conn, { sql: 'select 1\nexec sales.touch', readOnly: true });
    expect(r[0]).toMatchObject({ type: 'blocked', statements: [{ keyword: 'EXEC' }] });
  });

  it('switches databases per query', async () => {
    expect(rowsOf(await run(conn, { sql: 'select db_name()', database: 'master' }))).toEqual([['master']]);
    expect(rowsOf(await run(conn, { sql: 'select db_name()', database: 'shop' }))).toEqual([['shop']]);
    expect((await conn.getCompletionSchema('shop')).tables.sales.customers).toEqual(['id', 'name', 'created', 'score']);
  });
});

// --- MySQL / MariaDB ------------------------------------------------------------
const targets: { name: string; image: string; env: Record<string, string>; ext: ReturnType<typeof externalTarget>; cte: string }[] = [
  { name: 'MySQL', image: 'mysql:8.4', env: { MYSQL_ROOT_PASSWORD: 'secret', MYSQL_DATABASE: 'shop' }, ext: externalTarget('MYSQL'), cte: 'set session cte_max_recursion_depth = 200000' },
  { name: 'MariaDB', image: 'mariadb:11', env: { MARIADB_ROOT_PASSWORD: 'secret', MARIADB_DATABASE: 'shop' }, ext: externalTarget('MARIADB'), cte: 'set session max_recursive_iterations = 200000' },
];

for (const tg of targets) {
  const enabled = !!tg.ext || hasImage(tg.image) || (docker && !!process.env.CI);
  if (!enabled) console.warn(`[integration] ${tg.image} görüntüsü yok: ${tg.name} testleri atlandı.`);

  describe.skipIf(!enabled)(`${tg.name} provider`, () => {
    let container: Container | null = null;
    let cfg: ConnectionConfig;
    let conn: IDataSourceConnection;

    beforeAll(async () => {
      if (tg.ext) cfg = { provider: 'mysql', ...tg.ext, readOnly: false };
      else {
        container = startContainer(tg.image, { port: 3306, env: tg.env });
        cfg = { provider: 'mysql', host: container.host, port: container.port, user: 'root', password: 'secret', database: 'shop', readOnly: false };
      }
      conn = await waitFor(() => mysqlProvider.connect(cfg), 180_000, 2000);
      const setup = await run(conn, { sql: `
        ${tg.cte};
        create table customers (id int auto_increment primary key, name varchar(100) not null, created datetime default current_timestamp, big bigint, price decimal(10,2));
        create table orders (id int primary key, customer_id int, total decimal(12,2), index ix_c (customer_id), foreign key (customer_id) references customers(id));
        create view big_orders as select * from orders where total > 100;
        create function add2(a int, b int) returns int deterministic return a + b;
        create procedure touch() begin select 1 as one; end;
        create trigger tr_orders before insert on orders for each row set new.total = coalesce(new.total, 0);
        insert into customers(name, big, price) values ('Ayşe', 9007199254740993, 7.50), ('Linus', 3, 1);
        insert into orders with recursive g(n) as (select 1 union all select n + 1 from g where n < 100000) select n, 1 + n % 2, 50 from g;
      ` });
      expect(firstError(setup)).toBeUndefined();
    });

    afterAll(async () => {
      await conn?.close();
      container?.stop();
    });

    it('connects and lists objects', async () => {
      expect((await conn.serverInfo()).product).toMatch(tg.name === 'MySQL' ? /^MySQL 8/ : /^MariaDB 11/);
      const db = await findPath(conn, ['shop']);
      const folders = await conn.getChildren(db);
      expect(Object.fromEntries(folders.map((f) => [f.path.folder, f.count]))).toEqual({ tables: 2, views: 1, functions: 1, procedures: 1, triggers: 1 });
      const cols = await conn.getChildren(await findPath(conn, ['shop', 'tables', 'customers', 'columns']));
      expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'created', 'big', 'price']);
      expect(cols[0].detail).toContain('PK');
    });

    it('produces DDL', async () => {
      expect(await conn.getObjectDdl(await findPath(conn, ['shop', 'tables', 'orders']))).toMatch(/CREATE TABLE `orders`/);
      expect(await conn.getObjectDdl(await findPath(conn, ['shop', 'views', 'big_orders']))).toMatch(/VIEW `big_orders`/);
      expect(await conn.getObjectDdl(await findPath(conn, ['shop', 'procedures', 'touch']))).toMatch(/PROCEDURE `touch`/);
      expect(await conn.getObjectDdl(await findPath(conn, ['shop', 'triggers', 'tr_orders']))).toMatch(/TRIGGER `?tr_orders`?/i);
      expect(await conn.getObjectDdl(await findPath(conn, ['shop', 'tables', 'orders', 'indexes', 'ix_c']))).toBe('CREATE INDEX `ix_c` ON `shop`.`orders` (`customer_id`);');
    });

    it('keeps big numbers and dates as text, honours limits', async () => {
      const ev = await run(conn, { sql: 'select id, name, created, big, price from customers order by id' });
      const rows = rowsOf(ev);
      expect(rows[0][3]).toBe('9007199254740993');
      expect(rows[0][4]).toBe('7.50');
      expect(rows[0][2]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
      const lim = await run(conn, { sql: 'select * from orders', limit: 1000 });
      expect(rowsOf(lim)).toHaveLength(1000);
      expect(lim.find((e) => e.type === 'end')).toMatchObject({ truncated: true });
      expect(rowsOf(await run(conn, { sql: 'select 1 x' }))).toEqual([[1]]);
      const dml = await run(conn, { sql: "update customers set name = name where id <= 2" });
      expect(dml.find((e) => e.type === 'command')).toMatchObject({ command: 'UPDATE' });
    });

    it('cancels a running query', async () => {
      await expectCancel(conn, 'select sleep(30)');
    });

    it('enforces read-only mode at session level', async () => {
      const ro = await mysqlProvider.connect({ ...cfg, readOnly: true });
      try {
        expect((await run(ro, { sql: 'delete from orders', readOnly: true }))[0]).toMatchObject({ type: 'blocked' });
        expect(firstError(await run(ro, { sql: 'delete from orders where id = 1' }))?.message).toMatch(/READ ONLY/i);
        const ok = await run(ro, { sql: 'delete from orders where id = 1', readOnly: true, allowWrite: true });
        expect(ok.find((e) => e.type === 'command')).toMatchObject({ rowsAffected: 1 });
      } finally {
        await ro.close();
      }
    });

    it('switches databases and provides completion', async () => {
      expect(rowsOf(await run(conn, { sql: 'select database()', database: 'mysql' }))).toEqual([['mysql']]);
      expect(rowsOf(await run(conn, { sql: 'select database()', database: 'shop' }))).toEqual([['shop']]);
      expect((await conn.getCompletionSchema('shop')).tables.shop.customers).toEqual(['id', 'name', 'created', 'big', 'price']);
    });
  });
}
