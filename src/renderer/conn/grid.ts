// Sanal kaydırmalı sonuç ızgarası: yalnızca görünen satırlar çizilir (10.000+ satırda akıcı).
// Kolon genişliği sürükleyerek, hücre/aralık seçimi, Ctrl+C ile sekmeli kopyalama, başlık tıklamasıyla sıralama.
import type { Cell, ColumnMeta } from '../../core/provider';
import { esc, h, icon, t } from '../lib/ui';
import { api } from '../lib/api';

const ROW_H = 26;
const OVERSCAN = 12;
const NUM_W = 54;

export type SortDir = 'asc' | 'desc' | null;

export interface GridOptions {
  /** Başlık tıklanınca: verilmezse ızgara istemci tarafında sıralar */
  onSort?: (column: string, dir: SortDir) => void;
  onHeaderMenu?: (column: ColumnMeta, x: number, y: number) => void;
  onCellMenu?: (column: ColumnMeta, value: Cell, x: number, y: number) => void;
}

export class Grid {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private spacer: HTMLElement;
  private rowsEl: HTMLElement;
  private columns: ColumnMeta[] = [];
  private rows: Cell[][] = [];
  private view: number[] = []; // istemci sıralaması için satır indeksleri
  private widths: number[] = [];
  private sort: { col: number; dir: SortDir } = { col: -1, dir: null };
  private sel: { r1: number; c1: number; r2: number; c2: number } | null = null;
  private raf = 0;

  constructor(private opts: GridOptions = {}) {
    this.el = h(`<div class="grid-wrap" tabindex="0">
      <div class="grid-head"></div>
      <div class="grid-body"><div class="grid-spacer"></div><div class="grid-rows"></div></div>
      <div class="grid-empty hidden"></div>
    </div>`);
    this.head = this.el.querySelector('.grid-head')!;
    this.body = this.el.querySelector('.grid-body')!;
    this.spacer = this.el.querySelector('.grid-spacer')!;
    this.rowsEl = this.el.querySelector('.grid-rows')!;
    this.body.addEventListener('scroll', () => {
      this.head.scrollLeft = this.body.scrollLeft;
      this.schedule();
    });
    new ResizeObserver(() => this.schedule()).observe(this.body);
    this.rowsEl.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.rowsEl.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.rowsEl.addEventListener('contextmenu', (e) => this.onContext(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  setSortIndicator(column: string | null, dir: SortDir) {
    this.sort = { col: column ? this.columns.findIndex((c) => c.name === column) : -1, dir };
    this.renderHead();
  }

  setData(columns: ColumnMeta[], rows: Cell[][] = []) {
    const keep = columns.length === this.columns.length && columns.every((c, i) => c.name === this.columns[i]?.name);
    this.columns = columns;
    this.rows = rows;
    if (!keep) {
      this.widths = columns.map((c) => this.guessWidth(c, rows));
      if (!this.opts.onSort) this.sort = { col: -1, dir: null };
    }
    this.sel = null;
    this.rebuildView();
    this.renderHead();
    this.body.scrollTop = 0;
    this.schedule();
  }

  appendRows(rows: Cell[][]) {
    const start = this.rows.length;
    for (const r of rows) this.rows.push(r);
    if (start === 0 && rows.length) this.widths = this.columns.map((c) => this.guessWidth(c, this.rows));
    if (this.sort.dir && !this.opts.onSort) this.rebuildView();
    else for (let i = start; i < this.rows.length; i++) this.view.push(i);
    if (start === 0) this.renderHead();
    this.schedule();
  }

  get rowCount() {
    return this.rows.length;
  }

  showEmpty(text: string | null) {
    const e = this.el.querySelector('.grid-empty')!;
    e.textContent = text ?? '';
    e.classList.toggle('hidden', !text);
  }

  private guessWidth(c: ColumnMeta, rows: Cell[][]): number {
    const i = this.columns.indexOf(c);
    let max = c.name.length + 3;
    for (let r = 0; r < Math.min(rows.length, 60); r++) {
      const v = rows[r][i];
      const len = v === null ? 4 : String(v).length;
      if (len > max) max = len;
    }
    return Math.max(70, Math.min(360, max * 7.4 + 22));
  }

  private rebuildView() {
    this.view = this.rows.map((_r, i) => i);
    const { col, dir } = this.sort;
    if (col < 0 || !dir || this.opts.onSort) return;
    const numeric = this.columns[col]?.numeric;
    const f = dir === 'asc' ? 1 : -1;
    this.view.sort((a, b) => {
      const x = this.rows[a][col];
      const y = this.rows[b][col];
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (numeric) return (Number(x) - Number(y)) * f;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * f;
    });
  }

  private template() {
    return `${NUM_W}px ${this.widths.map((w) => `${w}px`).join(' ')}`;
  }

  private renderHead() {
    const total = NUM_W + this.widths.reduce((a, b) => a + b, 0);
    this.head.innerHTML = '';
    const row = h(`<div class="grid-hrow" style="grid-template-columns:${this.template()};width:${total}px"><div class="gh num">#</div></div>`);
    this.columns.forEach((c, i) => {
      const sorted = this.sort.col === i && this.sort.dir;
      const cell = h(`<div class="gh ${c.numeric ? 'num-col' : ''} ${sorted ? 'sorted' : ''}" title="${esc(c.name)} · ${esc(c.type)}">
        <span class="gh-name">${esc(c.name)}</span>${sorted ? icon(this.sort.dir === 'asc' ? 'sortAsc' : 'sortDesc') : ''}<span class="gh-type">${esc(c.type)}</span>
        <span class="gh-resize"></span></div>`);
      cell.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('gh-resize')) return;
        const dir: SortDir = this.sort.col !== i ? 'asc' : this.sort.dir === 'asc' ? 'desc' : this.sort.dir === 'desc' ? null : 'asc';
        this.sort = { col: dir ? i : -1, dir };
        if (this.opts.onSort) this.opts.onSort(c.name, dir);
        else { this.rebuildView(); this.schedule(); }
        this.renderHead();
      });
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); this.opts.onHeaderMenu?.(c, e.clientX, e.clientY); });
      cell.querySelector('.gh-resize')!.addEventListener('mousedown', (e) => this.startResize(e as MouseEvent, i));
      row.appendChild(cell);
    });
    this.head.appendChild(row);
    this.spacer.style.width = `${total}px`;
  }

  private startResize(e: MouseEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = this.widths[i];
    document.body.classList.add('resizing-col');
    const move = (ev: MouseEvent) => {
      this.widths[i] = Math.max(40, w0 + ev.clientX - x0);
      this.renderHead();
      this.render();
    };
    const up = () => {
      document.body.classList.remove('resizing-col');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render() {
    const n = this.view.length;
    this.spacer.style.height = `${n * ROW_H}px`;
    const top = this.body.scrollTop;
    const height = this.body.clientHeight || 400;
    const from = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const to = Math.min(n, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    const tpl = this.template();
    const total = NUM_W + this.widths.reduce((a, b) => a + b, 0);
    let html = '';
    for (let v = from; v < to; v++) {
      const r = this.view[v];
      const row = this.rows[r];
      let cells = `<div class="gc num">${v + 1}</div>`;
      for (let c = 0; c < this.columns.length; c++) {
        const val = row[c];
        const selected = this.sel && v >= Math.min(this.sel.r1, this.sel.r2) && v <= Math.max(this.sel.r1, this.sel.r2) && c >= Math.min(this.sel.c1, this.sel.c2) && c <= Math.max(this.sel.c1, this.sel.c2);
        const cls = `gc${this.columns[c].numeric ? ' num-col' : ''}${val === null ? ' null' : ''}${selected ? ' sel' : ''}`;
        const text = val === null ? 'NULL' : typeof val === 'string' && val.length > 300 ? val.slice(0, 300) + '…' : String(val);
        cells += `<div class="${cls}" data-c="${c}">${esc(text)}</div>`;
      }
      html += `<div class="grid-row${v % 2 ? ' alt' : ''}" data-v="${v}" style="top:${v * ROW_H}px;grid-template-columns:${tpl};width:${total}px">${cells}</div>`;
    }
    this.rowsEl.innerHTML = html;
  }

  private hit(e: MouseEvent): { v: number; c: number } | null {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.gc');
    const row = (e.target as HTMLElement).closest<HTMLElement>('.grid-row');
    if (!cell || !row) return null;
    return { v: Number(row.dataset.v), c: cell.dataset.c === undefined ? -1 : Number(cell.dataset.c) };
  }

  private onMouseDown(e: MouseEvent) {
    const p = this.hit(e);
    if (!p) return;
    this.el.focus({ preventScroll: true });
    if (p.c < 0) {
      // satır numarası: tüm satırı seç
      this.sel = e.shiftKey && this.sel ? { ...this.sel, r2: p.v, c1: 0, c2: this.columns.length - 1 } : { r1: p.v, r2: p.v, c1: 0, c2: this.columns.length - 1 };
    } else if (e.shiftKey && this.sel) this.sel = { ...this.sel, r2: p.v, c2: p.c };
    else if (e.button === 0 || !this.sel) this.sel = { r1: p.v, c1: p.c, r2: p.v, c2: p.c };
    this.render();
    if (e.button !== 0 || p.c < 0 || e.shiftKey) return;
    const move = (ev: MouseEvent) => {
      const q = this.hit(ev);
      if (q && q.c >= 0 && this.sel) { this.sel.r2 = q.v; this.sel.c2 = q.c; this.schedule(); }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private onDblClick(e: MouseEvent) {
    const p = this.hit(e);
    if (!p || p.c < 0) return;
    const val = this.rows[this.view[p.v]][p.c];
    showValue(this.columns[p.c], val);
  }

  private onContext(e: MouseEvent) {
    e.preventDefault();
    const p = this.hit(e);
    if (!p || p.c < 0) return;
    const inSel = this.sel && p.v >= Math.min(this.sel.r1, this.sel.r2) && p.v <= Math.max(this.sel.r1, this.sel.r2) && p.c >= Math.min(this.sel.c1, this.sel.c2) && p.c <= Math.max(this.sel.c1, this.sel.c2);
    if (!inSel) { this.sel = { r1: p.v, c1: p.c, r2: p.v, c2: p.c }; this.render(); }
    this.opts.onCellMenu?.(this.columns[p.c], this.rows[this.view[p.v]][p.c], e.clientX, e.clientY);
  }

  private onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); void this.copySelection(false); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.sel = { r1: 0, c1: 0, r2: this.view.length - 1, c2: this.columns.length - 1 };
      this.render();
    }
  }

  /** Seçimi sekmeyle ayrılmış metin olarak panoya kopyalar (başlıklarla isteğe bağlı) */
  async copySelection(withHeaders: boolean) {
    if (!this.sel || !this.view.length) return;
    const r1 = Math.min(this.sel.r1, this.sel.r2), r2 = Math.max(this.sel.r1, this.sel.r2);
    const c1 = Math.min(this.sel.c1, this.sel.c2), c2 = Math.max(this.sel.c1, this.sel.c2);
    const lines: string[] = [];
    if (withHeaders) lines.push(this.columns.slice(c1, c2 + 1).map((c) => c.name).join('\t'));
    for (let v = r1; v <= r2; v++) {
      const row = this.rows[this.view[v]];
      lines.push(row.slice(c1, c2 + 1).map((x) => (x === null ? '' : String(x).replace(/[\t\n\r]+/g, ' '))).join('\t'));
    }
    await api.clipboardWrite(lines.join('\n'));
  }

  /** Seçili satırlar INSERT ifadesi olarak (basit) */
  selectedRows(): Cell[][] {
    if (!this.sel) return [];
    const r1 = Math.min(this.sel.r1, this.sel.r2), r2 = Math.max(this.sel.r1, this.sel.r2);
    return this.view.slice(r1, r2 + 1).map((i) => this.rows[i]);
  }

  get allColumns() {
    return this.columns;
  }
}

function showValue(col: ColumnMeta, val: Cell) {
  let text = val === null ? 'NULL' : String(val);
  if (typeof val === 'string' && /^[[{]/.test(val.trim())) {
    try { text = JSON.stringify(JSON.parse(val), null, 2); } catch { /* JSON değil */ }
  }
  const back = h(`<div class="modal-backdrop"><div class="modal" style="width:min(720px,calc(100vw - 32px))">
    <header><span style="color:var(--accent)">${icon('column')}</span><h2>${esc(col.name)} <small style="color:var(--text-3);font-weight:400">${esc(col.type)}</small></h2></header>
    <div class="body"><textarea class="input value-view" readonly spellcheck="false">${esc(text)}</textarea></div>
    <footer><span class="spacer"></span><button class="btn" data-a="copy">${icon('copy')}${esc(t('common.copy'))}</button><button class="btn primary" data-a="close">${esc(t('common.close'))}</button></footer>
  </div></div>`);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector<HTMLElement>('[data-a="close"]')!.onclick = close;
  back.querySelector<HTMLElement>('[data-a="copy"]')!.onclick = () => void api.clipboardWrite(val === null ? '' : String(val));
  document.body.appendChild(back);
}
