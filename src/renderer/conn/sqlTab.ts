// SQL editörü sekmesi: Ctrl+Enter seçili/tümünü, Ctrl+Shift+Enter imleçteki ifadeyi, F5 tümünü çalıştırır.
// Çoklu sonuç, iptal, veritabanı seçimi, geçmiş, dışa aktarım.
import { esc, formatDate, formatNumber, h, icon, openModal, t, toast, uid, $ } from '../lib/ui';
import { api } from '../lib/api';
import { createSqlEditor, type SqlEditor } from './editor';
import { ResultsPanel } from './results';
import { execute } from './exec';
import { exportSql } from './runner';
import type { RunHandle } from './runner';
import type { Ctx, Tab } from './context';
import { splitter } from './split';

let counter = 0;

export function createSqlTab(ctx: Ctx, initial = '', database?: string, title?: string): Tab {
  const id = uid();
  let db = database ?? ctx.defaultDatabase;
  let running: RunHandle | null = null;
  let savedText = initial;
  const el = h(`<div class="ws sql-tab">
    <div class="toolbar">
      <button class="btn sm primary" data-a="run" title="Ctrl+Enter">${icon('play')}${esc(t('sql.run'))}</button>
      <button class="btn sm" data-a="stmt" title="Ctrl+Shift+Enter">${icon('play')}${esc(t('sql.runStatement'))}</button>
      <button class="btn sm danger hidden" data-a="cancel">${icon('stop')}${esc(t('sql.cancel'))}</button>
      <span class="tb-sep"></span>
      <select class="input sm db-select ${ctx.databases.length > 1 ? '' : 'hidden'}" data-a="db" title="${esc(t('sql.database'))}"></select>
      <button class="btn sm ghost" data-a="history">${icon('history')}${esc(t('sql.history'))}</button>
      <button class="btn sm ghost" data-a="export">${icon('exportFile')}${esc(t('sql.export'))}</button>
      <span class="grow"></span>
      <span class="tb-status" data-a="status"></span>
    </div>
    <div class="split-v">
      <div class="editor-host"></div>
      <div class="hsplit"></div>
      <div class="results-host"></div>
    </div>
  </div>`);

  const status = $('[data-a="status"]', el);
  const panel = new ResultsPanel();
  $('.results-host', el).appendChild(panel.el);
  splitter($('.hsplit', el), $('.editor-host', el), 'y', 0.45);

  const dbSel = $<HTMLSelectElement>('[data-a="db"]', el);
  const fillDbs = () => {
    dbSel.innerHTML = ctx.databases.map((d) => `<option ${d === db ? 'selected' : ''}>${esc(d)}</option>`).join('');
    dbSel.classList.toggle('hidden', ctx.databases.length < 2);
  };
  fillDbs();
  dbSel.onchange = async () => {
    db = dbSel.value;
    editor.setSchema(await ctx.completion(db));
  };

  const editor: SqlEditor = createSqlEditor($('.editor-host', el), {
    doc: initial,
    dialect: ctx.dialect,
    fontSize: ctx.settings.editorFontSize,
    placeholder: t('sql.placeholder'),
    onRun: (mode) => void run(mode),
  });
  void ctx.completion(db).then((s) => editor.setSchema(s));

  const setRunning = (on: boolean) => {
    $('[data-a="run"]', el).classList.toggle('hidden', on);
    $('[data-a="stmt"]', el).classList.toggle('hidden', on);
    $('[data-a="cancel"]', el).classList.toggle('hidden', !on);
  };

  async function run(mode: 'auto' | 'statement' | 'all') {
    if (running) return;
    const part = mode === 'statement' ? editor.currentStatement() : mode === 'all' ? { text: editor.getText(), offset: 0 } : editor.selectionOrAll();
    if (!part || !part.text.trim()) return;
    setRunning(true);
    status.innerHTML = `<span class="spin"></span>${esc(t('sql.running'))}`;
    const started = Date.now();
    const timer = setInterval(() => (status.innerHTML = `<span class="spin"></span>${esc(t('sql.running'))} ${((Date.now() - started) / 1000).toFixed(1)} s`), 250);
    try {
      const res = await execute({ sql: part.text, database: db, panel, onStart: (h) => (running = h) });
      status.textContent = res.blocked ? t('ro.notRun') : res.cancelled ? t('res.cancelled') : res.errors ? t('sql.doneErrors', { n: res.errors, ms: res.ms }) : t('sql.done', { ms: res.ms });
      status.className = `tb-status ${res.errors ? 'err' : res.cancelled || res.blocked ? 'warn' : 'ok'}`;
      if (res.firstError?.start !== undefined) editor.markError(part.offset + res.firstError.start, part.offset + (res.firstError.end ?? res.firstError.start));
      if (/^\s*(create|drop|alter)\b/im.test(part.text) && !res.errors) ctx.setStatus(t('sql.ddlHint'));
    } finally {
      clearInterval(timer);
      running = null;
      setRunning(false);
    }
  }

  async function doExport(sql?: string) {
    const text = sql || editor.currentStatement()?.text;
    if (!text) return;
    const format = await openModal<'csv' | 'tsv' | 'jsonl' | 'json'>({
      title: t('exp.title'), iconName: 'exportFile',
      body: `<div style="color:var(--text-2);line-height:1.5">${esc(t('exp.hint'))}</div><pre class="exp-sql">${esc(text.slice(0, 600))}</pre>`,
      buttons: [
        { label: t('common.cancel'), value: null },
        { label: 'JSON', value: 'json' },
        { label: 'TSV', value: 'tsv' },
        { label: 'CSV', cls: 'primary', value: 'csv' },
      ],
    });
    if (!format) return;
    const tst = toast(t('exp.running'), { timeout: 0, sub: '0' });
    const handle = exportSql({ sql: text, database: db, format, defaultName: 'sonuc' }, (rows) => (tst.querySelector('.t-sub')!.textContent = formatNumber(rows)));
    try {
      const r = await handle.done;
      tst.remove();
      if (r) {
        const tt = toast(t('exp.done', { n: formatNumber(r.rows) }), { type: 'ok', sub: r.filePath, timeout: 8000 });
        tt.style.cursor = 'pointer';
        tt.onclick = () => void api.reveal(r.filePath);
      }
    } catch (e) {
      tst.remove();
      toast(t('exp.failed'), { type: 'err', sub: (e as Error).message, timeout: 8000 });
    }
  }
  panel.onExport = (s) => void doExport(s);

  async function showHistory() {
    const list = await api.historyList();
    const body = h(`<div class="hist-list">${list.length ? '' : `<div class="empty-note">${esc(t('sql.historyEmpty'))}</div>`}</div>`);
    let pick: string | null = null;
    const rows: [HTMLElement, string][] = [];
    for (const e of list) {
      const row = h(`<div class="hist-row ${e.ok ? '' : 'err'}"><div class="hist-meta">${esc(formatDate(e.at))} · ${e.ms} ms${e.rows !== undefined ? ` · ${formatNumber(e.rows)} ${esc(t('sql.rowsShort'))}` : ''}${e.database ? ` · ${esc(e.database)}` : ''}</div><pre>${esc(e.sql.slice(0, 500))}</pre></div>`);
      rows.push([row, e.sql]);
      body.appendChild(row);
    }
    const r = await openModal<boolean>({
      title: t('sql.history'), iconName: 'history', width: 760, body,
      buttons: [{ label: t('common.close'), value: false }],
      onMount: (_m, close) => rows.forEach(([row, sql]) => (row.onclick = () => { pick = sql; close(true); })),
    });
    if (r && pick) {
      const v = editor.view;
      v.dispatch(v.state.replaceSelection(pick));
      v.focus();
    }
  }

  $('[data-a="run"]', el).onclick = () => void run('auto');
  $('[data-a="stmt"]', el).onclick = () => void run('statement');
  $('[data-a="cancel"]', el).onclick = () => running?.cancel();
  $('[data-a="history"]', el).onclick = () => void showHistory();
  $('[data-a="export"]', el).onclick = () => void doExport();

  return {
    id,
    title: title ?? t('sql.tabTitle', { n: ++counter }),
    icon: 'sql',
    el,
    dirty: () => editor.getText().trim() !== '' && editor.getText() !== savedText,
    onActivate: () => { fillDbs(); setTimeout(() => editor.focus(), 0); },
    onClose: () => { running?.cancel(); editor.destroy(); savedText = editor.getText(); },
  };
}
