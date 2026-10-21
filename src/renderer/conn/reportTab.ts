// Rapor tasarım sekmesi: solda ayarlar (veri/SQL, düzen, başlık, sayfa, kolonlar), sağda canlı baskı önizlemesi.
// Önizleme, yazdırma ve PDF aynı HTML'i kullanır (core/report/render.ts); sorgu salt okunur korumasıyla çalışır.
import type { Cell, ColumnMeta } from '../../core/provider';
import { ALIGNS, FORMATS, LAYOUTS, PAGE_SIZES, reconcileColumns, TOTALS, type ReportColumn, type ReportDef } from '../../core/report/model';
import { renderReport, type ReportData } from '../../core/report/render';
import { api } from '../lib/api';
import { $, $$, esc, formatNumber, h, icon, t, toast } from '../lib/ui';
import type { Ctx, Tab } from './context';
import { createSqlEditor } from './editor';
import { renderBase } from './reports';
import { runSql, type RunHandle } from './runner';
import { splitter } from './split';

const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CNY', 'RUB', 'SAR', 'AED'];

const opt = (v: string, label: string, sel: boolean) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;

export function createReportTab(ctx: Ctx, initial: ReportDef, hooks: { onSaved(d: ReportDef): void; onDelete(d: ReportDef): Promise<boolean> }): Tab {
  let def: ReportDef = structuredClone(initial);
  let saved = JSON.stringify(initial);
  let data: ReportData | null = null;
  let running: RunHandle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const el = h(`<div class="ws report-tab">
    <div class="toolbar">
      <input class="input sm rp-name" data-a="name" maxlength="200" spellcheck="false">
      <button class="btn sm primary" data-a="run">${icon('play')}${esc(t('rep.run'))}</button>
      <button class="btn sm danger hidden" data-a="cancel">${icon('stop')}${esc(t('sql.cancel'))}</button>
      <button class="btn sm" data-a="save" title="Ctrl+S">${icon('save')}${esc(t('rep.save'))}</button>
      <span class="tb-sep"></span>
      <button class="btn sm" data-a="print" title="Ctrl+P">${icon('print')}${esc(t('rep.print'))}</button>
      <button class="btn sm" data-a="pdf">${icon('pdf')}${esc(t('rep.pdf'))}</button>
      <span class="grow"></span>
      <span class="tb-status" data-a="status"></span>
      <button class="icon-btn" data-a="delete" title="${esc(t('rep.delete'))}">${icon('trash')}</button>
    </div>
    <div class="rp-body">
      <aside class="rp-side">
        <details class="rp-sec" open><summary>${icon('sql')}${esc(t('rep.secData'))}</summary>
          <select class="input sm" data-k="database"></select>
          <div class="rp-sql"></div>
        </details>
        <details class="rp-sec" open><summary>${icon('columns')}${esc(t('rep.secLayout'))}</summary>
          <div class="seg rp-layouts">${LAYOUTS.map((l) => `<button data-layout="${l}">${esc(t(`rep.layout.${l}`))}</button>`).join('')}</div>
          <div class="field rp-groupby"><label>${esc(t('rep.groupBy'))}</label><select class="input sm" data-k="groupBy"></select></div>
          <div class="field rp-cardtitle"><label>${esc(t('rep.cardTitle'))}</label><select class="input sm" data-k="cardTitle"></select></div>
          <label class="rp-chk"><input type="checkbox" data-k="zebra">${esc(t('rep.zebra'))}</label>
          <label class="rp-chk"><input type="checkbox" data-k="showRowNumbers">${esc(t('rep.rowNumbers'))}</label>
        </details>
        <details class="rp-sec" open><summary>${icon('edit')}${esc(t('rep.secHeader'))}</summary>
          <div class="field"><label>${esc(t('rep.title'))}</label><input class="input sm" data-k="title" maxlength="300"></div>
          <div class="field"><label>${esc(t('rep.subtitle'))}</label><input class="input sm" data-k="subtitle" maxlength="500"></div>
          <div class="field"><label>${esc(t('rep.footer'))}</label><input class="input sm" data-k="footer" maxlength="500"></div>
          <label class="rp-chk"><input type="checkbox" data-k="showDate">${esc(t('rep.showDate'))}</label>
          <label class="rp-chk"><input type="checkbox" data-k="showPageNumbers">${esc(t('rep.pageNumbers'))}</label>
        </details>
        <details class="rp-sec"><summary>${icon('file2')}${esc(t('rep.secPage'))}</summary>
          <div class="rp-grid2">
            <div class="field"><label>${esc(t('rep.pageSize'))}</label><select class="input sm" data-k="page.size">${PAGE_SIZES.map((p) => opt(p, p, false)).join('')}</select></div>
            <div class="field"><label>${esc(t('rep.margin'))}</label><input class="input sm" type="number" min="0" max="50" data-k="page.margin"></div>
          </div>
          <div class="seg rp-orient"><button data-orient="portrait">${esc(t('rep.portrait'))}</button><button data-orient="landscape">${esc(t('rep.landscape'))}</button></div>
          <div class="field"><label>${esc(t('rep.currency'))}</label><select class="input sm" data-k="currency">${CURRENCIES.map((c) => opt(c, c, false)).join('')}</select></div>
        </details>
        <details class="rp-sec" open><summary>${icon('column')}${esc(t('rep.secColumns'))}</summary>
          <div class="rp-cols"></div>
        </details>
      </aside>
      <div class="vsplit"></div>
      <div class="rp-preview">
        <iframe sandbox="allow-same-origin" title="preview"></iframe>
        <div class="rp-empty hidden"></div>
      </div>
    </div>
  </div>`);

  const status = $('[data-a="status"]', el);
  const frame = $<HTMLIFrameElement>('iframe', el);
  const emptyNote = $('.rp-empty', el);
  splitter($('.vsplit', el), $('.rp-side', el), 'x', 0.32);

  const tab: Tab = {
    id: `report:${def.id}`,
    title: def.name,
    icon: 'report',
    el,
    dirty: () => JSON.stringify(def) !== saved,
    onClose: () => { running?.cancel(); editor.destroy(); },
  };

  // --- SQL ----------------------------------------------------------------------------
  const editor = createSqlEditor($('.rp-sql', el), {
    doc: def.sql,
    dialect: ctx.dialect,
    fontSize: ctx.settings.editorFontSize,
    placeholder: t('rep.sqlPh'),
    onRun: () => void run(),
    onChange: (text) => { def.sql = text; },
  });
  const dbSel = $<HTMLSelectElement>('[data-k="database"]', el);
  const fillDbs = () => {
    const cur = def.database ?? ctx.defaultDatabase;
    dbSel.innerHTML = ctx.databases.map((d) => opt(d, d, d === cur)).join('');
    dbSel.classList.toggle('hidden', ctx.databases.length < 2);
  };
  fillDbs();
  dbSel.onchange = async () => { def.database = dbSel.value; editor.setSchema(await ctx.completion(def.database)); };
  void ctx.completion(def.database ?? ctx.defaultDatabase).then((s) => editor.setSchema(s));

  // --- Basit alanlar (data-k) ---------------------------------------------------------
  const getK = (k: string): unknown => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], def);
  const setK = (k: string, v: unknown) => {
    const parts = k.split('.');
    const last = parts.pop()!;
    const target = parts.reduce<Record<string, unknown>>((o, p) => o[p] as Record<string, unknown>, def as unknown as Record<string, unknown>);
    target[last] = v;
  };
  function paintFields() {
    $<HTMLInputElement>('[data-a="name"]', el).value = def.name;
    for (const inp of $$<HTMLInputElement>('[data-k]', $('.rp-side', el))) {
      const k = inp.dataset.k!;
      if (k === 'database' || k === 'groupBy' || k === 'cardTitle') continue;
      const v = getK(k);
      if (inp.type === 'checkbox') inp.checked = !!v;
      else inp.value = v == null ? '' : String(v);
    }
    $$('.rp-layouts button', el).forEach((b) => b.classList.toggle('on', b.dataset.layout === def.layout));
    $$('.rp-orient button', el).forEach((b) => b.classList.toggle('on', b.dataset.orient === def.page.orientation));
    $('.rp-groupby', el).classList.toggle('hidden', def.layout !== 'grouped');
    $('.rp-cardtitle', el).classList.toggle('hidden', def.layout !== 'cards');
    const names = def.columns.map((c) => c.name);
    $<HTMLSelectElement>('[data-k="groupBy"]', el).innerHTML = names.map((n) => opt(n, labelOf(n), n === def.groupBy)).join('');
    $<HTMLSelectElement>('[data-k="cardTitle"]', el).innerHTML = names.map((n) => opt(n, labelOf(n), n === def.cardTitle)).join('');
  }
  const labelOf = (n: string) => def.columns.find((c) => c.name === n)?.label || n;

  $('.rp-side', el).addEventListener('input', (e) => {
    const inp = (e.target as HTMLElement).closest<HTMLInputElement>('[data-k]');
    if (!inp || inp.dataset.k === 'database') return;
    const k = inp.dataset.k!;
    if (inp.type === 'checkbox') setK(k, inp.checked);
    else if (inp.type === 'number') setK(k, Math.max(0, Math.min(50, Number(inp.value) || 0)));
    else setK(k, inp.value);
    schedule();
  });
  $('.rp-side', el).addEventListener('change', (e) => {
    const inp = (e.target as HTMLElement).closest<HTMLInputElement>('[data-k]');
    if (inp?.type === 'checkbox' || inp?.tagName === 'SELECT') { if (inp.dataset.k !== 'database') { setK(inp.dataset.k!, inp.type === 'checkbox' ? inp.checked : inp.value); schedule(); } }
  });
  $$('.rp-layouts button', el).forEach((b) => (b.onclick = () => {
    def.layout = b.dataset.layout as ReportDef['layout'];
    if (def.layout === 'grouped' && !def.groupBy) def.groupBy = def.columns.find((c) => !c.numeric)?.name ?? def.columns[0]?.name ?? null;
    if (def.layout === 'cards' && !def.cardTitle) def.cardTitle = def.columns.find((c) => !c.numeric)?.name ?? def.columns[0]?.name ?? null;
    paintFields();
    schedule();
  }));
  $$('.rp-orient button', el).forEach((b) => (b.onclick = () => { def.page.orientation = b.dataset.orient as 'portrait' | 'landscape'; paintFields(); schedule(); }));
  $<HTMLInputElement>('[data-a="name"]', el).addEventListener('input', (e) => { def.name = (e.target as HTMLInputElement).value; });

  // --- Kolonlar -----------------------------------------------------------------------
  const colsHost = $('.rp-cols', el);
  function paintColumns() {
    colsHost.innerHTML = '';
    if (!def.columns.length) { colsHost.innerHTML = `<div class="empty-note">${esc(t('rep.noColumnsYet'))}</div>`; return; }
    def.columns.forEach((c, i) => {
      const row = h(`<div class="rp-col ${c.visible ? '' : 'off'}">
        <div class="rp-col-h"><label class="rp-chk"><input type="checkbox" data-f="visible" ${c.visible ? 'checked' : ''}><code>${esc(c.name)}</code></label>
          <span class="grow"></span>
          <button class="icon-btn" data-m="-1" title="${esc(t('rep.moveUp'))}" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button class="icon-btn rp-down" data-m="1" title="${esc(t('rep.moveDown'))}" ${i === def.columns.length - 1 ? 'disabled' : ''}>${icon('up')}</button></div>
        <input class="input sm" data-f="label" value="${esc(c.label)}" placeholder="${esc(c.name)}" title="${esc(t('rep.colLabel'))}">
        <div class="rp-col-g">
          <select class="input sm" data-f="format" title="${esc(t('rep.colFormat'))}">${FORMATS.map((f) => opt(f, t(`rep.fmt.${f}`), f === c.format)).join('')}</select>
          <select class="input sm" data-f="total" title="${esc(t('rep.colTotal'))}">${TOTALS.map((x) => opt(x, t(`rep.tot.${x}`), x === c.total)).join('')}</select>
          <select class="input sm" data-f="align" title="${esc(t('rep.colAlign'))}">${ALIGNS.map((a) => opt(a, t(`rep.align.${a}`), a === c.align)).join('')}</select>
          <input class="input sm" type="number" min="0" max="6" data-f="decimals" value="${c.decimals ?? ''}" placeholder="${esc(t('rep.decimalsAuto'))}" title="${esc(t('rep.decimals'))}">
        </div>
      </div>`);
      const upd = (patch: Partial<ReportColumn>) => { def.columns[i] = { ...def.columns[i], ...patch }; schedule(); };
      row.addEventListener('input', (e) => {
        const f = (e.target as HTMLInputElement).dataset.f;
        const v = (e.target as HTMLInputElement).value;
        if (f === 'label') { upd({ label: v }); paintSelectsOnly(); }
        if (f === 'decimals') upd({ decimals: v === '' ? null : Math.max(0, Math.min(6, Number(v) || 0)) });
      });
      row.addEventListener('change', (e) => {
        const tg = e.target as HTMLInputElement;
        const f = tg.dataset.f;
        if (f === 'visible') { upd({ visible: tg.checked }); row.classList.toggle('off', !tg.checked); }
        if (f === 'format' || f === 'total' || f === 'align') upd({ [f]: tg.value } as Partial<ReportColumn>);
      });
      $$<HTMLButtonElement>('[data-m]', row).forEach((b) => (b.onclick = () => {
        const j = i + Number(b.dataset.m);
        [def.columns[i], def.columns[j]] = [def.columns[j], def.columns[i]];
        paintColumns();
        schedule();
      }));
      colsHost.appendChild(row);
    });
  }
  const paintSelectsOnly = () => {
    const names = def.columns.map((c) => c.name);
    $<HTMLSelectElement>('[data-k="groupBy"]', el).innerHTML = names.map((n) => opt(n, labelOf(n), n === def.groupBy)).join('');
    $<HTMLSelectElement>('[data-k="cardTitle"]', el).innerHTML = names.map((n) => opt(n, labelOf(n), n === def.cardTitle)).join('');
  };

  // --- Önizleme -----------------------------------------------------------------------
  const html = (preview: boolean) => renderReport(def, data ?? { columns: [], rows: [], truncated: false }, { ...renderBase(), now: new Date(), preview });
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(paintPreview, 120);
  }
  function paintPreview() {
    timer = null;
    if (!data) {
      emptyNote.textContent = def.sql.trim() ? t('rep.noData') : t('rep.sqlPh');
      emptyNote.classList.remove('hidden');
      frame.classList.add('hidden');
      return;
    }
    emptyNote.classList.add('hidden');
    frame.classList.remove('hidden');
    // Kaydırma konumu korunsun; sayfa önizleme alanına sığacak şekilde küçültülür
    const y = frame.contentWindow?.scrollY ?? 0;
    frame.onload = () => { fitPreview(); frame.contentWindow?.scrollTo(0, y); };
    frame.srcdoc = html(true);
  }
  const PAGE_W: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
  function fitPreview() {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) return;
    const [a, b] = PAGE_W[def.page.size] ?? PAGE_W.A4;
    const pagePx = ((def.page.orientation === 'landscape' ? b : a) * 96) / 25.4 + 32;
    const scale = Math.min(1, Math.max(0.3, (frame.clientWidth - 24) / pagePx));
    doc.documentElement.style.zoom = String(scale);
  }
  new ResizeObserver(() => fitPreview()).observe($('.rp-preview', el));

  // --- Çalıştır -----------------------------------------------------------------------
  async function run() {
    const sql = def.sql.trim();
    if (!sql || running) return;
    $('[data-a="run"]', el).classList.add('hidden');
    $('[data-a="cancel"]', el).classList.remove('hidden');
    status.className = 'tb-status';
    status.innerHTML = `<span class="spin"></span>${esc(t('rep.loading'))}`;
    let cols: ColumnMeta[] | null = null;
    let first = -1;
    const rows: Cell[][] = [];
    let truncated = false;
    let error = '';
    let blocked = false;
    const started = Date.now();
    try {
      running = runSql({ sql, database: def.database ?? ctx.defaultDatabase, limit: ctx.settings.rowLimit }, (ev) => {
        if (ev.type === 'columns' && first < 0) { first = ev.index; cols = ev.columns; }
        else if (ev.type === 'rows' && ev.index === first) { for (const r of ev.rows) rows.push(r); }
        else if (ev.type === 'end' && ev.index === first) truncated = ev.truncated;
        else if (ev.type === 'error' && !error) error = ev.message;
        else if (ev.type === 'blocked') blocked = true;
      });
      const res = await running.done;
      if (blocked) error = t('rep.writeBlocked');
      if (res.cancelled) { status.textContent = t('res.cancelled'); status.className = 'tb-status warn'; return; }
      if (error) { status.textContent = error.split('\n')[0]; status.className = 'tb-status err'; status.title = error; toast(error, { type: 'err', timeout: 6000 }); return; }
      if (!cols) { status.textContent = t('rep.noColumns'); status.className = 'tb-status warn'; return; }
      def.columns = reconcileColumns(def.columns, cols);
      if (def.layout === 'grouped' && (!def.groupBy || !def.columns.some((c) => c.name === def.groupBy))) def.groupBy = def.columns.find((c) => !c.numeric)?.name ?? null;
      if (def.layout === 'cards' && (!def.cardTitle || !def.columns.some((c) => c.name === def.cardTitle))) def.cardTitle = def.columns[0]?.name ?? null;
      data = { columns: cols, rows, truncated };
      status.textContent = t('rep.rowsInfo', { n: formatNumber(rows.length), ms: Date.now() - started });
      status.className = `tb-status ${truncated ? 'warn' : 'ok'}`;
      status.title = '';
      paintFields();
      paintColumns();
      paintPreview();
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = 'tb-status err';
    } finally {
      running = null;
      $('[data-a="run"]', el).classList.remove('hidden');
      $('[data-a="cancel"]', el).classList.add('hidden');
    }
  }

  // --- Kaydet / yazdır / PDF ------------------------------------------------------------
  async function save() {
    try {
      const out = await api.reportSave(def);
      def = { ...def, updatedAt: out.updatedAt, createdAt: out.createdAt, name: out.name };
      saved = JSON.stringify(def);
      tab.title = def.name;
      $<HTMLInputElement>('[data-a="name"]', el).value = def.name;
      hooks.onSaved(out);
      toast(t('rep.saved'), { type: 'ok' });
    } catch (e) {
      toast((e as Error).message, { type: 'err' });
    }
  }
  async function ensureData(): Promise<boolean> {
    if (!data) await run();
    return !!data;
  }
  async function print() {
    if (!(await ensureData())) return;
    try { await api.reportPrint(html(false)); } catch (e) { toast((e as Error).message, { type: 'err' }); }
  }
  async function pdf() {
    if (!(await ensureData())) return;
    try {
      const file = await api.reportPdf(html(false), def.name);
      if (file) toast(t('rep.pdfSaved'), { type: 'ok', sub: file });
    } catch (e) {
      toast((e as Error).message, { type: 'err' });
    }
  }

  $('[data-a="run"]', el).onclick = () => void run();
  $('[data-a="cancel"]', el).onclick = () => running?.cancel();
  $('[data-a="save"]', el).onclick = () => void save();
  $('[data-a="print"]', el).onclick = () => void print();
  $('[data-a="pdf"]', el).onclick = () => void pdf();
  $('[data-a="delete"]', el).onclick = async () => {
    const before = saved;
    saved = JSON.stringify(def); // silindiyse "kaydedilmemiş" diye sorulmasın
    if (!(await hooks.onDelete(def))) saved = before;
  };
  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'p') { e.preventDefault(); void print(); }
  });

  paintFields();
  paintColumns();
  paintPreview();
  if (def.sql.trim()) void run();
  return tab;
}
