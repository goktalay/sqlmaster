// Entegrasyon testleri için hafif Docker yardımcıları (testcontainers yerine doğrudan docker CLI).
// Docker yoksa testler atlanır ve nedeni yazdırılır.
import { execFileSync, spawnSync } from 'node:child_process';

export function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  return r.status === 0;
}

export interface Container {
  id: string;
  host: string;
  port: number;
  stop(): void;
}

export function startContainer(image: string, opts: { port: number; env?: Record<string, string>; args?: string[]; cmd?: string[] }): Container {
  const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const id = execFileSync('docker', ['run', '-d', '--rm', '-p', `127.0.0.1::${opts.port}`, ...env, ...(opts.args ?? []), image, ...(opts.cmd ?? [])], { encoding: 'utf8' }).trim();
  const out = execFileSync('docker', ['port', id, String(opts.port)], { encoding: 'utf8' }).trim().split('\n')[0];
  const port = Number(out.split(':').pop());
  return { id, host: '127.0.0.1', port, stop: () => spawnSync('docker', ['rm', '-f', id]) };
}

/** fn başarılı olana kadar dener (veritabanının açılmasını beklemek için) */
export async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 120_000, stepMs = 1000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Docker yoksa ya da SQLM_EXTERNAL_<NAME> ile dış sunucu verilmişse kullanılacak bağlantı */
export function externalTarget(name: string): { host: string; port: number; user: string; password: string; database: string } | null {
  const v = process.env[`SQLM_EXTERNAL_${name}`];
  if (!v) return null;
  const u = new URL(v);
  return { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
}
