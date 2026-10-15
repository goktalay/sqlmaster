// Sorgu çalıştırma istemcisi: ana süreçten gelen akış olaylarını çalıştırma kimliğine göre dağıtır.
import type { ExecEvent, ExecuteRequest } from '../../core/engine/executor';
import { api } from '../lib/api';
import { uid } from '../lib/ui';

type Handler = (ev: ExecEvent) => void;
const handlers = new Map<string, Handler>();
const progress = new Map<string, (rows: number) => void>();

api.onDbEvent(({ runId, ev }) => handlers.get(runId)?.(ev));
api.onDbProgress(({ runId, rows }) => progress.get(runId)?.(rows));

export interface RunHandle {
  runId: string;
  done: Promise<{ errors: number; cancelled: boolean }>;
  cancel(): void;
}

// Not: invoke yanıtı, öncesinde gönderilen büyük "rows" olaylarını geçebilir (Electron IPC sıralama garantisi vermez).
// Bu yüzden çalıştırmanın bitişi akıştaki "done" olayıyla belirlenir; invoke yalnızca hata için beklenir.
export function runSql(req: Omit<ExecuteRequest, 'readOnly'>, onEvent: Handler): RunHandle {
  const runId = uid();
  const done = new Promise<{ errors: number; cancelled: boolean }>((resolve, reject) => {
    let finished = false;
    handlers.set(runId, (ev) => {
      onEvent(ev);
      if (ev.type === 'done') {
        finished = true;
        handlers.delete(runId);
        resolve({ errors: ev.errors, cancelled: ev.cancelled });
      }
    });
    api.dbExecute({ runId, req }).then(
      (r) => {
        // "done" olayı gecikirse en fazla 10 sn bekle
        setTimeout(() => { if (!finished) { handlers.delete(runId); resolve(r); } }, 10_000);
      },
      (e) => { handlers.delete(runId); reject(e); },
    );
  });
  return { runId, done, cancel: () => void api.dbCancel(runId) };
}

export function exportSql(p: { sql: string; database?: string; format: 'csv' | 'tsv' | 'jsonl' | 'json'; defaultName: string }, onProgress: (rows: number) => void) {
  const runId = uid();
  progress.set(runId, onProgress);
  const done = api.dbExport({ runId, ...p }).finally(() => progress.delete(runId));
  return { runId, done, cancel: () => void api.dbCancel(runId) };
}
