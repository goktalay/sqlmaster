// Her sağlayıcı için ortak entegrasyon senaryoları: bağlantı, şema listeleme, sorgu, iptal, salt okunur.
import { expect } from 'vitest';
import type { IDataSourceConnection, TreeNode } from '../../src/core/provider';
import { executeScript, type ExecEvent, type ExecuteRequest } from '../../src/core/engine/executor';

export async function run(conn: IDataSourceConnection, req: Partial<ExecuteRequest> & { sql: string }, signal = new AbortController().signal) {
  const events: ExecEvent[] = [];
  for await (const ev of executeScript(conn, { readOnly: false, ...req }, signal)) events.push(ev);
  return events;
}

export function rowsOf(events: ExecEvent[], index = 0) {
  return events.filter((e): e is Extract<ExecEvent, { type: 'rows' }> => e.type === 'rows' && e.index === index).flatMap((e) => e.rows);
}

export const firstError = (events: ExecEvent[]) => events.find((e): e is Extract<ExecEvent, { type: 'error' }> => e.type === 'error');

/** Ağaçta ada göre düğüm bulana kadar iner */
export async function findPath(conn: IDataSourceConnection, names: string[]): Promise<TreeNode> {
  let parent: TreeNode | null = null;
  for (const n of names) {
    const kids: TreeNode[] = await conn.getChildren(parent);
    const hit = kids.find((k) => k.name === n);
    if (!hit) throw new Error(`"${n}" bulunamadı; mevcut: ${kids.map((k) => k.name).join(', ')}`);
    parent = hit;
  }
  return parent!;
}

/** Uzun süren sorguyu başlatıp iptal eder; iptalin hızlı döndüğünü doğrular */
export async function expectCancel(conn: IDataSourceConnection, longSql: string, limit?: number) {
  const ac = new AbortController();
  const started = Date.now();
  const p = run(conn, { sql: longSql, limit }, ac.signal);
  await new Promise((r) => setTimeout(r, 700));
  ac.abort();
  await conn.cancel();
  const events = await p;
  const ms = Date.now() - started;
  expect(ms).toBeLessThan(10_000);
  const done = events.find((e) => e.type === 'done') as Extract<ExecEvent, { type: 'done' }>;
  expect(done.cancelled).toBe(true);
  // Bağlantı iptalden sonra kullanılabilir kalmalı
  const after = await run(conn, { sql: 'select 1 as x' });
  expect(rowsOf(after)).toEqual([[1]]);
}
