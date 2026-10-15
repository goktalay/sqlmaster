// Veritabanı süreci (Electron utilityProcess). Her bağlantı penceresinin kendi süreci vardır:
// sürücüler ana süreci ve arayüzü asla bloklamaz, iptal yanıt vermezse süreç öldürülüp yeniden açılır.
// Parolalar bu sürece yalnızca bellekte gelir; hiçbir yere yazılmaz/loglanmaz.
import type { IDataSourceConnection } from '../core/provider';
import { registerBuiltinProviders } from '../core/providers';
import { openConnection } from '../core/engine/open';
import { errorMessage, executeScript, type ExecEvent } from '../core/engine/executor';
import { exportQuery } from '../core/engine/export';
import type { HostMessage, HostRequest } from '../shared/rpc';

registerBuiltinProviders();

const port = (process as unknown as { parentPort: { on(e: 'message', cb: (m: { data: HostRequest }) => void): void; postMessage(m: HostMessage): void } }).parentPort;
const send = (m: HostMessage) => port.postMessage(m);

let conn: IDataSourceConnection | null = null;
let readOnly = true;
const runs = new Map<string, AbortController>();

// Çalıştırmalar sıraya alınır: bir bağlantıda aynı anda tek sorgu (sürücüler tek oturum kullanır).
// Sırada bekleyen bir çalıştırma iptal edilirse sırası gelince hiç başlamadan "iptal edildi" olarak biter.
let chain: Promise<unknown> = Promise.resolve();
let activeRun: string | null = null;
function serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const p = chain.then(async () => {
    activeRun = runId;
    try {
      return await fn();
    } finally {
      activeRun = null;
    }
  });
  chain = p.catch(() => {});
  return p;
}

const need = () => {
  if (!conn) throw new Error('Bağlantı açık değil');
  return conn;
};

// Betiği sıradaki çalıştırma olarak yürütür; her akış olayı (500 satırlık parçalar) hemen ana sürece gider
async function execute(runId: string, req: Parameters<typeof executeScript>[1]) {
  const ac = new AbortController();
  runs.set(runId, ac);
  return serial(runId, () => executeNow(runId, req, ac));
}

async function executeNow(runId: string, req: Parameters<typeof executeScript>[1], ac: AbortController) {
  let errors = 0;
  let cancelled = false;
  try {
    for await (const ev of executeScript(need(), { ...req, readOnly }, ac.signal)) {
      if (ev.type === 'done') { errors = ev.errors; cancelled = ev.cancelled; }
      send({ runId, event: ev as ExecEvent });
    }
  } finally {
    runs.delete(runId);
  }
  return { errors, cancelled };
}

const handlers: { [K in HostRequest['method']]: (p: Extract<HostRequest, { method: K }>['params']) => Promise<unknown> } = {
  async connect({ cfg }) {
    if (conn) await conn.close().catch(() => {});
    readOnly = cfg.readOnly;
    const opened = await openConnection(cfg);
    conn = opened.conn;
    return { info: await conn.serverInfo(), sshFingerprint: opened.sshFingerprint };
  },
  serverInfo: () => need().serverInfo(),
  children: ({ node }) => need().getChildren(node),
  ddl: ({ node }) => need().getObjectDdl(node),
  columns: ({ path }) => need().getColumns(path),
  completion: ({ database }) => need().getCompletionSchema(database),
  execute: ({ runId, req }) => execute(runId, req),
  async cancel({ runId }) {
    const ac = runs.get(runId);
    if (!ac) return;
    ac.abort();
    if (activeRun === runId) await need().cancel().catch(() => {});
  },
  async export({ runId, sql, database, format, filePath }) {
    const ac = new AbortController();
    runs.set(runId, ac);
    try {
      return await serial(runId, () => exportQuery(need(), sql, { format, filePath, database, signal: ac.signal, onProgress: (rows) => send({ runId, progress: rows }) }));
    } finally {
      runs.delete(runId);
    }
  },
  async setReadOnly({ on }) {
    readOnly = on;
    await need().setReadOnly(on);
  },
  async close() {
    const c = conn;
    conn = null;
    await c?.close();
  },
};

port.on('message', async ({ data }) => {
  const { id, method, params } = data;
  try {
    const result = await (handlers[method] as (p: unknown) => Promise<unknown>)(params);
    send({ id, ok: true, result });
  } catch (e) {
    send({ id, ok: false, error: errorMessage(e), code: (e as { code?: string }).code });
  }
});
