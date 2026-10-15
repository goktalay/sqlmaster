import { describe, expect, it } from 'vitest';
import { splitStatements, statementAt } from '../../src/core/sql/split';
import { classify } from '../../src/core/sql/classify';
import { qualified, quoteIdent, ident } from '../../src/core/sql/dialect';

const texts = (sql: string, d: Parameters<typeof splitStatements>[1]) => splitStatements(sql, d).map((s) => s.text);

describe('splitStatements', () => {
  it('splits on semicolons outside strings and comments', () => {
    expect(texts(`select 1; select 'a;b'; -- x;y\nselect "c;d" /* ; */ from t;`, 'postgres')).toEqual([
      'select 1',
      "select 'a;b'",
      '-- x;y\nselect "c;d" /* ; */ from t',
    ]);
  });

  it('keeps PostgreSQL dollar-quoted bodies intact', () => {
    const sql = `create function f() returns int as $$ begin return 1; end; $$ language plpgsql;\nselect f();`;
    expect(texts(sql, 'postgres')).toEqual(['create function f() returns int as $$ begin return 1; end; $$ language plpgsql', 'select f()']);
    expect(texts(`select $tag$ a;b $tag$; select $1`, 'postgres')).toEqual(['select $tag$ a;b $tag$', 'select $1']);
  });

  it('handles E-strings with backslash escapes and nested comments', () => {
    expect(texts(`select E'it\\'s; ok'; /* a /* b; */ c; */ select 2`, 'postgres')).toEqual([`select E'it\\'s; ok'`, '/* a /* b; */ c; */ select 2']);
  });

  it('skips comment-only fragments and empty statements', () => {
    expect(texts(`;; -- only comment\n ; select 1;`, 'postgres')).toEqual(['select 1']);
  });

  it('splits SQL Server scripts on GO lines only', () => {
    const sql = `select 1; select 2\nGO\nselect 'GO'\n  go 2\nselect 3`;
    expect(texts(sql, 'mssql')).toEqual(['select 1; select 2', "select 'GO'", 'select 3']);
  });

  it('supports MySQL DELIMITER and backslash escapes', () => {
    const sql = `select 'a\\';b';\nDELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect 3;`;
    expect(texts(sql, 'mysql')).toEqual([`select 'a\\';b'`, 'create procedure p() begin select 1; select 2; end', 'select 3']);
  });

  it('keeps BEGIN…END bodies of procedures and triggers without DELIMITER', () => {
    const my = `create procedure p() begin if 1 then select 1; end if; select case when 1 then 2 end; end; select 9;`;
    expect(texts(my, 'mysql')).toEqual(['create procedure p() begin if 1 then select 1; end if; select case when 1 then 2 end; end', 'select 9']);
    const lite = `create trigger tr after insert on t begin update t set a = 1; delete from u; end; select 1`;
    expect(texts(lite, 'sqlite')).toEqual(['create trigger tr after insert on t begin update t set a = 1; delete from u; end', 'select 1']);
    expect(texts(`begin transaction; insert into t values (1); commit;`, 'sqlite')).toEqual(['begin transaction', 'insert into t values (1)', 'commit']);
  });

  it('reports offsets and finds the statement at the cursor', () => {
    const sql = 'select 1;\n\nselect 2;';
    const list = splitStatements(sql, 'postgres');
    expect(list[1]).toMatchObject({ start: 11, end: 19 });
    expect(statementAt(sql, 'postgres', 14)?.text).toBe('select 2');
    expect(statementAt(sql, 'postgres', 10)?.text).toBe('select 1');
  });
});

describe('classify', () => {
  const k = (sql: string, d: Parameters<typeof classify>[1] = 'postgres') => classify(sql, d).kind;
  it('recognises reads', () => {
    for (const s of ['select * from t', '(select 1) union (select 2)', 'show tables', 'explain select 1', 'values (1)', "select 'delete from t'", 'with x as (select 1) select * from x', 'describe t'])
      expect(k(s, 'mysql'), s).toBe('read');
    expect(k('pragma table_info(t)', 'sqlite')).toBe('read');
    expect(k("summarize select * from 'x.csv'", 'duckdb')).toBe('read');
    expect(k('copy t to stdout')).toBe('read');
  });

  it('recognises writes and DDL', () => {
    for (const s of ['insert into t values (1)', 'update t set a=1', 'delete from t', 'drop table t', 'create table t(a int)', 'truncate t', 'grant all on t to x', 'call p()', 'vacuum', 'refresh materialized view v'])
      expect(k(s), s).toBe('write');
  });

  it('catches hidden writes', () => {
    expect(k('with d as (delete from t returning *) select * from d')).toBe('write');
    expect(k('select * into newt from t')).toBe('write');
    expect(k('select * from t for update')).toBe('write');
    expect(k('explain analyze delete from t')).toBe('write');
    expect(k('explain (analyze, buffers) select 1')).toBe('read');
    expect(k('set session characteristics as transaction read write')).toBe('write');
    expect(k('set default_transaction_read_only = off')).toBe('write');
    expect(k('begin read write')).toBe('write');
    expect(k('set global max_connections = 10', 'mysql')).toBe('write');
    expect(k('pragma journal_mode = wal', 'sqlite')).toBe('write');
    expect(k('copy t from stdin')).toBe('write');
  });

  it('treats session statements as session', () => {
    expect(k('set search_path to public')).toBe('session');
    expect(k('use db', 'mysql')).toBe('session');
    expect(k('begin')).toBe('session');
    expect(k('commit')).toBe('session');
    expect(k("select 1 into @x", 'mysql')).toBe('read');
    expect(k("select 1 into outfile '/tmp/x'", 'mysql')).toBe('write');
  });

  it('scans whole SQL Server batches', () => {
    expect(k('select 1\nupdate t set a = 1', 'mssql')).toBe('write');
    expect(k('declare @x int = 1; select @x', 'mssql')).toBe('session');
    expect(k('select [update] from t', 'mssql')).toBe('read');
    expect(k('exec sp_who', 'mssql')).toBe('write');
    expect(k('select a into #tmp from t', 'mssql')).toBe('write');
  });

  it('unknown commands default to write', () => {
    expect(k('frobnicate everything')).toBe('write');
  });
});

describe('dialect', () => {
  it('quotes identifiers per dialect', () => {
    expect(quoteIdent('a"b', 'postgres')).toBe('"a""b"');
    expect(quoteIdent('a]b', 'mssql')).toBe('[a]]b]');
    expect(quoteIdent('a`b', 'mysql')).toBe('`a``b`');
    expect(ident('users', 'postgres')).toBe('users');
    expect(ident('Users', 'postgres')).toBe('"Users"');
    expect(ident('order', 'postgres')).toBe('"order"');
    expect(ident('Users', 'mssql')).toBe('Users');
  });
  it('qualifies table names', () => {
    expect(qualified({ schema: 'public', name: 'users' }, 'postgres')).toBe('public.users');
    expect(qualified({ database: 'app', schema: 'dbo', name: 'Users' }, 'mssql')).toBe('app.dbo.Users');
    expect(qualified({ database: 'shop', name: 'orders' }, 'mysql')).toBe('shop.orders');
    expect(qualified({ name: 'x y' }, 'sqlite')).toBe('"x y"');
  });
});
