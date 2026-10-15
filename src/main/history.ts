// Sorgu geçmişi (userData/history.jsonl). SQL metnindeki parola kalıpları maskelenir; bağlantı dizesi tutulmaz.
import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry } from '../shared/types';
import { redact } from './logger';

const MAX_ENTRIES = 5000;
const MAX_SQL = 20_000;

export class History {
  constructor(private file: string) {}

  add(e: HistoryEntry): void {
    const entry = { ...e, sql: redact(e.sql).slice(0, MAX_SQL) };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* önemsiz */ }
  }

  list(connectionId: string, limit = 200): HistoryEntry[] {
    let lines: string[] = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    if (lines.length > MAX_ENTRIES * 1.5) {
      lines = lines.slice(-MAX_ENTRIES);
      try { fs.writeFileSync(this.file, lines.join('\n') + '\n', 'utf8'); } catch { /* önemsiz */ }
    }
    const out: HistoryEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]) as HistoryEntry;
        if (e.connectionId === connectionId) out.push(e);
      } catch { /* bozuk satır */ }
    }
    return out;
  }
}
