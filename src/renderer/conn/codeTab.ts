// Kod içeren nesneler (görünüm tanımı, fonksiyon, prosedür, trigger, tablo DDL) sözdizimi renklendirmeli editörde.
import type { TreeNode } from '../../core/provider';
import { api } from '../lib/api';
import { $, esc, h, icon, t, toast } from '../lib/ui';
import { createSqlEditor } from './editor';
import { ResultsPanel } from './results';
import { execute } from './exec';
import type { Ctx, Tab } from './context';
import { splitter } from './split';

export function createCodeTab(ctx: Ctx, node: TreeNode): Tab {
  const el = h(`<div class="ws code-tab">
    <div class="toolbar">
      <span class="code-kind">${esc(t(`kind.${node.kind}`))}</span>
      <b class="code-name">${esc(node.path.schema ? `${node.path.schema}.${node.name}` : node.name)}</b>
      ${node.detail ? `<span class="code-detail">${esc(node.detail)}</span>` : ''}
      <span class="grow"></span>
      <button class="btn sm ghost" data-a="reload">${icon('refresh')}${esc(t('common.refresh'))}</button>
      <button class="btn sm ghost" data-a="copy">${icon('copy')}${esc(t('common.copy'))}</button>
      <button class="btn sm ghost" data-a="sql">${icon('sql')}${esc(t('data.openInEditor'))}</button>
      <button class="btn sm" data-a="run" title="Ctrl+Enter">${icon('play')}${esc(t('code.execute'))}</button>
    </div>
    <div class="split-v">
      <div class="editor-host"></div>
      <div class="hsplit hidden"></div>
      <div class="results-host hidden"></div>
    </div>
  </div>`);
  const editor = createSqlEditor($('.editor-host', el), { dialect: ctx.dialect, fontSize: ctx.settings.editorFontSize, onRun: () => void run() });
  const panel = new ResultsPanel();
  $('.results-host', el).appendChild(panel.el);
  splitter($('.hsplit', el), $('.editor-host', el), 'y', 0.7);
  $('.editor-host', el).style.flex = '1 1 auto';

  async function load() {
    editor.setText(`-- ${t('code.loading')}`);
    try {
      editor.setText((await api.dbDdl(node)) || `-- ${t('code.empty')}`);
    } catch (e) {
      editor.setText(`-- ${(e as Error).message}`);
    }
  }

  async function run() {
    $('.hsplit', el).classList.remove('hidden');
    $('.results-host', el).classList.remove('hidden');
    $('.editor-host', el).style.flex = '0 0 65%';
    await execute({ sql: editor.selectionOrAll().text, database: node.path.database, panel });
  }

  $('[data-a="reload"]', el).onclick = () => void load();
  $('[data-a="copy"]', el).onclick = () => { void api.clipboardWrite(editor.getText()); toast(t('cw.copied'), { type: 'ok' }); };
  $('[data-a="sql"]', el).onclick = () => ctx.openSql(editor.getText(), node.path.database, node.name);
  $('[data-a="run"]', el).onclick = () => void run();
  void load();

  return { id: `code:${node.id}`, title: node.name, icon: 'code', el, onClose: () => editor.destroy() };
}
