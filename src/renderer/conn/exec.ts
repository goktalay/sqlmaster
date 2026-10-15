// Ortak çalıştırma akışı: salt okunur engeli gelirse kullanıcıya hangi ifadelerin yazdığını gösterir,
// onay verilirse yalnızca bu çalıştırma için yazmaya izin vererek yeniden dener.
import type { BlockedStatement, ExecEvent } from '../../core/engine/executor';
import { esc, openModal, t } from '../lib/ui';
import { runSql, type RunHandle } from './runner';
import type { ResultsPanel, RunSummary } from './results';

export async function confirmWrite(blocked: BlockedStatement[]): Promise<boolean> {
  const list = blocked.slice(0, 8).map((b) => `<li><b>${esc(b.keyword)}</b> <code>${esc(b.text.split('\n')[0].slice(0, 120))}</code></li>`).join('');
  const more = blocked.length > 8 ? `<li>… +${blocked.length - 8}</li>` : '';
  const r = await openModal<boolean>({
    title: t('ro.title'), iconName: 'lock', width: 600,
    body: `<div style="color:var(--text-2);line-height:1.55">${esc(t('ro.message'))}<ul class="ro-list">${list}${more}</ul>${esc(t('ro.hint'))}</div>`,
    buttons: [
      { label: t('common.giveUp'), value: false },
      { label: t('ro.runOnce'), cls: 'primary danger-primary', value: true },
    ],
  });
  return !!r;
}

export interface ExecOptions {
  sql: string;
  database?: string;
  limit?: number;
  panel: ResultsPanel;
  onStart?: (h: RunHandle) => void;
  onEvent?: (ev: ExecEvent) => void;
}

/** Betiği çalıştırır; salt okunur engelinde onay ister. */
export async function execute(o: ExecOptions): Promise<RunSummary> {
  let allowWrite = false;
  for (;;) {
    o.panel.reset(o.sql);
    const h = runSql({ sql: o.sql, database: o.database, limit: o.limit, allowWrite }, (ev) => {
      o.panel.handle(ev);
      o.onEvent?.(ev);
    });
    o.onStart?.(h);
    try {
      await h.done;
    } catch (e) {
      o.panel.message('err', (e as Error).message);
      return { ...o.panel.result, errors: o.panel.result.errors + 1 };
    }
    const res = o.panel.result;
    if (res.blocked && !allowWrite) {
      o.panel.message('warn', t('ro.blockedMsg', { n: res.blocked.length }));
      if (!(await confirmWrite(res.blocked))) return res;
      res.blocked = null;
      allowWrite = true;
      continue;
    }
    return res;
  }
}
