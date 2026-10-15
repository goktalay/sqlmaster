// Betik yürütücü: ifadelere böler, salt okunur korumasını uygular, her ifadeyi sağlayıcıya akışla çalıştırır.
// Sağlayıcıdan bağımsızdır; arayüze giden olaylar ExecEvent'tir.
import { DEFAULT_BATCH, DEFAULT_LIMIT, type ColumnMeta, type Cell, type IDataSourceConnection } from '../provider';
import { splitStatements } from '../sql/split';
import { classify, type StatementKind } from '../sql/classify';

export interface ExecuteRequest {
  sql: string;
  database?: string;
  limit?: number;
  batchSize?: number;
  /** Bağlantı salt okunur kipte mi */
  readOnly: boolean;
  /** Kullanıcı bu çalıştırma için yazmayı onayladı */
  allowWrite?: boolean;
  /** Hata olunca kalan ifadeleri çalıştırma (varsayılan true) */
  stopOnError?: boolean;
}

export interface BlockedStatement {
  index: number;
  keyword: string;
  text: string;
}

export type ExecEvent =
  | { type: 'statement'; index: number; total: number; text: string; start: number; end: number; kind: StatementKind }
  | { type: 'columns'; index: number; columns: ColumnMeta[] }
  | { type: 'rows'; index: number; rows: Cell[][] }
  | { type: 'end'; index: number; rowCount: number; truncated: boolean; ms: number }
  | { type: 'command'; index: number; rowsAffected: number | null; command: string; ms: number }
  | { type: 'notice'; index: number; message: string }
  | { type: 'error'; index: number; message: string; start?: number; end?: number }
  | { type: 'blocked'; statements: BlockedStatement[] }
  | { type: 'done'; ms: number; cancelled: boolean; errors: number };

const preview = (s: string) => (s.length > 400 ? s.slice(0, 400) + '…' : s);

export async function* executeScript(conn: IDataSourceConnection, req: ExecuteRequest, signal: AbortSignal): AsyncGenerator<ExecEvent> {
  const started = Date.now();
  const dialect = conn.capabilities.dialect;
  const statements = splitStatements(req.sql, dialect);
  const kinds = statements.map((s) => classify(s.text, dialect));

  if (req.readOnly && !req.allowWrite) {
    const blocked = statements
      .map((s, index) => ({ index, keyword: kinds[index].keyword, text: preview(s.text), kind: kinds[index].kind }))
      .filter((x) => x.kind === 'write')
      .map(({ index, keyword, text }) => ({ index, keyword, text }));
    if (blocked.length) {
      yield { type: 'blocked', statements: blocked };
      yield { type: 'done', ms: Date.now() - started, cancelled: false, errors: 0 };
      return;
    }
  }

  const unlock = req.readOnly && req.allowWrite && kinds.some((k) => k.kind === 'write');
  let errors = 0;
  try {
    if (unlock) await conn.setReadOnly(false);
    for (let index = 0; index < statements.length; index++) {
      if (signal.aborted) break;
      const st = statements[index];
      yield { type: 'statement', index, total: statements.length, text: preview(st.text), start: st.start, end: st.end, kind: kinds[index].kind };
      const t0 = Date.now();
      try {
        for await (const ev of conn.query(st.text, {
          database: req.database,
          limit: req.limit ?? DEFAULT_LIMIT,
          batchSize: req.batchSize ?? DEFAULT_BATCH,
          signal,
        })) {
          switch (ev.type) {
            case 'columns': yield { type: 'columns', index, columns: ev.columns }; break;
            case 'rows': yield { type: 'rows', index, rows: ev.rows }; break;
            case 'end': yield { type: 'end', index, rowCount: ev.rowCount, truncated: ev.truncated, ms: Date.now() - t0 }; break;
            case 'command': yield { type: 'command', index, rowsAffected: ev.rowsAffected, command: ev.command, ms: Date.now() - t0 }; break;
            case 'notice': yield { type: 'notice', index, message: ev.message }; break;
          }
          if (signal.aborted) break;
        }
      } catch (e) {
        if (signal.aborted) break;
        errors++;
        yield { type: 'error', index, message: errorMessage(e), start: st.start, end: st.end };
        if (req.stopOnError !== false) break;
      }
    }
  } finally {
    if (unlock) await conn.setReadOnly(true).catch(() => {});
  }
  yield { type: 'done', ms: Date.now() - started, cancelled: signal.aborted, errors };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const x = e as Error & { detail?: string; hint?: string; position?: string; code?: string; number?: number };
    let msg = x.message;
    if (x.detail) msg += `\n${x.detail}`;
    if (x.hint) msg += `\nİpucu: ${x.hint}`;
    return msg;
  }
  return String(e);
}
