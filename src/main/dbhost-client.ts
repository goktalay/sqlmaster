// Bağlantı penceresi başına bir veritabanı süreci (utilityProcess) ve onunla RPC.
// İptal 5 sn içinde sonuçlanmazsa süreç öldürülür ve bağlantı yeniden kurulur: arayüz asla takılı kalmaz.
import { utilityProcess, type UtilityProcess } from 'electron';
import type { ExecEvent } from '../core/engine/executor';
import type { HostMessage, HostMethod, HostMethods } from '../shared/rpc';
import type { ILogger } from './logger';

export class DbHost {
  private proc: UtilityProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  onEvent: (runId: string, ev: ExecEvent) => void = () => {};
  onProgress: (runId: string, rows: number) => void = () => {};
  onExit: (code: number) => void = () => {};

  constructor(private entry: string, private log: ILogger) {}

  start(): void {
    this.proc = utilityProcess.fork(this.entry, [], { serviceName: 'SQL Master DB', stdio: 'pipe' });
    this.proc.stderr?.on('data', (d) => this.log.warn('dbhost stderr', String(d).slice(0, 2000)));
    this.proc.on('message', (m: HostMessage) => {
      if ('id' in m) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(Object.assign(new Error(m.error), { code: m.code }));
      } else if ('event' in m) this.onEvent(m.runId, m.event);
      else if ('progress' in m) this.onProgress(m.runId, m.progress);
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error('Veritabanı süreci sonlandı'));
      this.pending.clear();
      this.onExit(code);
    });
  }

  get alive(): boolean {
    return !!this.proc;
  }

  request<K extends HostMethod>(method: K, params: Parameters<HostMethods[K]>[0]): Promise<ReturnType<HostMethods[K]>> {
    if (!this.proc) this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.proc!.postMessage({ id, method, params });
    });
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
