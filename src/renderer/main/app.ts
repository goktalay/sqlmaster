// Ana pencere: "Bağlantı ekle" kartı, bağlantı kartları, sürüklenebilir klasörler, bağlantı formu, ayarlar.
import type { ConnectionForm, Folder, PublicConnection, PublicStore } from '../../shared/types';
import { PROVIDERS, providerMeta } from '../../shared/providers';
import type { ProviderId, SslMode } from '../../core/provider';
import { api } from '../lib/api';
import { $, $$, confirmBox, contextMenu, esc, h, icon, LANG, openModal, prompt, t, toast } from '../lib/ui';
import { acct, logout, onAcct, openSettings, syncText, themeButton } from '../lib/settings';

const COLORS = ['#22d3ee', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f97316', '#fbbf24', '#34d399', '#94a3b8'];
const DND = 'application/x-sqlm';

let data: PublicStore = { folders: [], connections: [], settings: {} as PublicStore['settings'] };
let currentFolder: string | null = null;
let query = '';
let selectedId: string | null = null;

// --- Başlangıç ---------------------------------------------------------------
$('.search-ico').innerHTML = icon('search');
$('#btnSettings').innerHTML = icon('gear');
$('#btnSettings').title = t('app.settings');
$('#btnNewFolder').innerHTML = icon('folderPlus') + esc(t('common.newFolder'));
$('#btnNewConn').innerHTML = icon('plus') + esc(t('app.newConn'));
$<HTMLInputElement>('#search').placeholder = t('app.searchPh');
themeButton($('#btnTheme'));

$('#btnSettings').onclick = () => openSettings(data.settings);
$('#content').addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.card, .new-card')) { selectedId = null; updateSelectionUI(); }
});
$('#btnNewFolder').onclick = () => newFolder();
$('#btnNewConn').onclick = () => editConnection(null);
$('#search').addEventListener('input', (e) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); render(); });

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '');
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $<HTMLInputElement>('#search').focus(); $<HTMLInputElement>('#search').select(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); void editConnection(null); }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { $<HTMLInputElement>('#search').value = ''; query = ''; render(); $('#search').blur(); }
  if (e.key === 'Backspace' && !inInput && currentFolder) goFolder(folderById(currentFolder)?.parentId ?? null);
  const sel = data.connections.find((c) => c.id === selectedId);
  if (sel && !inInput) {
    if (e.key === 'Enter') void api.openConnection(sel.id);
    if (e.key === 'Delete') void deleteConnection(sel);
    if (e.key === 'F2') void editConnection(sel);
  }
});

api.onStoreChanged((d) => { data = d; render(); });

// --- Hesap rozeti ve senkron durumu ---------------------------------------------
let lastErrorShown: string | null = null;
onAcct((st) => {
  const b = $('#btnAccount');
  const name = st.user?.name || st.user?.email || st.email || '?';
  $('.ac-avatar', b).textContent = name.trim().slice(0, 1).toUpperCase();
  const s = !st.syncEnabled || st.state === 'off' ? 'off' : st.state || 'idle';
  b.className = `account-chip s-${s}`;
  $('.ac-sync', b).innerHTML = s === 'syncing' ? '<span class="spin"></span>' : icon(['off', 'offline', 'error'].includes(s) ? 'cloudOff' : 'cloud');
  b.title = `${st.user?.email || st.email || ''}\n${syncText(st)}`;
  if (st.state === 'error' && st.error !== lastErrorShown) {
    lastErrorShown = st.error;
    toast(syncText(st), { type: 'err', timeout: 9000 });
  }
  if (st.state === 'ok') lastErrorShown = null;
});

$('#btnAccount').onclick = (e) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  contextMenu(r.right - 260, r.bottom + 6, [
    { label: acct.user?.email || acct.email || '', icon: 'user', disabled: true, action: () => {} },
    { label: syncText(acct), icon: acct.syncEnabled ? 'cloud' : 'cloudOff', disabled: true, action: () => {} },
    '-',
    { label: t('acct.syncNow'), icon: 'refresh', disabled: !acct.syncEnabled, action: () => void api.syncNow() },
    { label: t('acct.myAccount'), icon: 'open', action: () => void api.openWeb('account') },
    { label: t('app.settings'), icon: 'gear', action: () => void openSettings(data.settings) },
    '-',
    { label: t('acct.logout'), icon: 'logout', danger: true, action: logout },
  ]);
};

// Yeni sürüm bildirimi: exe yalnız hesabın kişiye özel bağlantısından indirilir
api.onUpdateAvailable(({ version }) => {
  const bar = $('#updateBar');
  bar.innerHTML = `${icon('download')}<span>${esc(t('update.available', { version }))} — ${esc(t('update.hint'))}</span>
    <button class="btn sm primary" data-a="open">${esc(t('update.open'))}</button>
    <button class="icon-btn" data-a="close" title="${esc(t('common.cancel'))}">${icon('x')}</button>`;
  bar.classList.remove('hidden');
  $('[data-a="open"]', bar).onclick = () => void api.openWeb('account');
  $('[data-a="close"]', bar).onclick = () => bar.classList.add('hidden');
});

api.onLibraryBackup((file) => toast(t('acct.backupNotice'), { sub: file, timeout: 12000 }));
void api.getStore().then((d) => { data = d; render(); });

// --- Yardımcılar -------------------------------------------------------------
const folderById = (id: string | null) => data.folders.find((f) => f.id === id);
const sortByName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, LANG, { sensitivity: 'base' });

function folderPath(id: string | null): Folder[] {
  const out: Folder[] = [];
  let f = folderById(id);
  while (f) { out.unshift(f); f = folderById(f.parentId); }
  return out;
}

function countIn(folderId: string | null): number {
  let n = data.connections.filter((c) => (c.folderId || null) === folderId).length;
  for (const sub of data.folders.filter((f) => (f.parentId || null) === folderId)) n += countIn(sub.id);
  return n;
}

function goFolder(id: string | null) {
  currentFolder = id && folderById(id) ? id : null;
  selectedId = null;
  render();
}

function updateSelectionUI() {
  $$('.conn-card').forEach((x) => x.classList.toggle('selected', x.dataset.id === selectedId));
}

const target = (c: PublicConnection) => {
  const meta = providerMeta(c.provider);
  if (meta.kind === 'file') return c.filePath || t('form.inMemory');
  const port = c.port && c.port !== meta.defaultPort ? `:${c.port}` : '';
  return `${c.user ? c.user + '@' : ''}${c.host || 'localhost'}${port}${c.database ? '/' + c.database : ''}`;
};

// --- Çizim -------------------------------------------------------------------
function render() {
  if (currentFolder && !folderById(currentFolder)) currentFolder = null;
  renderCrumbs();
  renderGrid();
  updateSelectionUI();
  const nc = data.connections.length;
  $('#stats').textContent = nc ? t('app.stats', { c: nc, f: data.folders.length }) : t('app.welcome');
}

function renderCrumbs() {
  const el = $('#crumbs');
  el.innerHTML = '';
  if (query) {
    el.appendChild(h(`<span class="crumb current">${icon('search')} ${esc(t('app.results', { q: query }))}</span>`));
    return;
  }
  const parts: { id: string | null; name: string }[] = [{ id: null, name: t('app.all') }, ...folderPath(currentFolder)];
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    const c = h(`<span class="crumb ${last ? 'current' : ''}">${i === 0 ? icon('home') : icon('folder')}${esc(p.name)}</span>`);
    if (!last) {
      c.onclick = () => goFolder(p.id);
      makeDropTarget(c, p.id);
    }
    el.appendChild(c);
    if (!last) el.appendChild(h(`<span class="crumb-sep">${icon('chevronRight')}</span>`));
  });
}

function newCard(big = false) {
  const n = big
    ? h(`<div class="welcome"><div class="new-card"><div class="plus">${icon('plus')}</div><div class="lbl">${esc(t('app.addConn'))}</div><div class="hint">${t('app.welcomeHint')}</div></div></div>`)
    : h(`<div class="new-card"><div class="plus">${icon('plus')}</div><div class="lbl">${esc(t('app.addConn'))}</div></div>`);
  (n.classList.contains('new-card') ? n : $('.new-card', n)).onclick = () => void editConnection(null);
  return n;
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!data.connections.length && !data.folders.length) {
    grid.appendChild(newCard(true));
    return;
  }
  let folders: Folder[];
  let conns: PublicConnection[];
  if (query) {
    folders = data.folders.filter((f) => f.name.toLowerCase().includes(query));
    conns = data.connections.filter((c) => [c.name, c.host, c.user, c.database, c.filePath, String(c.port ?? ''), c.comments, providerMeta(c.provider).name].some((v) => String(v || '').toLowerCase().includes(query)));
  } else {
    folders = data.folders.filter((f) => (f.parentId || null) === currentFolder);
    conns = data.connections.filter((c) => (c.folderId || null) === currentFolder);
  }
  folders.sort(sortByName);
  conns.sort(sortByName);

  if (folders.length) {
    grid.appendChild(h(`<div class="section-title">${esc(t('app.folders'))}</div>`));
    for (const f of folders) grid.appendChild(folderCard(f));
  }
  grid.appendChild(h(`<div class="section-title">${esc(t('app.connections'))}${conns.length ? `<span class="hint">${esc(t('app.dblHint'))}</span>` : ''}</div>`));
  if (!query) grid.appendChild(newCard());
  for (const c of conns) grid.appendChild(connCard(c));
  if (query && !conns.length && !folders.length) grid.appendChild(h(`<div class="empty-note" style="grid-column:1/-1">${esc(t('app.noMatch'))}</div>`));
}

function folderCard(f: Folder) {
  const n = countIn(f.id);
  const el = h(`<div class="card folder-card" draggable="true">
    <div class="avatar">${icon('folder')}</div>
    <div style="min-width:0"><div class="card-title">${esc(f.name)}</div><div class="card-sub">${esc(t('app.folderCount', { n }))}</div></div></div>`);
  el.addEventListener('dblclick', () => { $<HTMLInputElement>('#search').value = ''; query = ''; goFolder(f.id); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'open', action: () => goFolder(f.id) },
      { label: t('app.newConnHere'), icon: 'plus', action: () => void editConnection(null, f.id) },
      { label: t('app.newSubfolder'), icon: 'folderPlus', action: () => void newFolder(f.id) },
      '-',
      { label: t('common.rename'), icon: 'edit', action: () => void renameFolder(f) },
      { label: t('common.moveEllipsis'), icon: 'move', action: () => void moveDialog('folder', f) },
      '-',
      { label: t('common.delete'), icon: 'trash', danger: true, action: () => void deleteFolder(f) },
    ]);
  });
  el.addEventListener('dragstart', (e) => { e.dataTransfer!.setData(DND, JSON.stringify({ type: 'folder', id: f.id })); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  makeDropTarget(el, f.id);
  return el;
}

function connCard(c: PublicConnection) {
  const meta = providerMeta(c.provider);
  const where = query && c.folderId ? folderPath(c.folderId).map((f) => f.name).join(' / ') : '';
  const el = h(`<div class="card conn-card ${selectedId === c.id ? 'selected' : ''}" data-id="${esc(c.id)}" draggable="true" style="--c:${esc(c.color || meta.color)}">
    <div class="card-head">
      <div class="avatar">${icon('database')}</div>
      <div style="min-width:0;flex:1">
        <div class="card-title">${esc(c.name)}</div>
        <div class="card-sub">${esc(target(c))}</div>
      </div>
    </div>
    <div class="quick">
      <button class="icon-btn" data-a="edit" title="${esc(t('common.edit'))}">${icon('edit')}</button>
      <button class="icon-btn connect" data-a="open" title="${esc(t('common.connect'))}">${icon('play')}</button>
    </div>
    <div class="card-foot">
      <span class="tag prov" style="--c:${meta.color}">${icon('database')}${esc(meta.short)}</span>
      ${c.readOnly ? `<span class="tag ro" title="${esc(t('form.readOnly'))}">${icon('lock')}${esc(t('app.readOnlyTag'))}</span>` : `<span class="tag rw">${icon('unlock')}${esc(t('app.writeTag'))}</span>`}
      ${c.ssh.enabled ? `<span class="tag">${icon('key')}SSH</span>` : ''}
      ${where ? `<span class="tag">${icon('folder')}${esc(where)}</span>` : ''}
    </div></div>`);
  if (c.comments) el.title = c.comments;
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'open') return void api.openConnection(c.id);
    if (a === 'edit') return void editConnection(c);
    selectedId = c.id;
    updateSelectionUI();
  });
  el.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('[data-a]')) return;
    void api.openConnection(c.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectedId = c.id;
    updateSelectionUI();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.connect'), icon: 'play', kbd: 'Enter', action: () => void api.openConnection(c.id) },
      '-',
      { label: t('common.edit'), icon: 'edit', kbd: 'F2', action: () => void editConnection(c) },
      { label: t('app.duplicate'), icon: 'copy', action: () => void api.duplicateConnection(c.id) },
      { label: t('app.moveToFolder'), icon: 'move', action: () => void moveDialog('conn', c) },
      '-',
      { label: t('common.delete'), icon: 'trash', danger: true, kbd: 'Del', action: () => void deleteConnection(c) },
    ]);
  });
  el.addEventListener('dragstart', (e) => { e.dataTransfer!.setData(DND, JSON.stringify({ type: 'conn', id: c.id })); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

// Sürükle-bırak: bağlantı/klasörü bir klasöre (veya üst seviyeye) taşı
function makeDropTarget(el: HTMLElement, folderId: string | null) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer!.types.includes(DND)) return;
    depth++;
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drop'); } });
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer!.types.includes(DND)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; }
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove('drop');
    const d = JSON.parse(e.dataTransfer!.getData(DND) || '{}') as { type?: string; id?: string };
    if (d.type === 'conn' && d.id) {
      await api.moveConnection(d.id, folderId);
      toast(t('app.connMoved'), { type: 'ok', sub: folderId ? folderById(folderId)?.name : t('app.all') });
    } else if (d.type === 'folder' && d.id && d.id !== folderId) {
      if (!(await api.moveFolder(d.id, folderId))) toast(t('app.folderIntoSelf'), { type: 'err' });
    }
  });
}

// --- Klasör işlemleri ----------------------------------------------------------
async function newFolder(parentId: string | null = currentFolder) {
  const name = await prompt(t('common.newFolder'), { label: t('common.folderName'), placeholder: t('app.folderPh'), okText: t('common.create'), iconName: 'folderPlus' });
  if (name) await api.saveFolder({ name, parentId });
}

async function renameFolder(f: Folder) {
  const name = await prompt(t('app.renameFolder'), { label: t('common.folderName'), value: f.name, okText: t('common.save') });
  if (name) await api.saveFolder({ id: f.id, name });
}

async function deleteFolder(f: Folder) {
  const n = countIn(f.id);
  if (await confirmBox(t('app.deleteFolder'), t('app.deleteFolderMsg', { name: esc(f.name) }) + (n ? t('app.deleteFolderConns', { n }) : ''))) await api.deleteFolder(f.id);
}

function folderOptions(selected: string | null, excludeId?: string) {
  const out = [`<option value="">${esc(t('app.rootFolder'))}</option>`];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of data.folders.filter((x) => (x.parentId || null) === parentId).sort(sortByName)) {
      if (f.id === excludeId) continue;
      out.push(`<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${'&nbsp;&nbsp;&nbsp;'.repeat(depth)}${esc(f.name)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return out.join('');
}

async function moveDialog(type: 'conn' | 'folder', item: PublicConnection | Folder) {
  const current = type === 'conn' ? (item as PublicConnection).folderId : (item as Folder).parentId;
  const res = await openModal<{ v: string | null }>({
    title: t('app.moveTitle', { name: item.name }), iconName: 'move',
    body: `<div class="field"><label>${esc(t('app.targetFolder'))}</label><select class="input" id="mv">${folderOptions(current, type === 'folder' ? item.id : undefined)}</select></div>`,
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.move'), cls: 'primary', onClick: (m) => ({ v: $<HTMLSelectElement>('#mv', m).value || null }) },
    ],
  });
  if (!res) return;
  if (type === 'conn') await api.moveConnection(item.id, res.v);
  else if (!(await api.moveFolder(item.id, res.v))) toast(t('app.folderIntoSelf'), { type: 'err' });
}

async function deleteConnection(c: PublicConnection) {
  if (await confirmBox(t('app.deleteConn'), t('app.deleteConnMsg', { name: esc(c.name), target: esc(target(c)) }))) {
    await api.deleteConnection(c.id);
    if (selectedId === c.id) selectedId = null;
  }
}

// --- Bağlantı formu ----------------------------------------------------------------
const opts = (list: [string, string][], v: string) => list.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');

async function editConnection(conn: PublicConnection | null, folderId?: string) {
  const isNew = !conn;
  const c: PublicConnection = conn ?? {
    id: '', name: '', provider: 'postgres', host: 'localhost', port: null, database: '', user: '', filePath: '', sslMode: 'prefer',
    readOnly: true, savePassword: true, color: COLORS[data.connections.length % COLORS.length], folderId: folderId ?? currentFolder, comments: '',
    ssh: { enabled: false, host: '', port: 22, user: '', auth: 'key', keyPath: '', hostKey: null }, createdAt: 0,
    hasPassword: false, hasSshPassword: false, hasSshPassphrase: false,
  };
  let provider: ProviderId = c.provider;
  let color = c.color;
  let sshAuth = c.ssh.auth;

  const body = h(`<div class="site-form">
    <div class="tabs" id="f-tabs">
      <button data-tab="general" class="on">${icon('database')}${esc(t('form.tabGeneral'))}</button>
      <button data-tab="security">${icon('lock')}${esc(t('form.tabSecurity'))}</button>
      <button data-tab="ssh" class="server-only">${icon('key')}${esc(t('form.tabSsh'))}</button>
    </div>

    <section class="tab-panel" data-panel="general">
      <div class="prov-grid" id="f-prov">${PROVIDERS.map((p) => `<button type="button" class="prov-btn" data-v="${p.id}" style="--pc:${p.color}">${icon(p.kind === 'file' ? 'file2' : 'database')}<span>${esc(p.short)}</span></button>`).join('')}</div>
      <div class="field"><label>${esc(t('form.name'))}</label><input class="input" id="f-name" placeholder="${esc(t('form.namePh'))}" value="${esc(c.name)}"></div>
      <div class="server-only" style="display:grid;gap:14px">
        <div class="row c-3-1">
          <div class="field"><label>${esc(t('form.host'))}</label><input class="input" id="f-host" placeholder="localhost" value="${esc(c.host)}" spellcheck="false"></div>
          <div class="field"><label>${esc(t('form.port'))}</label><input class="input" id="f-port" type="number" min="1" max="65535" value="${esc(c.port ?? '')}"></div>
        </div>
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('form.user'))}</label><input class="input" id="f-user" value="${esc(c.user)}" spellcheck="false" autocomplete="off"></div>
          <div class="field"><label>${esc(t('form.password'))}</label>
            <div class="pw-wrap"><input class="input" id="f-pass" type="password" placeholder="${c.hasPassword ? esc(t('form.pwSaved')) : ''}" autocomplete="new-password">
            <button class="icon-btn" id="f-eye" type="button" title="${esc(t('common.show'))}">${icon('eye')}</button></div></div>
        </div>
        <div class="field"><label>${esc(t('form.database'))}</label><input class="input" id="f-db" value="${esc(c.database)}" placeholder="${esc(t('form.databasePh'))}" spellcheck="false"></div>
      </div>
      <div class="file-only field"><label>${esc(t('form.file'))}</label>
        <div class="key-wrap"><input class="input" id="f-file" value="${esc(c.filePath)}" placeholder="${esc(t('form.filePh'))}" spellcheck="false"><button class="btn" id="f-filepick" type="button">${esc(t('common.choose'))}</button></div>
        <small class="hint" id="f-file-hint"></small></div>
      <div class="row c-1-1">
        <div class="field"><label>${esc(t('form.folder'))}</label><select class="input" id="f-folder">${folderOptions(c.folderId)}</select></div>
        <div class="field"><label>${esc(t('form.color'))}</label><div class="colors" id="f-colors" style="height:36px;align-items:center"></div></div>
      </div>
      <div class="field"><label>${esc(t('form.comments'))}</label><textarea class="input plain" id="f-notes" rows="2">${esc(c.comments)}</textarea></div>
    </section>

    <section class="tab-panel hidden" data-panel="security">
      <label class="check"><input type="checkbox" id="f-ro" ${c.readOnly ? 'checked' : ''}>
        <span>${esc(t('form.readOnly'))}<small>${esc(t('form.readOnlyHint'))}</small></span></label>
      <div class="server-only" style="display:grid;gap:14px">
        <label class="check"><input type="checkbox" id="f-savepw" ${c.savePassword ? 'checked' : ''}>
          <span>${esc(t('form.savePassword'))}<small>${esc(t('form.savePasswordHint'))}</small></span></label>
        <div class="field"><label>${esc(t('form.ssl'))}</label><select class="input" id="f-ssl">${opts([
          ['prefer', t('form.sslPrefer')], ['require', t('form.sslRequire')], ['verify-full', t('form.sslVerify')], ['disable', t('form.sslDisable')],
        ], c.sslMode)}</select><small class="hint">${esc(t('form.sslHint'))}</small></div>
      </div>
    </section>

    <section class="tab-panel hidden" data-panel="ssh">
      <label class="check"><input type="checkbox" id="f-ssh" ${c.ssh.enabled ? 'checked' : ''}><span>${esc(t('form.sshEnable'))}<small>${esc(t('form.sshHint'))}</small></span></label>
      <div id="ssh-fields" style="display:grid;gap:14px">
        <div class="row c-3-1">
          <div class="field"><label>${esc(t('form.sshHost'))}</label><input class="input" id="f-sshhost" value="${esc(c.ssh.host)}" spellcheck="false"></div>
          <div class="field"><label>${esc(t('form.port'))}</label><input class="input" id="f-sshport" type="number" value="${esc(c.ssh.port || 22)}"></div>
        </div>
        <div class="field"><label>${esc(t('form.user'))}</label><input class="input" id="f-sshuser" value="${esc(c.ssh.user)}" spellcheck="false"></div>
        <div class="field"><label>${esc(t('form.sshAuth'))}</label>
          <div class="seg" id="f-sshauth"><button data-v="key">${esc(t('form.sshKey'))}</button><button data-v="password">${esc(t('form.password'))}</button><button data-v="agent">${esc(t('form.sshAgent'))}</button></div></div>
        <div id="ssh-key" style="display:grid;gap:14px">
          <div class="field"><label>${esc(t('form.keyFile'))}</label>
            <div class="key-wrap"><input class="input" id="f-key" value="${esc(c.ssh.keyPath)}" placeholder="C:\\Users\\…\\.ssh\\id_ed25519" spellcheck="false"><button class="btn" id="f-keypick" type="button">${esc(t('common.choose'))}</button></div></div>
          <div class="field"><label>${esc(t('form.passphrase'))}</label><input class="input" id="f-phrase" type="password" placeholder="${esc(c.hasSshPassphrase ? t('form.passSaved') : t('form.passEmpty'))}"></div>
        </div>
        <div class="field" id="ssh-pw"><label>${esc(t('form.sshPassword'))}</label><input class="input" id="f-sshpass" type="password" placeholder="${c.hasSshPassword ? esc(t('form.pwSaved')) : ''}"></div>
        ${c.ssh.hostKey ? `<div class="fp">${esc(t('form.hostKey', { fp: c.ssh.hostKey }))}</div>` : ''}
      </div>
    </section>

    <div class="test-result" id="f-result"></div>
  </div>`);

  const q = <T extends HTMLElement = HTMLInputElement>(s: string) => $<T>(s, body);
  $$('#f-tabs button', body).forEach((b) => (b.onclick = () => {
    $$('#f-tabs button', body).forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab-panel', body).forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
  }));
  const goTab = (name: string) => q(`#f-tabs button[data-tab="${name}"]`).click();

  const setProvider = (id: ProviderId) => {
    const prev = providerMeta(provider);
    provider = id;
    const meta = providerMeta(id);
    $$('#f-prov .prov-btn', body).forEach((b) => b.classList.toggle('on', b.dataset.v === id));
    const file = meta.kind === 'file';
    $$('.server-only', body).forEach((x) => x.classList.toggle('hidden', file));
    $$('.file-only', body).forEach((x) => x.classList.toggle('hidden', !file));
    q('#f-port').placeholder = String(meta.defaultPort ?? '');
    const user = q<HTMLInputElement>('#f-user');
    if (!user.value || user.value === prev.defaultUser) user.value = meta.defaultUser ?? '';
    q('#f-file-hint').textContent = id === 'duckdb' ? t('form.duckdbHint') : t('form.sqliteHint');
  };
  $$('#f-prov .prov-btn', body).forEach((b) => (b.onclick = () => setProvider(b.dataset.v as ProviderId)));
  setProvider(provider);
  if (!isNew) $$('#f-prov .prov-btn', body).forEach((b) => ((b as HTMLButtonElement).disabled = b.dataset.v !== provider && providerMeta(b.dataset.v as ProviderId).kind !== providerMeta(provider).kind));

  const syncSsh = () => {
    q('#ssh-fields').classList.toggle('hidden', !q<HTMLInputElement>('#f-ssh').checked);
    $$('#f-sshauth button', body).forEach((b) => b.classList.toggle('on', b.dataset.v === sshAuth));
    q('#ssh-key').classList.toggle('hidden', sshAuth !== 'key');
    q('#ssh-pw').classList.toggle('hidden', sshAuth !== 'password');
  };
  q('#f-ssh').onchange = syncSsh;
  $$('#f-sshauth button', body).forEach((b) => (b.onclick = () => { sshAuth = b.dataset.v as typeof sshAuth; syncSsh(); }));
  syncSsh();

  q('#f-eye').onclick = () => {
    const p = q<HTMLInputElement>('#f-pass');
    p.type = p.type === 'password' ? 'text' : 'password';
    q('#f-eye').innerHTML = icon(p.type === 'password' ? 'eye' : 'eyeOff');
  };
  q('#f-filepick').onclick = async () => {
    const p = await api.openFileDialog({ provider, defaultPath: q<HTMLInputElement>('#f-file').value || undefined });
    if (p) {
      q<HTMLInputElement>('#f-file').value = p;
      if (!q<HTMLInputElement>('#f-name').value) q<HTMLInputElement>('#f-name').value = p.split(/[\\/]/).pop() || '';
    }
  };
  q('#f-keypick').onclick = async () => { const p = await api.openFileDialog({}); if (p) q<HTMLInputElement>('#f-key').value = p; };

  const colorsEl = q('#f-colors');
  for (const col of COLORS) {
    const b = h(`<button type="button" style="--c:${col}" class="${col === color ? 'on' : ''}"></button>`);
    b.onclick = () => { color = col; $$('button', colorsEl).forEach((x) => x.classList.toggle('on', x === b)); };
    colorsEl.appendChild(b);
  }

  const readForm = (): ConnectionForm => ({
    id: c.id || undefined,
    name: q<HTMLInputElement>('#f-name').value.trim(),
    provider,
    host: q<HTMLInputElement>('#f-host').value.trim(),
    port: Number(q<HTMLInputElement>('#f-port').value) || null,
    database: q<HTMLInputElement>('#f-db').value.trim(),
    user: q<HTMLInputElement>('#f-user').value.trim(),
    password: q<HTMLInputElement>('#f-pass').value,
    filePath: q<HTMLInputElement>('#f-file').value.trim(),
    sslMode: q<HTMLSelectElement>('#f-ssl').value as SslMode,
    readOnly: q<HTMLInputElement>('#f-ro').checked,
    savePassword: q<HTMLInputElement>('#f-savepw').checked,
    color,
    folderId: q<HTMLSelectElement>('#f-folder').value || null,
    comments: q<HTMLTextAreaElement>('#f-notes').value,
    ssh: {
      enabled: q<HTMLInputElement>('#f-ssh').checked,
      host: q<HTMLInputElement>('#f-sshhost').value.trim(),
      port: Number(q<HTMLInputElement>('#f-sshport').value) || 22,
      user: q<HTMLInputElement>('#f-sshuser').value.trim(),
      auth: sshAuth,
      keyPath: q<HTMLInputElement>('#f-key').value.trim(),
      hostKey: c.ssh.hostKey,
    },
    sshPassword: q<HTMLInputElement>('#f-sshpass').value,
    sshPassphrase: q<HTMLInputElement>('#f-phrase').value,
  });

  const validate = () => {
    const f = readForm();
    const file = providerMeta(f.provider).kind === 'file';
    let ok = true;
    const mark = (id: string, bad: boolean, tab: string) => { q(id).classList.toggle('invalid', bad); if (bad && ok) { ok = false; goTab(tab); } };
    if (!file) mark('#f-host', !f.host, 'general');
    if (f.provider === 'sqlite') mark('#f-file', !f.filePath, 'general');
    if (!file && f.ssh.enabled) {
      mark('#f-sshhost', !f.ssh.host, 'ssh');
      mark('#f-sshuser', !f.ssh.user, 'ssh');
      if (f.ssh.auth === 'key') mark('#f-key', !f.ssh.keyPath, 'ssh');
    }
    return ok;
  };

  const showResult = (cls: string, html: string) => {
    const r = q('#f-result');
    r.className = `test-result show ${cls}`;
    r.innerHTML = html;
  };

  const runTest = async (btn: HTMLButtonElement) => {
    if (!validate()) return false;
    btn.disabled = true;
    showResult('', `<span class="spin" style="color:var(--accent);margin-top:2px"></span><div>${esc(t('form.connecting'))}</div>`);
    const res = await api.testConnection(readForm());
    btn.disabled = false;
    if (res.ok && res.info) {
      const lines = [esc(res.info.product)];
      if (res.info.database) lines.push(esc(t('form.testDb', { db: res.info.database, user: res.info.user ?? '' })));
      if (res.info.tls === false && providerMeta(provider).kind === 'server') lines.push(`<span style="color:var(--warn)">${esc(t('form.noTls'))}</span>`);
      showResult('ok', `${icon('check')}<div><b>${esc(t('form.testOk'))}</b> · ${res.ms} ms<br>${lines.join('<br>')}
        ${res.sshFingerprint ? `<div class="fp">${esc(t('form.hostKey', { fp: res.sshFingerprint }))}</div>` : ''}</div>`);
    } else {
      showResult('err', `${icon('x')}<div><b>${esc(t('form.testFail'))}</b><br>${esc(res.message)}</div>`);
    }
    return false;
  };

  const save = async (andConnect: boolean) => {
    if (!validate()) return false;
    const id = await api.saveConnection(readForm());
    toast(isNew ? t('form.saved') : t('form.changesSaved'), { type: 'ok', sub: readForm().name || readForm().host || readForm().filePath });
    if (andConnect) void api.openConnection(id);
    return true;
  };

  await openModal({
    title: isNew ? t('form.titleNew') : t('form.titleEdit', { name: c.name }),
    iconName: 'database',
    width: 660,
    body,
    buttons: [
      { label: t('form.test'), icon: 'bolt', left: true, onClick: (_m, btn) => runTest(btn) },
      { label: t('common.cancel'), cls: 'ghost', value: null },
      { label: t('form.saveConnect'), onClick: () => save(true) },
      { label: t('common.save'), cls: 'primary', onClick: () => save(false) },
    ],
  });
}
