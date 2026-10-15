// Tablo/görünüm verisi sekmesi: ilk N kayıt ızgarada. Kolon gizle/göster, sıralama ve filtreler
// veriyi çeken SELECT ifadesine yansır; güncel SQL her zaman üstte görünür ve yeniden çalıştırılır.
import type { ColumnMeta, Cell, TreeNode } from '../../core/provider';
import { buildGridSelect, FILTER_OPS, opNeedsValue, type FilterOp, type GridQueryModel } from '../../core/sql/gridQuery';
import { api } from '../lib/api';
import { $, $$, contextMenu, esc, formatNumber, h, icon, openModal, t, toast, uid } from '../lib/ui';
import { createSqlEditor } from './editor';
import { Grid, type SortDir } from './grid';
import { runSql, exportSql, type RunHandle } from './runner';
import type { Ctx, Tab } from './context';

const opLabel = (op: FilterOp) => t(`op.${op}`);

export function createDataTab(ctx: Ctx, node: TreeNode): Tab {
  const id = uid();
  const p = node.path;
  const model: GridQueryModel = {
    table: { schema: p.schema, name: p.name ?? node.name, database: ctx.dialect === 'mysql' ? p.database : undefined },
    columns: [],
    hidden: [],
    sort: [],
    filters: [],
    limit: ctx.settings.previewRows,
  };
  let running: RunHandle | null = null;
  let lastSql = '';

  const el = h(`<div class="ws data-tab">
    <div class="toolbar">
      <button class="btn sm" data-a="refresh" title="F5">${icon('refresh')}${esc(t('common.refresh'))}</button>
      <button class="btn sm danger hidden" data-a="cancel">${icon('stop')}${esc(t('sql.cancel'))}</button>
      <button class="btn sm" data-a="cols">${icon('columns')}<span class="cols-label">${esc(t('data.columns'))}</span></button>
      <button class="btn sm" data-a="filter">${icon('filter')}${esc(t('data.addFilter'))}</button>
      <select class="input sm" data-a="limit" title="${esc(t('data.limit'))}">
        ${[100, 500, 1000, 5000, 10000].map((n) => `<option value="${n}" ${n === model.limit ? 'selected' : ''}>${esc(t('data.firstN', { n: formatNumber(n) }))}</option>`).join('')}
        <option value="0">${esc(t('data.all'))}</option>
      </select>
      <span class="tb-sep"></span>
      <button class="btn sm ghost" data-a="sql">${icon('sql')}${esc(t('data.openInEditor'))}</button>
      <button class="btn sm ghost" data-a="export">${icon('exportFile')}${esc(t('sql.export'))}</button>
      <span class="grow"></span>
      <span class="tb-status" data-a="status"></span>
    </div>
    <div class="filter-chips hidden"></div>
    <div class="sql-preview"><span class="sql-preview-label">${icon('sql')}SQL</span><div class="sql-preview-host"></div></div>
    <div class="data-grid-host"></div>
  </div>`);
  const status = $('[data-a="status"]', el);
  if (!model.limit || ![100, 500, 1000, 5000, 10000].includes(model.limit)) {
    $<HTMLSelectElement>('[data-a="limit"]', el).insertAdjacentHTML('afterbegin', `<option value="${model.limit}" selected>${esc(t('data.firstN', { n: formatNumber(model.limit ?? 0) }))}</option>`);
  }

  const preview = createSqlEditor($('.sql-preview-host', el), { dialect: ctx.dialect, readOnly: true, lineNumbers: false, fontSize: ctx.settings.editorFontSize - 0.5 });

  const grid = new Grid({
    onSort: (column, dir) => {
      model.sort = dir ? [{ column, dir }] : [];
      void reload();
    },
    onHeaderMenu: (c, x, y) => headerMenu(c, x, y),
    onCellMenu: (c, v, x, y) => cellMenu(c, v, x, y),
  });
  $('.data-grid-host', el).appendChild(grid.el);

  function renderChips() {
    const box = $('.filter-chips', el);
    box.innerHTML = '';
    box.classList.toggle('hidden', !model.filters.length);
    model.filters.forEach((f, i) => {
      const chip = h(`<span class="fchip">${icon('filter')}<b>${esc(f.column)}</b> ${esc(opLabel(f.op))} ${opNeedsValue(f.op) ? `<code>${esc(f.value ?? '')}</code>` : ''}<button class="icon-btn" title="${esc(t('common.delete'))}">${icon('x')}</button></span>`);
      chip.onclick = (e) => {
        if ((e.target as HTMLElement).closest('button')) { model.filters.splice(i, 1); void reload(); }
        else void editFilter(f.column, i);
      };
      box.appendChild(chip);
    });
    if (model.filters.length > 1) {
      const clear = h(`<button class="btn sm ghost">${icon('x')}${esc(t('data.clearFilters'))}</button>`);
      clear.onclick = () => { model.filters = []; void reload(); };
      box.appendChild(clear);
    }
    const hiddenN = model.hidden.length;
    $('.cols-label', el).textContent = hiddenN ? t('data.columnsHidden', { n: model.columns.length - hiddenN, total: model.columns.length }) : t('data.columns');
  }

  async function reload() {
    running?.cancel();
    renderChips();
    lastSql = buildGridSelect(model, ctx.dialect);
    preview.setText(lastSql);
    status.innerHTML = `<span class="spin"></span>${esc(t('sql.running'))}`;
    $('[data-a="cancel"]', el).classList.remove('hidden');
    let cols: ColumnMeta[] = [];
    let first = true;
    let error = '';
    let end: { rowCount: number; truncated: boolean; ms: number } | null = null;
    const h2 = runSql({ sql: lastSql, database: p.database, limit: model.limit || ctx.settings.rowLimit }, (ev) => {
      if (ev.type === 'columns') { cols = ev.columns; grid.setData(cols, []); grid.showEmpty(null); }
      else if (ev.type === 'rows') { grid.appendRows(ev.rows); first = false; }
      else if (ev.type === 'end') end = ev;
      else if (ev.type === 'error') error = ev.message;
    });
    running = h2;
    try {
      const r = await h2.done;
      if (running !== h2) return;
      const s = model.sort[0];
      grid.setSortIndicator(s?.column ?? null, (s?.dir ?? null) as SortDir);
      if (error) { status.textContent = error.split('\n')[0]; status.className = 'tb-status err'; toast(t('data.error'), { type: 'err', sub: error, timeout: 8000 }); }
      else if (r.cancelled) { status.textContent = t('res.cancelled'); status.className = 'tb-status warn'; }
      else if (end) {
        const e = end as { rowCount: number; truncated: boolean; ms: number };
        status.textContent = t(e.truncated || (model.limit && e.rowCount >= model.limit) ? 'data.rowsMore' : 'data.rows', { n: formatNumber(e.rowCount), ms: e.ms });
        status.className = 'tb-status ok';
        if (first) grid.showEmpty(t('res.noRows'));
      }
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = 'tb-status err';
    } finally {
      if (running === h2) { running = null; $('[data-a="cancel"]', el).classList.add('hidden'); }
    }
  }

  function headerMenu(c: ColumnMeta, x: number, y: number) {
    contextMenu(x, y, [
      { label: t('data.sortAsc'), icon: 'sortAsc', action: () => { model.sort = [{ column: c.name, dir: 'asc' }]; void reload(); } },
      { label: t('data.sortDesc'), icon: 'sortDesc', action: () => { model.sort = [{ column: c.name, dir: 'desc' }]; void reload(); } },
      model.sort.length > 0 && { label: t('data.sortClear'), icon: 'x', action: () => { model.sort = []; void reload(); } },
      '-',
      { label: t('data.filterColumn'), icon: 'filter', action: () => void editFilter(c.name) },
      { label: t('data.hideColumn'), icon: 'hide', disabled: model.columns.length - model.hidden.length <= 1, action: () => { model.hidden.push(c.name); void reload(); } },
      model.hidden.length > 0 && { label: t('data.showAll'), icon: 'eye', action: () => { model.hidden = []; void reload(); } },
      '-',
      { label: t('cw.copyName'), icon: 'copy', action: () => void api.clipboardWrite(c.name) },
    ]);
  }

  function cellMenu(c: ColumnMeta, v: Cell, x: number, y: number) {
    const add = (op: FilterOp, value?: string) => { model.filters.push({ column: c.name, op, value }); void reload(); };
    contextMenu(x, y, [
      { label: t('grid.copy'), icon: 'copy', kbd: 'Ctrl+C', action: () => void grid.copySelection(false) },
      { label: t('grid.copyHeaders'), icon: 'copy', action: () => void grid.copySelection(true) },
      '-',
      v !== null && { label: t('data.filterEq', { v: String(v).slice(0, 40) }), icon: 'filter', action: () => add('=', String(v)) },
      v !== null && { label: t('data.filterNe', { v: String(v).slice(0, 40) }), icon: 'filter', action: () => add('<>', String(v)) },
      { label: t('data.filterNull'), icon: 'filter', action: () => add(v === null ? 'is null' : 'is not null') },
      { label: t('data.hideColumn'), icon: 'hide', disabled: model.columns.length - model.hidden.length <= 1, action: () => { model.hidden.push(c.name); void reload(); } },
    ]);
  }

  async function editFilter(column?: string, index?: number) {
    const existing = index !== undefined ? model.filters[index] : undefined;
    const body = h(`<div style="display:grid;gap:14px">
      <div class="row c-1-1">
        <div class="field"><label>${esc(t('data.column'))}</label><select class="input" id="fc">${model.columns.map((c) => `<option ${c.name === (existing?.column ?? column) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>${esc(t('data.operator'))}</label><select class="input" id="fo">${FILTER_OPS.map((o) => `<option value="${o}" ${o === (existing?.op ?? 'contains') ? 'selected' : ''}>${esc(opLabel(o))}</option>`).join('')}</select></div>
      </div>
      <div class="field" id="fv-wrap"><label>${esc(t('data.value'))}</label><input class="input" id="fv" value="${esc(existing?.value ?? '')}" spellcheck="false"><small class="hint">${esc(t('data.inHint'))}</small></div>
    </div>`);
    const sync = () => $('#fv-wrap', body).classList.toggle('hidden', !opNeedsValue($<HTMLSelectElement>('#fo', body).value as FilterOp));
    $('#fo', body).onchange = sync;
    sync();
    const r = await openModal<{ column: string; op: FilterOp; value: string }>({
      title: t('data.filterTitle'), iconName: 'filter', body,
      buttons: [
        { label: t('common.cancel'), value: null },
        { label: t('common.ok'), cls: 'primary', onClick: (m) => ({ column: $<HTMLSelectElement>('#fc', m).value, op: $<HTMLSelectElement>('#fo', m).value as FilterOp, value: $<HTMLInputElement>('#fv', m).value }) },
      ],
    });
    if (!r) return;
    if (index !== undefined) model.filters[index] = r;
    else model.filters.push(r);
    void reload();
  }

  function columnChooser(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    const pop = h(`<div class="ctx col-chooser" style="left:${rect.left}px;top:${rect.bottom + 4}px">
      <div class="cc-head"><button class="btn sm ghost" data-a="all">${esc(t('data.selectAll'))}</button><button class="btn sm ghost" data-a="none">${esc(t('data.selectNone'))}</button></div>
      <div class="cc-list">${model.columns.map((c) => `<label class="check"><input type="checkbox" data-c="${esc(c.name)}" ${model.hidden.includes(c.name) ? '' : 'checked'}><span>${esc(c.name)} <small>${esc(c.type)}</small></span></label>`).join('')}</div>
    </div>`);
    const apply = () => {
      const hidden = $$<HTMLInputElement>('input[data-c]', pop).filter((i) => !i.checked).map((i) => i.dataset.c!);
      if (hidden.length >= model.columns.length) return; // en az bir kolon görünür kalır
      model.hidden = hidden;
      void reload();
    };
    pop.addEventListener('change', apply);
    $('[data-a="all"]', pop).onclick = () => { $$<HTMLInputElement>('input[data-c]', pop).forEach((i) => (i.checked = true)); apply(); };
    $('[data-a="none"]', pop).onclick = () => { $$<HTMLInputElement>('input[data-c]', pop).forEach((i, k) => (i.checked = k === 0)); apply(); };
    document.body.appendChild(pop);
    const close = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchor) { pop.remove(); window.removeEventListener('mousedown', close, true); } };
    setTimeout(() => window.addEventListener('mousedown', close, true), 0);
  }

  $('[data-a="refresh"]', el).onclick = () => void reload();
  $('[data-a="cancel"]', el).onclick = () => running?.cancel();
  $('[data-a="cols"]', el).onclick = (e) => columnChooser(e.currentTarget as HTMLElement);
  $('[data-a="filter"]', el).onclick = () => void editFilter();
  $<HTMLSelectElement>('[data-a="limit"]', el).onchange = (e) => { model.limit = Number((e.target as HTMLSelectElement).value) || null; void reload(); };
  $('[data-a="sql"]', el).onclick = () => ctx.openSql(lastSql, p.database);
  $('[data-a="export"]', el).onclick = async () => {
    const sql = buildGridSelect({ ...model, limit: null }, ctx.dialect);
    const tst = toast(t('exp.running'), { timeout: 0, sub: '0' });
    try {
      const r = await exportSql({ sql, database: p.database, format: 'csv', defaultName: model.table.name }, (n) => (tst.querySelector('.t-sub')!.textContent = formatNumber(n))).done;
      tst.remove();
      if (r) {
        const tt = toast(t('exp.done', { n: formatNumber(r.rows) }), { type: 'ok', sub: r.filePath, timeout: 8000 });
        tt.style.cursor = 'pointer';
        tt.onclick = () => void api.reveal(r.filePath);
      }
    } catch (e) {
      tst.remove();
      toast(t('exp.failed'), { type: 'err', sub: (e as Error).message });
    }
  };
  el.addEventListener('keydown', (e) => { if (e.key === 'F5') { e.preventDefault(); void reload(); } });

  void (async () => {
    try {
      model.columns = await api.dbColumns(p);
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = 'tb-status err';
      return;
    }
    void reload();
  })();

  return {
    id: `data:${node.id}`,
    title: node.name,
    icon: node.kind === 'table' ? 'table' : 'view',
    el,
    onClose: () => { running?.cancel(); preview.destroy(); void id; },
  };
}
