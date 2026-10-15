// Sorgu sonucunu belleğe almadan dosyaya akıtır (CSV / TSV / JSON Lines / JSON).
// Satırlar 500'lük parçalarla gelir, yazma akışının geri basıncı beklenir: 500k+ satır sabit bellekle yazılır.
import fs from 'node:fs';
import { once } from 'node:events';
import type { Cell, ColumnMeta, IDataSourceConnection } from '../provider';

export type ExportFormat = 'csv' | 'tsv' | 'jsonl' | 'json';

export interface ExportResult {
  rows: number;
  bytes: number;
  cancelled: boolean;
}

function csvCell(v: Cell, sep: string): string {
  if (v === null) return '';
  const s = String(v);
  return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportQuery(
  conn: IDataSourceConnection,
  sql: string,
  opts: { format: ExportFormat; filePath: string; database?: string; signal: AbortSignal; onProgress?: (rows: number) => void },
): Promise<ExportResult> {
  const out = fs.createWriteStream(opts.filePath, { encoding: 'utf8' });
  const write = async (s: string) => {
    if (!out.write(s)) await once(out, 'drain');
  };
  let columns: ColumnMeta[] = [];
  let rows = 0;
  let firstJson = true;
  const sep = opts.format === 'tsv' ? '\t' : ',';
  try {
    if (opts.format === 'csv') await write('﻿'); // Excel'in UTF-8 algılaması için BOM
    if (opts.format === 'json') await write('[');
    for await (const ev of conn.query(sql, { database: opts.database, limit: 0, batchSize: 500, signal: opts.signal })) {
      if (ev.type === 'columns') {
        columns = ev.columns;
        if (opts.format === 'csv' || opts.format === 'tsv') await write(columns.map((c) => csvCell(c.name, sep)).join(sep) + '\r\n');
      } else if (ev.type === 'rows') {
        let chunk = '';
        for (const r of ev.rows) {
          if (opts.format === 'csv' || opts.format === 'tsv') chunk += r.map((v) => csvCell(v, sep)).join(sep) + '\r\n';
          else {
            const obj: Record<string, Cell> = {};
            columns.forEach((c, i) => (obj[c.name] = r[i]));
            chunk += opts.format === 'jsonl' ? JSON.stringify(obj) + '\n' : (firstJson ? '\n' : ',\n') + JSON.stringify(obj);
            firstJson = false;
          }
        }
        rows += ev.rows.length;
        await write(chunk);
        opts.onProgress?.(rows);
      }
      if (opts.signal.aborted) break;
    }
    if (opts.format === 'json') await write('\n]\n');
  } finally {
    out.end();
    await once(out, 'close').catch(() => {});
  }
  return { rows, bytes: out.bytesWritten, cancelled: opts.signal.aborted };
}
