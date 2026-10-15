// Sonuç paneli: her sonuç kümesi için bir sekme + Mesajlar sekmesi. Akış olaylarını ızgaraya aktarır.
import type { ColumnMeta, Cell } from '../../core/provider';
import type { BlockedStatement, ExecEvent } from '../../core/engine/executor';
import { contextMenu, esc, formatNumber, h, icon, t } from '../lib/ui';
import { Grid } from './grid';

interface ResultSet {
  /** Benzersiz anahtar: bir ifade (ör. SQL Server partisi) birden çok sonuç kümesi döndürebilir */
  key: number;
  index: number;
  statement: string;
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
  done: boolean;
}

export interface RunSummary {
  results: number;
  errors: number;
  cancelled: boolean;
  ms: number;
  blocked: BlockedStatement[] | null;
  firstError: { message: string; start?: number; end?: number } | null;
}

export class ResultsPanel {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private bodyEl: HTMLElement;
  private grid: Grid;
  private messagesEl: HTMLElement;
  private sets: ResultSet[] = [];
  private active: number | 'messages' = 'messages';
  private summary: RunSummary = this.emptySummary();
  /** Satır gelince ızgarayı yeniden çizmeyi seyrekleştir */
  private pendingRender = false;
  private stmts = new Map<number, string>();
  private seq = 0;
  private last = (index: number) => [...this.sets].reverse().find((s) => s.index === index);
  private source = '';
  onExport: ((statement: string) => void) | null = null;

  constructor() {
    this.el = h(`<div class="results">
      <div class="res-tabs"></div>
      <div class="res-body"><div class="res-messages hidden"></div></div>
    </div>`);
    this.tabsEl = this.el.querySelector('.res-tabs')!;
    this.bodyEl = this.el.querySelector('.res-body')!;
    this.messagesEl = this.el.querySelector('.res-messages')!;
    this.grid = new Grid({
      onCellMenu: (_c, _v, x, y) => contextMenu(x, y, [
        { label: t('grid.copy'), icon: 'copy', kbd: 'Ctrl+C', action: () => void this.grid.copySelection(false) },
        { label: t('grid.copyHeaders'), icon: 'copy', action: () => void this.grid.copySelection(true) },
        this.onExport && { label: t('grid.export'), icon: 'exportFile', action: () => this.onExport!(this.currentStatement()) },
      ]),
    });
    this.bodyEl.prepend(this.grid.el);
    this.renderTabs();
    this.show('messages');
  }

  private emptySummary(): RunSummary {
    return { results: 0, errors: 0, cancelled: false, ms: 0, blocked: null, firstError: null };
  }

  /** Çalıştırılan betik: ifade metinleri konumlarından tam olarak alınır (dışa aktarım için) */
  reset(source = '') {
    this.source = source;
    this.stmts.clear();
    this.sets = [];
    this.messagesEl.innerHTML = '';
    this.summary = this.emptySummary();
    this.active = 'messages';
    this.grid.setData([], []);
    this.renderTabs();
    this.show('messages');
  }

  currentStatement(): string {
    const s = this.sets.find((x) => x.key === this.active);
    return s?.statement ?? '';
  }

  message(kind: 'ok' | 'err' | 'info' | 'warn', text: string) {
    const time = new Date().toLocaleTimeString();
    const icn = kind === 'ok' ? 'check' : kind === 'err' ? 'x' : kind === 'warn' ? 'info' : 'info';
    this.messagesEl.appendChild(h(`<div class="msg ${kind}">${icon(icn)}<span class="msg-time">${esc(time)}</span><pre>${esc(text)}</pre></div>`));
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  handle(ev: ExecEvent): void {
    switch (ev.type) {
      case 'statement':
        this.stmts.set(ev.index, this.source ? this.source.slice(ev.start, ev.end) : ev.text);
        break;
      case 'columns': {
        const set: ResultSet = { key: ++this.seq, index: ev.index, statement: this.stmts.get(ev.index) ?? '', columns: ev.columns, rows: [], rowCount: 0, truncated: false, ms: 0, done: false };
        this.sets.push(set);
        this.summary.results++;
        this.renderTabs();
        if (this.sets.length === 1) this.show(set.key);
        break;
      }
      case 'rows': {
        const set = this.last(ev.index);
        if (!set) break;
        for (const r of ev.rows) set.rows.push(r);
        set.rowCount = set.rows.length;
        if (this.active === set.key) this.grid.appendRows(ev.rows);
        this.scheduleTabs();
        break;
      }
      case 'end': {
        const set = this.last(ev.index);
        if (set) Object.assign(set, { truncated: ev.truncated, ms: ev.ms, done: true, rowCount: ev.rowCount });
        this.message('ok', t(ev.truncated ? 'res.rowsTruncated' : 'res.rows', { n: formatNumber(ev.rowCount), ms: ev.ms }));
        if (set && !set.rows.length && this.active === set.key) this.grid.showEmpty(t('res.noRows'));
        this.renderTabs();
        break;
      }
      case 'command':
        this.message('ok', ev.rowsAffected !== null ? t('res.affected', { cmd: ev.command, n: formatNumber(ev.rowsAffected), ms: ev.ms }) : t('res.command', { cmd: ev.command, ms: ev.ms }));
        break;
      case 'notice':
        this.message('info', ev.message);
        break;
      case 'error':
        this.summary.errors++;
        this.summary.firstError ??= { message: ev.message, start: ev.start, end: ev.end };
        this.message('err', ev.message);
        if (!this.sets.length) this.show('messages');
        break;
      case 'blocked':
        this.summary.blocked = ev.statements;
        break;
      case 'done':
        this.summary.cancelled = ev.cancelled;
        this.summary.ms = ev.ms;
        if (ev.cancelled) this.message('warn', t('res.cancelled'));
        if (!this.sets.length || this.summary.errors) this.show(this.summary.errors && !this.sets.length ? 'messages' : this.active);
        break;
    }
  }

  get result(): RunSummary {
    return this.summary;
  }

  private scheduleTabs() {
    if (this.pendingRender) return;
    this.pendingRender = true;
    setTimeout(() => { this.pendingRender = false; this.renderTabs(); }, 150);
  }

  private renderTabs() {
    this.tabsEl.innerHTML = '';
    this.sets.forEach((s, i) => {
      const b = h(`<button class="res-tab ${this.active === s.key ? 'on' : ''}">${icon('table')}${esc(t('res.result', { n: i + 1 }))}
        <span class="res-count">${formatNumber(s.rowCount)}${s.truncated ? '+' : ''}</span></button>`);
      b.onclick = () => this.show(s.key);
      this.tabsEl.appendChild(b);
    });
    const m = h(`<button class="res-tab ${this.active === 'messages' ? 'on' : ''}">${icon('info')}${esc(t('res.messages'))}${this.summary.errors ? `<span class="res-count err">${this.summary.errors}</span>` : ''}</button>`);
    m.onclick = () => this.show('messages');
    this.tabsEl.appendChild(m);
  }

  private show(which: number | 'messages') {
    this.active = which;
    const isMsg = which === 'messages';
    this.messagesEl.classList.toggle('hidden', !isMsg);
    this.grid.el.classList.toggle('hidden', isMsg);
    if (!isMsg) {
      const s = this.sets.find((x) => x.key === which);
      this.grid.setData(s?.columns ?? [], s ? [...s.rows] : []);
      this.grid.showEmpty(s && s.done && !s.rows.length ? t('res.noRows') : null);
    }
    this.renderTabs();
  }
}
