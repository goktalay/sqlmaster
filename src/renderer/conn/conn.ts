// Bağlantı penceresi: solda nesne ağacı, sağda sekmeli çalışma alanı (SQL, tablo verisi, kod, sorgu oluşturucu).
import type { TreeNode } from '../../core/provider';
import { providerMeta } from '../../shared/providers';
import type { PublicStore } from '../../shared/types';
import { api } from '../lib/api';
import { $, confirmBox, esc, h, icon, openModal, prompt, t, toast } from '../lib/ui';
import { openSettings, themeButton } from '../lib/settings';
import { mastertoolButton } from '../lib/mastertool';
import { dialectOf, makeCompletion, resetCompletion, type Ctx, type Tab } from './context';
import { ObjectTree } from './tree';
import { createSqlTab } from './sqlTab';
import { createDataTab } from './dataTab';
import { createCodeTab } from './codeTab';
import { createBuilderTab } from './builderTab';
import { splitter } from './split';

const tabs: Tab[] = [];
let activeId: string | null = null;
let builder: (Tab & { addNode(n: TreeNode): void }) | null = null;

async function main() {
  const { connection, needsPassword, settings } = await api.cwInfo();
  const meta = providerMeta(connection.provider);
  document.title = `${connection.name} — SQL Master`;
  document.documentElement.style.setProperty('--c', connection.color || meta.color);

  const ctx: Ctx = {
    conn: connection,
    info: null,
    dialect: dialectOf(connection),
    settings,
    readOnly: connection.readOnly,
    databases: [],
    defaultDatabase: undefined,
    openTab,
    activateTab,
    closeTab: (id) => void closeTab(id),
    openSql: (sql = '', database, title) => openTab(createSqlTab(ctx, sql, database, title)),
    openData: (node) => { if (!activateTab(`data:${node.id}`)) openTab(createDataTab(ctx, node)); },
    openCode: (node) => { if (!activateTab(`code:${node.id}`)) openTab(createCodeTab(ctx, node)); },
    openBuilder: (node) => {
      if (!builder || !tabs.includes(builder)) {
        builder = createBuilderTab(ctx) as Tab & { addNode(n: TreeNode): void };
        openTab(builder);
      } else activateTab(builder.id);
      if (node) builder.addNode(node);
    },
    completion: makeCompletion(() => ctx.defaultDatabase),
    setStatus: (text) => ($('#stMsg').textContent = text),
  };

  // --- Üst çubuk -------------------------------------------------------------------
  $('#cwName').textContent = connection.name;
  $('#cwSub').textContent = meta.kind === 'file' ? connection.filePath || t('form.inMemory') : `${connection.user ? connection.user + '@' : ''}${connection.host}${connection.port ? ':' + connection.port : ''}`;
  $('#cwProv').innerHTML = `${icon('database')}${esc(meta.short)}`;
  ($('#cwProv') as HTMLElement).style.setProperty('--c', meta.color);
  $('#btnNewSql').innerHTML = icon('sql') + esc(t('cw.newSql'));
  $('#btnNewSql').title = 'Ctrl+T';
  $('#btnBuilder').innerHTML = icon('builder') + esc(t('cw.builder'));
  $('#btnReconnect').innerHTML = icon('reconnect') + esc(t('cw.reconnect'));
  $('#btnSettings').innerHTML = icon('gear');
  $('#btnSettings').title = t('app.settings');
  themeButton($('#btnTheme'));
  $('.bar-actions').appendChild(mastertoolButton());
  $('#btnNewSql').onclick = () => ctx.openSql();
  $('#btnBuilder').onclick = () => ctx.openBuilder();
  $('#btnReconnect').onclick = () => void connect();
  $('#btnSettings').onclick = async () => { await openSettings(ctx.settings); };
  api.onStoreChanged((s: PublicStore) => { ctx.settings = s.settings; });

  const paintRo = () => {
    const b = $('#cwRo');
    b.className = `badge-ro ${ctx.readOnly ? '' : 'off'}`;
    b.innerHTML = ctx.readOnly ? `${icon('lock')}${esc(t('cw.readOnly'))}` : `${icon('unlock')}${esc(t('cw.readWrite'))}`;
    b.title = ctx.readOnly ? t('cw.readOnlyTip') : t('cw.readWriteTip');
  };
  $('#cwRo').onclick = async () => {
    if (ctx.readOnly && !(await confirmBox(t('cw.disableRo'), esc(t('cw.disableRoMsg')), { okText: t('cw.disableRoOk') }))) return;
    try {
      ctx.readOnly = await api.dbSetReadOnly(!ctx.readOnly);
      paintRo();
      toast(ctx.readOnly ? t('cw.roOn') : t('cw.roOff'), { type: ctx.readOnly ? 'ok' : '' });
    } catch (e) {
      toast((e as Error).message, { type: 'err' });
    }
  };
  paintRo();

  // --- Gövde ------------------------------------------------------------------------
  const tree = new ObjectTree(ctx);
  $('#treeHost').appendChild(tree.el);
  $('#treeHost').style.width = `${settings.treeWidth || 300}px`;
  treeResize();

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 't') { e.preventDefault(); ctx.openSql(); }
    if (e.ctrlKey && k === 'w' && activeId) { e.preventDefault(); void closeTab(activeId); }
    if (e.ctrlKey && e.shiftKey && k === 'b') { e.preventDefault(); ctx.openBuilder(); }
    if (e.ctrlKey && e.key === 'Tab' && tabs.length > 1) {
      e.preventDefault();
      const i = tabs.findIndex((x) => x.id === activeId);
      activateTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
    }
  });

  // --- Bağlan -----------------------------------------------------------------------
  let oncePassword: string | undefined;
  async function connect(): Promise<boolean> {
    setState('connecting');
    if (needsPassword && !oncePassword) {
      const pw = await prompt(t('cw.passwordTitle'), { label: t('cw.passwordFor', { user: connection.user || '', host: connection.host }), type: 'password', iconName: 'key', okText: t('common.connect') });
      if (!pw) { setState('off', t('cw.notConnected')); return false; }
      oncePassword = pw;
    }
    const r = await api.cwConnect({ password: oncePassword });
    if (!r.ok || !r.info) {
      setState('off', r.message ?? '');
      if (needsPassword) oncePassword = undefined;
      showConnectError(r.message ?? '');
      return false;
    }
    ctx.info = r.info;
    ctx.readOnly = r.readOnly ?? ctx.readOnly;
    ctx.defaultDatabase = r.info.database;
    paintRo();
    setState('on');
    $('#stServer').innerHTML = `${icon('server')}${esc(r.info.product)}${meta.kind === 'server' ? (r.info.tls ? ` · ${icon('lock')}TLS` : ` · <span class="warn">${icon('unlock')}${esc(t('cw.noTls'))}</span>`) : ''}`;
    $('#stDb').innerHTML = r.info.database ? `${icon('database')}${esc(r.info.database)}${r.info.user ? ` · ${icon('user')}${esc(r.info.user)}` : ''}` : '';
    resetCompletion();
    await tree.reload();
    return true;
  }

  function setState(s: 'connecting' | 'on' | 'off', msg = '') {
    $('#dot').className = `status-dot ${s === 'on' ? 'on' : s === 'off' ? 'off' : ''}`;
    $('#dot').title = s === 'on' ? t('cw.connected') : s === 'off' ? msg : t('cw.connecting');
    if (s === 'connecting') $('#stMsg').textContent = t('cw.connecting');
    else $('#stMsg').textContent = s === 'off' ? msg.split('\n')[0] : '';
  }

  function showConnectError(message: string) {
    void openModal<string>({
      title: t('cw.connectFailed'), iconName: 'x', width: 560,
      body: `<div class="test-result show err">${icon('x')}<div>${esc(message)}</div></div>`,
      buttons: [
        { label: t('common.close'), value: null },
        { label: t('cw.retry'), cls: 'primary', icon: 'reconnect', value: 'retry' },
      ],
    }).then((v) => { if (v === 'retry') void connect(); });
  }

  // Veritabanı süreci yeniden başladı (iptal yanıt vermedi ya da çöktü): sessizce yeniden bağlan
  api.onDbReset(({ reason }) => {
    toast(reason === 'cancel' ? t('cw.resetCancel') : t('cw.resetExit'), { type: 'err', timeout: 6000 });
    void connect();
  });

  if (await connect()) ctx.openSql();
  else renderEmptyWorkspace();
}

function treeResize() {
  splitter($('#treeSplit'), $('#treeHost'), 'x', 0, (px) => void api.setSettings({ treeWidth: Math.round(px) }));
  // splitter oranla çalışır; başlangıçta piksel genişliği korunsun
  $('#treeHost').style.flex = `0 0 ${$('#treeHost').style.width}`;
}

function renderEmptyWorkspace() {
  if (tabs.length) return;
  $('#tabHost').innerHTML = `<div class="ws-empty">${icon('database')}<span>${esc(t('cw.emptyWorkspace'))}</span></div>`;
}

// --- Sekmeler -------------------------------------------------------------------------
function openTab(tab: Tab) {
  $('#tabHost').querySelector('.ws-empty')?.remove();
  tabs.push(tab);
  tab.el.classList.add('hidden');
  $('#tabHost').appendChild(tab.el);
  activateTab(tab.id);
}

function activateTab(id: string): boolean {
  const tab = tabs.find((x) => x.id === id);
  if (!tab) return false;
  activeId = id;
  for (const x of tabs) x.el.classList.toggle('hidden', x !== tab);
  renderTabbar();
  tab.onActivate?.();
  return true;
}

async function closeTab(id: string) {
  const i = tabs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const tab = tabs[i];
  if (tab.dirty?.() && !(await confirmBox(t('cw.closeTab'), esc(t('cw.closeTabMsg', { name: tab.title })), { okText: t('cw.closeTabOk') }))) return;
  tab.onClose?.();
  tab.el.remove();
  tabs.splice(i, 1);
  if (tab === builder) builder = null;
  if (activeId === id) {
    const next = tabs[i] ?? tabs[i - 1];
    if (next) activateTab(next.id);
    else { activeId = null; renderTabbar(); renderEmptyWorkspace(); }
  } else renderTabbar();
}

function renderTabbar() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  for (const tab of tabs) {
    const b = h(`<div class="wtab ${tab.id === activeId ? 'on' : ''}" title="${esc(tab.title)}">${icon(tab.icon)}<span>${esc(tab.title)}</span><button class="icon-btn" title="Ctrl+W">${icon('x')}</button></div>`);
    b.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button')) void closeTab(tab.id);
      else activateTab(tab.id);
    };
    b.onauxclick = (e) => { if (e.button === 1) void closeTab(tab.id); };
    bar.appendChild(b);
  }
  const plus = h(`<button class="icon-btn wtab-add" title="${esc(t('cw.newSql'))} (Ctrl+T)">${icon('plus')}</button>`);
  plus.onclick = () => $('#btnNewSql').click();
  bar.appendChild(plus);
}

void main().catch((e) => {
  document.body.appendChild(h(`<div class="ws-empty err">${esc((e as Error).message)}</div>`));
});
