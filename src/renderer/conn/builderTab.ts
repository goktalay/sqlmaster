// Görsel sorgu oluşturucu (Navicat Query Builder benzeri):
//  - Tabloları nesne ağacından tuvale sürükleyin (ya da "Tablo ekle"); başlığından tutup taşıyın
//  - Bir kolonu başka tablonun kolonuna sürükleyerek JOIN çizin; çizgiye tıklayıp türünü değiştirin/silin
//  - Kolon kutucukları SELECT listesini, alt paneller takma ad/toplama/sıralama ve koşulları belirler
//  - Üretilen SQL sağda canlı görünür; elle düzenlenebilir ve çalıştırılabilir
import type { TreeNode } from '../../core/provider';
import { buildQuery, emptyModel, makeAlias, type Aggregate, type JoinType, type QbModel, type QbTable } from '../../core/sql/queryBuilder';
import { FILTER_OPS, opNeedsValue, type FilterOp } from '../../core/sql/gridQuery';
import { api } from '../lib/api';
import { $, $$, contextMenu, esc, h, icon, openModal, t, toast, uid } from '../lib/ui';
import { createSqlEditor } from './editor';
import { ResultsPanel } from './results';
import { execute } from './exec';
import type { RunHandle } from './runner';
import { TABLE_DND } from './tree';
import type { Ctx, Tab } from './context';
import { splitter } from './split';

const AGGS: Aggregate[] = ['', 'COUNT', 'COUNT DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'];
const JOINS: JoinType[] = ['INNER', 'LEFT', 'RIGHT', 'FULL'];
const ROW_H = 24;
const HEAD_H = 32;
let counter = 0;

export function createBuilderTab(ctx: Ctx): Tab {
  const model: QbModel = emptyModel();
  let database: string | undefined = ctx.defaultDatabase;
  let detached = false; // kullanıcı SQL'i elle değiştirdi
  let running: RunHandle | null = null;

  const el = h(`<div class="ws builder-tab">
    <div class="toolbar">
      <button class="btn sm primary" data-a="run" title="Ctrl+Enter">${icon('play')}${esc(t('sql.run'))}</button>
      <button class="btn sm danger hidden" data-a="cancel">${icon('stop')}${esc(t('sql.cancel'))}</button>
      <button class="btn sm" data-a="add">${icon('plusSq')}${esc(t('qb.addTable'))}</button>
      <label class="check inline"><input type="checkbox" data-a="distinct"><span>DISTINCT</span></label>
      <label class="inline-field">${esc(t('qb.limit'))}<input class="input sm" data-a="limit" type="number" min="0" value="${model.limit ?? ''}" style="width:90px"></label>
      <button class="btn sm ghost" data-a="clear">${icon('trash')}${esc(t('qb.clear'))}</button>
      <span class="grow"></span>
      <span class="tb-status" data-a="status"></span>
    </div>
    <div class="split-v">
      <div class="qb-canvas-wrap">
        <div class="qb-canvas"><svg class="qb-lines"></svg><div class="qb-hint">${icon('builder')}<span>${esc(t('qb.hint'))}</span></div></div>
      </div>
      <div class="hsplit"></div>
      <div class="qb-bottom">
        <div class="qb-left">
          <div class="res-tabs qb-tabs">
            <button class="res-tab on" data-tab="cols">${icon('columns')}${esc(t('qb.columns'))}</button>
            <button class="res-tab" data-tab="conds">${icon('filter')}${esc(t('qb.conditions'))}</button>
            <button class="res-tab" data-tab="results">${icon('table')}${esc(t('qb.results'))}</button>
          </div>
          <div class="qb-pane" data-pane="cols"></div>
          <div class="qb-pane hidden" data-pane="conds"></div>
          <div class="qb-pane hidden" data-pane="results"></div>
        </div>
        <div class="vsplit"></div>
        <div class="qb-sql">
          <div class="qb-sql-head">${icon('sql')}<span>${esc(t('qb.generated'))}</span><span class="grow"></span>
            <button class="btn sm ghost hidden" data-a="regen">${icon('refresh')}${esc(t('qb.regenerate'))}</button>
            <button class="btn sm ghost" data-a="copy">${icon('copy')}</button>
            <button class="btn sm ghost" data-a="toEditor">${icon('open')}</button></div>
          <div class="qb-sql-host"></div>
        </div>
      </div>
    </div>
  </div>`);

  const canvas = $('.qb-canvas', el);
  const svg = $('.qb-lines', el) as unknown as SVGSVGElement;
  const status = $('[data-a="status"]', el);
  const panel = new ResultsPanel();
  $('[data-pane="results"]', el).appendChild(panel.el);
  splitter($('.hsplit', el), $('.qb-canvas-wrap', el), 'y', 0.52);
  splitter($('.vsplit', el), $('.qb-left', el), 'x', 0.55);

  let settingText = false;
  const sqlEditor = createSqlEditor($('.qb-sql-host', el), {
    dialect: ctx.dialect,
    fontSize: ctx.settings.editorFontSize,
    onRun: () => void run(),
    onChange: () => {
      if (settingText) return;
      detached = true;
      $('[data-a="regen"]', el).classList.remove('hidden');
    },
  });
  void ctx.completion(database).then((s) => sqlEditor.setSchema(s));

  // --- Model değişince: tuval, alt paneller ve SQL güncellenir -----------------------
  function changed({ tables = true } = {}) {
    if (tables) renderTables();
    renderLines();
    renderColumns();
    renderConds();
    $('.qb-hint', el).classList.toggle('hidden', model.tables.length > 0);
    if (!detached) {
      settingText = true;
      sqlEditor.setText(buildQuery(model, ctx.dialect));
      settingText = false;
    }
  }

  // --- Tablolar -------------------------------------------------------------------
  async function addTable(node: TreeNode, x?: number, y?: number) {
    if (database && node.path.database && node.path.database !== database && model.tables.length) {
      toast(t('qb.otherDb'), { type: 'err' });
      return;
    }
    database = node.path.database ?? database;
    let columns;
    try {
      columns = await api.dbColumns(node.path);
    } catch (e) {
      toast((e as Error).message, { type: 'err' });
      return;
    }
    const name = node.path.name ?? node.name;
    const tb: QbTable = {
      id: uid(),
      ref: { schema: node.path.schema, name, database: ctx.dialect === 'mysql' ? node.path.database : undefined },
      alias: makeAlias(name, model.tables.map((x) => x.alias)),
      columns,
      x: x ?? 24 + (model.tables.length % 4) * 250,
      y: y ?? 24 + Math.floor(model.tables.length / 4) * 260,
    };
    model.tables.push(tb);
    autoJoin(tb);
    changed();
  }

  /** Basit ilişki tahmini: yeni tabloda "<diğer>_id" kolonu varsa diğerinin "id" kolonuna bağla (ya da tersi) */
  function autoJoin(tb: QbTable) {
    // İngilizce (orders, categories) ve Türkçe (siparisler, urunlar) çoğul ekleri
    const singular = (s: string) => s.toLowerCase().replace(/(ies)$/, 'y').replace(/(ler|lar)$/, '').replace(/s$/, '');
    for (const other of model.tables) {
      if (other === tb) continue;
      const tryPair = (a: QbTable, b: QbTable) => {
        const fk = a.columns.find((c) => c.name.toLowerCase() === `${singular(b.ref.name)}_id` || c.name.toLowerCase() === `${singular(b.ref.name)}id`);
        const pk = b.columns.find((c) => c.name.toLowerCase() === 'id');
        if (fk && pk) {
          model.joins.push({ id: uid(), type: 'INNER', left: { table: b.id, column: pk.name }, right: { table: a.id, column: fk.name } });
          return true;
        }
        return false;
      };
      if (tryPair(tb, other) || tryPair(other, tb)) return;
    }
  }

  function removeTable(id: string) {
    model.tables = model.tables.filter((x) => x.id !== id);
    model.joins = model.joins.filter((j) => j.left.table !== id && j.right.table !== id);
    model.columns = model.columns.filter((c) => c.table !== id);
    model.conditions = model.conditions.filter((c) => c.table !== id);
    changed();
  }

  function isSelected(tableId: string, column: string) {
    return model.columns.some((c) => c.table === tableId && c.column === column && c.output);
  }

  function toggleColumn(tableId: string, column: string, on: boolean) {
    const existing = model.columns.find((c) => c.table === tableId && c.column === column);
    if (on && !existing) model.columns.push({ table: tableId, column, output: true });
    else if (on && existing) existing.output = true;
    else if (!on && existing) model.columns = model.columns.filter((c) => c !== existing || !!c.sort);
    if (!on && existing?.sort) existing.output = false;
    changed({ tables: false });
    $$<HTMLInputElement>(`.qb-table[data-id="${tableId}"] input[data-col]`, canvas).forEach((i) => (i.checked = isSelected(tableId, i.dataset.col!)));
  }

  function renderTables() {
    $$('.qb-table', canvas).forEach((x) => x.remove());
    for (const tb of model.tables) {
      const box = h(`<div class="qb-table" data-id="${tb.id}" style="left:${tb.x}px;top:${tb.y}px">
        <div class="qb-thead" title="${esc(tb.ref.schema ? tb.ref.schema + '.' : '')}${esc(tb.ref.name)}">
          ${icon('table')}<span class="qb-tname">${esc(tb.ref.name)}</span><span class="qb-alias">${esc(tb.alias)}</span>
          <button class="icon-btn" data-a="all" title="${esc(t('data.selectAll'))}">${icon('check')}</button>
          <button class="icon-btn" data-a="close" title="${esc(t('common.delete'))}">${icon('x')}</button>
        </div>
        <div class="qb-cols">${tb.columns.map((c) => `<div class="qb-col" data-col="${esc(c.name)}">
          <input type="checkbox" data-col="${esc(c.name)}" ${isSelected(tb.id, c.name) ? 'checked' : ''}>
          <span class="qb-cname">${esc(c.name)}</span><span class="qb-ctype">${esc(c.type)}</span><span class="qb-port" title="${esc(t('qb.dragJoin'))}"></span></div>`).join('')}</div>
      </div>`);
      $('[data-a="close"]', box).onclick = () => removeTable(tb.id);
      $('[data-a="all"]', box).onclick = () => {
        const all = tb.columns.every((c) => isSelected(tb.id, c.name));
        for (const c of tb.columns) {
          const ex = model.columns.find((x) => x.table === tb.id && x.column === c.name);
          if (all) model.columns = model.columns.filter((x) => x !== ex);
          else if (!ex) model.columns.push({ table: tb.id, column: c.name, output: true });
          else ex.output = true;
        }
        changed();
      };
      box.addEventListener('change', (e) => {
        const i = e.target as HTMLInputElement;
        if (i.dataset.col) toggleColumn(tb.id, i.dataset.col, i.checked);
      });
      // Taşıma
      $('.qb-thead', box).addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        const x0 = e.clientX, y0 = e.clientY, tx = tb.x, ty = tb.y;
        const move = (ev: MouseEvent) => {
          tb.x = Math.max(0, tx + ev.clientX - x0);
          tb.y = Math.max(0, ty + ev.clientY - y0);
          box.style.left = `${tb.x}px`;
          box.style.top = `${tb.y}px`;
          renderLines();
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      // JOIN çizme: kolondan başka tablonun kolonuna sürükle
      $$('.qb-col', box).forEach((row) => row.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        e.preventDefault();
        startJoinDrag(tb, row.dataset.col!, e);
      }));
      box.querySelector('.qb-cols')!.addEventListener('scroll', () => renderLines());
      canvas.appendChild(box);
    }
    sizeCanvas();
  }

  function sizeCanvas() {
    let w = 0, hgt = 0;
    for (const b of $$('.qb-table', canvas)) {
      w = Math.max(w, b.offsetLeft + b.offsetWidth + 40);
      hgt = Math.max(hgt, b.offsetTop + b.offsetHeight + 40);
    }
    canvas.style.minWidth = `${w}px`;
    canvas.style.minHeight = `${hgt}px`;
  }

  /** Kolon satırının tuval üzerindeki bağlantı noktası (sol/sağ kenar ortası) */
  function anchor(tableId: string, column: string): { l: number; r: number; y: number } | null {
    const box = canvas.querySelector<HTMLElement>(`.qb-table[data-id="${tableId}"]`);
    if (!box) return null;
    const list = box.querySelector<HTMLElement>('.qb-cols')!;
    const row = [...list.querySelectorAll<HTMLElement>('.qb-col')].find((r) => r.dataset.col === column);
    if (!row) return null;
    let y = box.offsetTop + HEAD_H + row.offsetTop - list.scrollTop + ROW_H / 2;
    y = Math.max(box.offsetTop + HEAD_H, Math.min(y, box.offsetTop + box.offsetHeight - 6));
    return { l: box.offsetLeft, r: box.offsetLeft + box.offsetWidth, y };
  }

  function path(a: { l: number; r: number; y: number }, b: { l: number; r: number; y: number }) {
    const fromRight = a.r < b.l ? true : a.l > b.r ? false : true;
    const x1 = fromRight ? a.r : a.l;
    const x2 = fromRight ? (a.r < b.l ? b.l : b.r) : b.r;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    const c1 = fromRight ? x1 + dx : x1 - dx;
    const c2 = fromRight ? (a.r < b.l ? x2 - dx : x2 + dx) : x2 + dx;
    return { d: `M${x1},${a.y} C${c1},${a.y} ${c2},${b.y} ${x2},${b.y}`, mx: (x1 + x2) / 2, my: (a.y + b.y) / 2 };
  }

  function renderLines() {
    let html = '';
    for (const j of model.joins) {
      const a = anchor(j.left.table, j.left.column);
      const b = anchor(j.right.table, j.right.column);
      if (!a || !b) continue;
      const p = path(a, b);
      html += `<g class="qb-join" data-id="${j.id}"><path class="qb-hit" d="${p.d}"/><path class="qb-line" d="${p.d}"/>
        <circle cx="${p.d.split(' ')[0].slice(1).split(',')[0]}" cy="${a.y}" r="3.5"/>
        <g transform="translate(${p.mx},${p.my})"><rect x="-26" y="-10" width="52" height="20" rx="10"/><text text-anchor="middle" dy="4">${j.type}</text></g></g>`;
    }
    svg.innerHTML = html;
    svg.setAttribute('width', String(canvas.scrollWidth));
    svg.setAttribute('height', String(canvas.scrollHeight));
    $$('.qb-join', svg as unknown as HTMLElement).forEach((g) => g.addEventListener('click', (e) => joinMenu(g.dataset.id!, (e as MouseEvent).clientX, (e as MouseEvent).clientY)));
  }

  function joinMenu(id: string, x: number, y: number) {
    const j = model.joins.find((k) => k.id === id);
    if (!j) return;
    contextMenu(x, y, [
      ...JOINS.map((type) => ({ label: `${type} JOIN${j.type === type ? '  ✓' : ''}`, icon: 'link', action: () => { j.type = type; changed({ tables: false }); } })),
      '-',
      { label: t('qb.swapJoin'), icon: 'swap', action: () => { [j.left, j.right] = [j.right, j.left]; changed({ tables: false }); } },
      { label: t('qb.deleteJoin'), icon: 'trash', danger: true, action: () => { model.joins = model.joins.filter((k) => k !== j); changed({ tables: false }); } },
    ]);
  }

  function startJoinDrag(from: QbTable, column: string, e: MouseEvent) {
    const start = anchor(from.id, column);
    if (!start) return;
    const rect = canvas.getBoundingClientRect();
    const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    temp.setAttribute('class', 'qb-line temp');
    svg.appendChild(temp);
    let moved = false;
    const move = (ev: MouseEvent) => {
      moved = true;
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      temp.setAttribute('d', `M${start.r},${start.y} C${start.r + 60},${start.y} ${x - 60},${y} ${x},${y}`);
      $$('.qb-col.drop', canvas).forEach((r) => r.classList.remove('drop'));
      const over = (ev.target as HTMLElement).closest?.('.qb-col');
      if (over && over.closest<HTMLElement>('.qb-table')!.dataset.id !== from.id) over.classList.add('drop');
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      temp.remove();
      $$('.qb-col.drop', canvas).forEach((r) => r.classList.remove('drop'));
      if (!moved) return;
      const over = (ev.target as HTMLElement).closest?.<HTMLElement>('.qb-col');
      const toTable = over?.closest<HTMLElement>('.qb-table')?.dataset.id;
      if (!over || !toTable || toTable === from.id) return;
      model.joins.push({ id: uid(), type: 'INNER', left: { table: from.id, column }, right: { table: toTable, column: over.dataset.col! } });
      changed({ tables: false });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    void e;
  }

  // --- Kolonlar paneli ------------------------------------------------------------
  const tableName = (id: string) => model.tables.find((x) => x.id === id)?.alias ?? '?';
  function renderColumns() {
    const pane = $('[data-pane="cols"]', el);
    if (!model.columns.length) {
      pane.innerHTML = `<div class="empty-note">${esc(t('qb.noColumns'))}</div>`;
      return;
    }
    pane.innerHTML = `<table class="qb-grid"><thead><tr><th>${esc(t('qb.output'))}</th><th>${esc(t('qb.column'))}</th><th>${esc(t('qb.alias'))}</th><th>${esc(t('qb.aggregate'))}</th><th>${esc(t('qb.sort'))}</th><th></th></tr></thead><tbody></tbody></table>`;
    const tbody = $('tbody', pane);
    model.columns.forEach((c, i) => {
      const tr = h<HTMLTableRowElement>(`<tr>
        <td><input type="checkbox" data-f="output" ${c.output ? 'checked' : ''}></td>
        <td class="mono">${esc(tableName(c.table))}.${esc(c.column)}</td>
        <td><input class="input sm" data-f="alias" value="${esc(c.alias ?? '')}" spellcheck="false"></td>
        <td><select class="input sm" data-f="aggregate">${AGGS.map((a) => `<option value="${a}" ${a === (c.aggregate ?? '') ? 'selected' : ''}>${a || '—'}</option>`).join('')}</select></td>
        <td><select class="input sm" data-f="sort"><option value="">—</option><option value="ASC" ${c.sort === 'ASC' ? 'selected' : ''}>ASC</option><option value="DESC" ${c.sort === 'DESC' ? 'selected' : ''}>DESC</option></select></td>
        <td><button class="icon-btn" data-f="up" title="↑">${icon('up')}</button><button class="icon-btn" data-f="del">${icon('x')}</button></td></tr>`);
      tr.addEventListener('change', (e) => {
        const f = (e.target as HTMLElement).dataset.f;
        const v = (e.target as HTMLInputElement).value;
        if (f === 'output') c.output = (e.target as HTMLInputElement).checked;
        if (f === 'alias') c.alias = v.trim() || undefined;
        if (f === 'aggregate') c.aggregate = v as Aggregate;
        if (f === 'sort') c.sort = v as 'ASC' | 'DESC' | '';
        changed();
      });
      $('[data-f="del"]', tr).onclick = () => { model.columns.splice(i, 1); changed(); };
      $('[data-f="up"]', tr).onclick = () => { if (i > 0) { [model.columns[i - 1], model.columns[i]] = [model.columns[i], model.columns[i - 1]]; changed({ tables: false }); } };
      tbody.appendChild(tr);
    });
  }

  // --- Koşullar paneli ------------------------------------------------------------
  function renderConds() {
    const pane = $('[data-pane="conds"]', el);
    pane.innerHTML = '';
    const colOptions = (sel: string) => model.tables.flatMap((tb) => tb.columns.map((c) => {
      const v = `${tb.id}|${c.name}`;
      return `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(tb.alias)}.${esc(c.name)}</option>`;
    })).join('');
    const table = h(`<table class="qb-grid"><tbody></tbody></table>`);
    model.conditions.forEach((c, i) => {
      const tr = h<HTMLTableRowElement>(`<tr>
        <td>${i ? `<select class="input sm" data-f="connector"><option ${c.connector === 'AND' ? 'selected' : ''}>AND</option><option ${c.connector === 'OR' ? 'selected' : ''}>OR</option></select>` : `<span class="mono" style="color:var(--text-3)">WHERE</span>`}</td>
        <td><select class="input sm" data-f="col">${colOptions(`${c.table}|${c.column}`)}</select></td>
        <td><select class="input sm" data-f="op">${FILTER_OPS.map((o) => `<option value="${o}" ${o === c.op ? 'selected' : ''}>${esc(t(`op.${o}`))}</option>`).join('')}</select></td>
        <td><input class="input sm ${opNeedsValue(c.op) ? '' : 'hidden'}" data-f="value" value="${esc(c.value ?? '')}" spellcheck="false"></td>
        <td><button class="icon-btn" data-f="del">${icon('x')}</button></td></tr>`);
      tr.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const f = target.dataset.f;
        if (f === 'connector') c.connector = target.value as 'AND' | 'OR';
        if (f === 'col') [c.table, c.column] = target.value.split('|');
        if (f === 'op') c.op = target.value as FilterOp;
        if (f === 'value') c.value = target.value;
        changed({ tables: false });
      });
      $('[data-f="value"]', tr).addEventListener('input', (e) => {
        c.value = (e.target as HTMLInputElement).value;
        if (!detached) { settingText = true; sqlEditor.setText(buildQuery(model, ctx.dialect)); settingText = false; }
      });
      $('[data-f="del"]', tr).onclick = () => { model.conditions.splice(i, 1); changed({ tables: false }); };
      $('tbody', table).appendChild(tr);
    });
    pane.appendChild(table);
    const add = h(`<button class="btn sm" ${model.tables.length ? '' : 'disabled'}>${icon('plus')}${esc(t('qb.addCondition'))}</button>`);
    add.onclick = () => {
      const tb = model.tables[0];
      model.conditions.push({ id: uid(), table: tb.id, column: tb.columns[0]?.name ?? '', op: '=', value: '', connector: 'AND' });
      changed({ tables: false });
      showPane('conds');
    };
    pane.appendChild(add);
  }

  function showPane(name: string) {
    $$('.qb-tabs .res-tab', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('.qb-pane', el).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  }
  $$('.qb-tabs .res-tab', el).forEach((b) => (b.onclick = () => showPane(b.dataset.tab!)));

  // --- Çalıştırma -----------------------------------------------------------------
  async function run() {
    const sql = sqlEditor.getText().trim();
    if (!sql || running) return;
    showPane('results');
    $('[data-a="run"]', el).classList.add('hidden');
    $('[data-a="cancel"]', el).classList.remove('hidden');
    status.innerHTML = `<span class="spin"></span>${esc(t('sql.running'))}`;
    try {
      const res = await execute({ sql, database, panel, onStart: (hd) => (running = hd) });
      status.textContent = res.errors ? t('sql.doneErrors', { n: res.errors, ms: res.ms }) : t('sql.done', { ms: res.ms });
      status.className = `tb-status ${res.errors ? 'err' : 'ok'}`;
    } finally {
      running = null;
      $('[data-a="run"]', el).classList.remove('hidden');
      $('[data-a="cancel"]', el).classList.add('hidden');
    }
  }

  async function pickTable() {
    const schema = await ctx.completion(database);
    const items = Object.entries(schema?.tables ?? {}).flatMap(([s, tables]) => Object.keys(tables).map((tn) => ({ s, tn })));
    const body = h(`<div style="display:grid;gap:10px"><input class="input" id="tq" placeholder="${esc(t('cw.filterPh'))}" spellcheck="false"><div class="pick-list"></div></div>`);
    const list = $('.pick-list', body);
    let chosen: { s: string; tn: string } | null = null;
    let closeModal: ((v: boolean | null) => void) | null = null;
    const draw = (q: string) => {
      list.innerHTML = '';
      for (const it of items.filter((x) => `${x.s}.${x.tn}`.toLowerCase().includes(q)).slice(0, 300)) {
        const row = h(`<div class="pick-item">${icon('table')}<span>${esc(it.tn)}</span><small>${esc(it.s)}</small></div>`);
        row.ondblclick = () => { chosen = it; closeModal?.(true); };
        row.onclick = () => { chosen = it; $$('.pick-item', list).forEach((x) => x.classList.toggle('on', x === row)); };
        list.appendChild(row);
      }
    };
    draw('');
    $('#tq', body).addEventListener('input', (e) => draw((e.target as HTMLInputElement).value.toLowerCase()));
    const ok = await openModal<boolean>({ title: t('qb.addTable'), iconName: 'table', body, width: 520, buttons: [{ label: t('common.cancel'), value: false }, { label: t('common.ok'), cls: 'primary', value: true }], onMount: (_m, close) => (closeModal = close) });
    const c = chosen as { s: string; tn: string } | null;
    if (!ok || !c) return;
    const isMy = ctx.dialect === 'mysql';
    await addTable({
      id: uid(), kind: 'table', name: c.tn, hasChildren: false,
      path: isMy ? { database: c.s, name: c.tn } : { database, schema: c.s, name: c.tn },
    });
  }

  // Ağaçtan sürükle-bırak
  const wrap = $('.qb-canvas-wrap', el);
  wrap.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes(TABLE_DND)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; wrap.classList.add('drop'); } });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => {
    wrap.classList.remove('drop');
    const raw = e.dataTransfer?.getData(TABLE_DND);
    if (!raw) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    void addTable(JSON.parse(raw) as TreeNode, Math.max(0, e.clientX - r.left - 40), Math.max(0, e.clientY - r.top - 12));
  });

  $('[data-a="run"]', el).onclick = () => void run();
  $('[data-a="cancel"]', el).onclick = () => running?.cancel();
  $('[data-a="add"]', el).onclick = () => void pickTable();
  $<HTMLInputElement>('[data-a="distinct"]', el).onchange = (e) => { model.distinct = (e.target as HTMLInputElement).checked; changed({ tables: false }); };
  $<HTMLInputElement>('[data-a="limit"]', el).onchange = (e) => { model.limit = Number((e.target as HTMLInputElement).value) || null; changed({ tables: false }); };
  $('[data-a="clear"]', el).onclick = () => {
    Object.assign(model, emptyModel(), { limit: model.limit });
    detached = false;
    $('[data-a="regen"]', el).classList.add('hidden');
    changed();
  };
  $('[data-a="regen"]', el).onclick = () => {
    detached = false;
    $('[data-a="regen"]', el).classList.add('hidden');
    changed({ tables: false });
  };
  $('[data-a="copy"]', el).onclick = () => { void api.clipboardWrite(sqlEditor.getText()); toast(t('cw.copied'), { type: 'ok' }); };
  $('[data-a="toEditor"]', el).onclick = () => ctx.openSql(sqlEditor.getText(), database);
  new ResizeObserver(() => renderLines()).observe(wrap);
  changed();

  return {
    id: uid(),
    title: t('qb.tabTitle', { n: ++counter }),
    icon: 'builder',
    el,
    onClose: () => { running?.cancel(); sqlEditor.destroy(); },
    /** Ağaçtan "Sorgu oluşturucuya ekle" */
    addNode: (n: TreeNode) => void addTable(n),
  } as Tab & { addNode(n: TreeNode): void };
}
