// Ana süreç: pencereler, IPC, oturumlar. Uygulama Mastertool hesabıyla girişsiz açılmaz.
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createT, resolveLanguage, type T } from '../shared/i18n';
import { PROVIDERS, providerMeta } from '../shared/providers';
import type { ConnectionForm, ConnectionProfile, Settings } from '../shared/types';
import type { ConnectionConfig, NodePath, TreeNode } from '../core/provider';
import type { ExecuteRequest } from '../core/engine/executor';
import type { ExportFormat } from '../core/engine/export';
import { createServices, type Services } from './container';
import { secretRef } from './store';
import { DbHost } from './dbhost-client';
import { WEB_BASE, WEB_PAGES } from './account/mastertool';
import { friendlyError } from './errors';

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const HOST_ENTRY = path.join(ROOT, 'dbhost', 'host.js');
const page = (name: string) => path.join(ROOT, 'renderer', name, `${name === 'main' ? 'index' : name}.html`);

let svc: Services;
let t: T = createT('en');
const currentLang = () => svc?.store.data.settings.language || resolveLanguage(app.getLocale());
const applyLanguage = () => (t = createT(currentLang()));

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------
function applyAppTheme() {
  const v = svc.store.data.settings.appTheme;
  nativeTheme.themeSource = v === 'light' || v === 'system' ? v : 'dark';
}
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#eef2f7');

const webPreferences = {
  preload: path.join(ROOT, 'preload', 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
};

function broadcast(channel: string, data: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, data);
}
const broadcastStore = () => broadcast('store:changed', svc.store.public());

// ---------------------------------------------------------------------------
// Pencereler
// ---------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let loginNotice: string | null = null;

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 440, height: 640, resizable: false, maximizable: false, backgroundColor: windowBg(),
    title: 'SQL Master', icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  loginWindow.setMenuBarVisibility(false);
  void loginWindow.loadFile(page('login'));
  loginWindow.on('closed', () => (loginWindow = null));
}

// Oturum yoksa ya da düştüyse: giriş ekranı açılır, diğer tüm pencereler kapanır
function showLogin(notice?: string) {
  loginNotice = notice ?? null;
  if (!loginWindow) createLoginWindow();
  else loginWindow.focus();
  for (const w of BrowserWindow.getAllWindows()) if (w !== loginWindow) w.destroy();
  mainWindow = null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 760, minHeight: 500, backgroundColor: windowBg(),
    title: 'SQL Master', icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(page('main'));
  mainWindow.on('closed', () => (mainWindow = null));
}

function showMainWindow() {
  if (!svc.account.isLoggedIn()) return loginWindow ? loginWindow.focus() : showLogin();
  if (!mainWindow) createMainWindow();
  if (mainWindow!.isMinimized()) mainWindow!.restore();
  mainWindow!.show();
  mainWindow!.focus();
}

// ---------------------------------------------------------------------------
// Bağlantı pencereleri ve oturumları (pencere başına bir veritabanı süreci)
// ---------------------------------------------------------------------------
interface ConnSession {
  profileId: string;
  host: DbHost;
  wc: WebContents;
  cfg: ConnectionConfig | null;
  readOnly: boolean;
  runs: Map<string, { sql: string; started: number; database?: string; rows: number; cancelTimer?: NodeJS.Timeout }>;
}
const sessions = new Map<number, ConnSession>();

function openConnectionWindow(id: string) {
  if (!svc.account.isLoggedIn()) return;
  const c = svc.store.get(id);
  if (!c) return;
  const win = new BrowserWindow({
    width: 1440, height: 880, minWidth: 900, minHeight: 520, backgroundColor: windowBg(),
    title: `${c.name} — SQL Master`, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  win.setMenuBarVisibility(false);
  void win.loadFile(page('conn'), { query: { id } });
  const wc = win.webContents;
  const wcId = wc.id;
  const host = new DbHost(HOST_ENTRY, svc.log);
  const s: ConnSession = { profileId: id, host, wc, cfg: null, readOnly: c.readOnly, runs: new Map() };
  host.onEvent = (runId, ev) => {
    if (process.env.SQLM_TRACE) console.log('[trace]', runId, ev.type, ev.type === 'rows' ? ev.rows.length : '');
    const run = s.runs.get(runId);
    if (run && ev.type === 'rows') run.rows += ev.rows.length;
    if (!wc.isDestroyed()) wc.send('db:event', { runId, ev });
  };
  host.onProgress = (runId, rows) => !wc.isDestroyed() && wc.send('db:progress', { runId, rows });
  host.onExit = (code) => {
    if (code !== 0) svc.log.warn('Veritabanı süreci beklenmedik şekilde kapandı', { code });
    if (!wc.isDestroyed() && sessions.has(wcId)) wc.send('db:reset', { reason: 'exit' });
  };
  sessions.set(wcId, s);
  svc.store.touch(id);
  win.on('close', (e) => {
    if (!s.runs.size) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: [t('main.closeAnyway'), t('common.cancel')], defaultId: 1, cancelId: 1,
      title: 'SQL Master', message: t('main.closeRunning'),
    });
    if (choice !== 0) e.preventDefault();
  });
  win.on('closed', () => {
    sessions.delete(wcId);
    host.request('close', {}).catch(() => {}).finally(() => setTimeout(() => host.kill(), 500));
  });
}

function getSession(e: IpcMainInvokeEvent): ConnSession {
  const s = sessions.get(e.sender.id);
  if (!s) throw new Error(t('main.errNoSession'));
  return s;
}

/** Profil + anahtar zinciri → çözülmüş bağlantı yapılandırması (yalnız bellekte) */
function resolveConfig(c: ConnectionProfile, overrides: { password?: string } = {}): ConnectionConfig {
  const meta = providerMeta(c.provider);
  let privateKey: string | undefined;
  if (c.ssh.enabled && c.ssh.auth === 'key') {
    try { privateKey = fs.readFileSync(c.ssh.keyPath, 'utf8'); } catch { throw new Error(t('main.errKeyFile', { path: c.ssh.keyPath })); }
  }
  return {
    provider: c.provider,
    host: c.host,
    port: c.port ?? meta.defaultPort,
    database: c.database,
    user: c.user,
    password: overrides.password ?? svc.secrets.get(secretRef.password(c.id)),
    filePath: c.filePath,
    ssl: { mode: c.sslMode },
    readOnly: c.readOnly,
    appName: 'SQL Master',
    ssh: c.ssh.enabled
      ? {
          enabled: true, host: c.ssh.host, port: c.ssh.port, user: c.ssh.user, auth: c.ssh.auth, privateKey,
          passphrase: svc.secrets.get(secretRef.sshPassphrase(c.id)), password: svc.secrets.get(secretRef.sshPassword(c.id)), hostKey: c.ssh.hostKey,
        }
      : undefined,
  };
}

/** Form → geçici profil (test için; boş parola alanı kayıtlıyı kullanır) */
function profileFromForm(form: ConnectionForm): { profile: ConnectionProfile; password?: string } {
  const existing = form.id ? svc.store.get(form.id) : undefined;
  const profile = svc.store.normalize(form, existing);
  if (existing && profile.ssh.host === existing.ssh.host) profile.ssh.hostKey = existing.ssh.hostKey;
  if (existing) profile.id = existing.id;
  return { profile, password: form.password || (existing && !form.clearPassword ? svc.secrets.get(secretRef.password(existing.id)) : '') };
}

const wrap = <A, R>(fn: (e: IpcMainInvokeEvent, a: A) => R | Promise<R>) => async (e: IpcMainInvokeEvent, a: A) => {
  try {
    return await fn(e, a);
  } catch (err) {
    throw new Error(friendlyError(err, t));
  }
};

// ---------------------------------------------------------------------------
// IPC: genel
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.on('app:lang', (e) => (e.returnValue = currentLang()));
  ipcMain.on('app:version', (e) => (e.returnValue = app.getVersion()));
  ipcMain.handle('app:providers', () => PROVIDERS);
  ipcMain.handle('app:showMain', () => showMainWindow());
  ipcMain.handle('store:get', () => svc.store.public());
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text ?? '')));

  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = svc.store.data.settings;
    const quiet = Object.keys(patch).every((k) => k === 'treeWidth');
    Object.assign(s, patch);
    svc.store.save({ library: !quiet });
    if ('appTheme' in patch) applyAppTheme();
    if ('language' in patch) {
      applyLanguage();
      mainWindow?.webContents.reload();
      loginWindow?.webContents.reload();
      return;
    }
    if (!quiet) broadcastStore();
  });

  ipcMain.handle('dialog:openFile', async (e, opts: { provider?: string; save?: boolean; defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const meta = PROVIDERS.find((p) => p.id === opts.provider);
    const filters = meta?.fileExtensions ? [{ name: meta.name, extensions: meta.fileExtensions }, { name: '*', extensions: ['*'] }] : [{ name: '*', extensions: ['*'] }];
    if (opts.save) {
      const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath, filters });
      return r.canceled ? null : r.filePath;
    }
    const r = await dialog.showOpenDialog(win, { defaultPath: opts.defaultPath, filters, properties: ['openFile', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // --- Hesap -----------------------------------------------------------------------
  ipcMain.handle('account:state', () => ({ ...svc.account.state(), notice: loginNotice, appVersion: app.getVersion() }));
  ipcMain.handle('account:login', async (_e, { email, password, remember }: { email: string; password: string; remember: boolean }) => {
    try {
      const { backupFile } = await svc.account.login(email, password, remember);
      loginNotice = null;
      svc.log.info('Giriş yapıldı');
      if (!mainWindow) createMainWindow();
      loginWindow?.destroy();
      if (backupFile) mainWindow!.webContents.once('did-finish-load', () => mainWindow?.webContents.send('account:backup', backupFile));
      void svc.account.start();
      return { ok: true };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      svc.log.warn('Giriş başarısız', { code: e.code });
      return { ok: false, code: e.code || 'error', message: e.message };
    }
  });
  ipcMain.handle('account:logout', async () => {
    await svc.account.logout();
    showLogin();
  });
  ipcMain.handle('account:syncNow', () => svc.account.syncNow());
  ipcMain.handle('account:setSync', async (_e, on: boolean) => {
    try { await svc.account.setSyncEnabled(on); return { ok: true }; } catch (e) { return { ok: false, code: (e as { code?: string }).code }; }
  });
  ipcMain.handle('account:deleteRemote', async () => {
    try { await svc.account.deleteRemote(); return { ok: true }; } catch (e) { return { ok: false, code: (e as { code?: string }).code }; }
  });
  // Hesap sayfaları varsayılan tarayıcıda açılır (yalnız bu adresler)
  ipcMain.handle('account:openWeb', (_e, p: string) => {
    if (WEB_PAGES[p]) void shell.openExternal(WEB_BASE + WEB_PAGES[p]);
  });

  // --- Bağlantılar ve klasörler -----------------------------------------------------
  ipcMain.handle('conn:save', (_e, form: ConnectionForm) => {
    const id = svc.store.saveConnection(form);
    broadcastStore();
    return id;
  });
  ipcMain.handle('conn:delete', (_e, id: string) => { svc.store.deleteConnection(id); broadcastStore(); });
  ipcMain.handle('conn:duplicate', (_e, id: string) => { svc.store.duplicateConnection(id, t('main.copySuffix')); broadcastStore(); });
  ipcMain.handle('conn:move', (_e, { id, folderId }: { id: string; folderId: string | null }) => { svc.store.moveConnection(id, folderId); broadcastStore(); });
  ipcMain.handle('conn:open', (_e, id: string) => openConnectionWindow(id));
  ipcMain.handle('conn:test', async (_e, form: ConnectionForm) => {
    const started = Date.now();
    const host = new DbHost(HOST_ENTRY, svc.log);
    try {
      const { profile, password } = profileFromForm(form);
      const cfg = resolveConfig(profile, { password });
      const r = await host.request('connect', { cfg });
      return { ok: true, ms: Date.now() - started, info: r.info, sshFingerprint: r.sshFingerprint, firstSsh: !!r.sshFingerprint && !profile.ssh.hostKey };
    } catch (err) {
      return { ok: false, message: friendlyError(err, t) };
    } finally {
      host.request('close', {}).catch(() => {}).finally(() => host.kill());
    }
  });
  ipcMain.handle('folder:save', (_e, f: { id?: string; name: string; parentId?: string | null }) => { const id = svc.store.saveFolder(f); broadcastStore(); return id; });
  ipcMain.handle('folder:move', (_e, { id, parentId }: { id: string; parentId: string | null }) => { const ok = svc.store.moveFolder(id, parentId); broadcastStore(); return ok; });
  ipcMain.handle('folder:delete', (_e, id: string) => { svc.store.deleteFolder(id); broadcastStore(); });

  // ---------------------------------------------------------------------------
  // IPC: bağlantı penceresi
  // ---------------------------------------------------------------------------
  ipcMain.handle('cw:info', (e) => {
    const s = getSession(e);
    const c = svc.store.get(s.profileId);
    if (!c) throw new Error(t('main.errConnNotFound'));
    const pub = svc.store.publicConnection(c);
    return { connection: pub, needsPassword: providerMeta(c.provider).kind === 'server' && !c.savePassword, settings: svc.store.data.settings };
  });

  ipcMain.handle('cw:connect', async (e, opts: { password?: string } = {}) => {
    const s = getSession(e);
    const c = svc.store.get(s.profileId);
    if (!c) return { ok: false, message: t('main.errConnNotFound') };
    try {
      s.cfg = resolveConfig(c, opts);
      s.readOnly = c.readOnly;
      const r = await s.host.request('connect', { cfg: s.cfg });
      if (r.sshFingerprint && !c.ssh.hostKey) svc.store.rememberHostKey(c.id, r.sshFingerprint);
      svc.log.info('Bağlandı', { provider: c.provider, product: r.info.product });
      return { ok: true, info: r.info, readOnly: s.readOnly };
    } catch (err) {
      svc.log.warn('Bağlantı hatası', { provider: c.provider, message: (err as Error).message });
      return { ok: false, message: friendlyError(err, t) };
    }
  });

  ipcMain.handle('db:children', wrap((e, node: TreeNode | null) => getSession(e).host.request('children', { node })));
  ipcMain.handle('db:ddl', wrap((e, node: TreeNode) => getSession(e).host.request('ddl', { node })));
  ipcMain.handle('db:columns', wrap((e, p: NodePath) => getSession(e).host.request('columns', { path: p })));
  ipcMain.handle('db:completion', wrap((e, database?: string) => getSession(e).host.request('completion', { database })));

  ipcMain.handle('db:execute', async (e, { runId, req }: { runId: string; req: Omit<ExecuteRequest, 'readOnly'> }) => {
    const s = getSession(e);
    const run = { sql: req.sql, started: Date.now(), database: req.database, rows: 0 };
    s.runs.set(runId, run);
    try {
      const limit = req.limit ?? svc.store.data.settings.rowLimit;
      const r = await s.host.request('execute', { runId, req: { ...req, limit, readOnly: s.readOnly } });
      svc.history.add({ at: run.started, connectionId: s.profileId, database: req.database, sql: req.sql, ms: Date.now() - run.started, ok: !r.errors, rows: run.rows });
      return r;
    } catch (err) {
      svc.history.add({ at: run.started, connectionId: s.profileId, database: req.database, sql: req.sql, ms: Date.now() - run.started, ok: false });
      throw new Error(friendlyError(err, t));
    } finally {
      clearTimeout(s.runs.get(runId)?.cancelTimer);
      s.runs.delete(runId);
    }
  });

  // İptal: önce sunucu tarafında (pg_cancel_backend, KILL QUERY…), 5 sn'de bitmezse süreç öldürülür
  ipcMain.handle('db:cancel', async (e, runId: string) => {
    const s = getSession(e);
    const run = s.runs.get(runId);
    if (!run) return;
    run.cancelTimer = setTimeout(async () => {
      if (!s.runs.has(runId)) return;
      svc.log.warn('İptal yanıt vermedi; veritabanı süreci yeniden başlatılıyor');
      s.host.kill();
      if (!s.wc.isDestroyed()) s.wc.send('db:reset', { reason: 'cancel' });
    }, 5000);
    await s.host.request('cancel', { runId }).catch(() => {});
  });

  ipcMain.handle('db:setReadOnly', wrap(async (e, on: boolean) => {
    const s = getSession(e);
    await s.host.request('setReadOnly', { on });
    s.readOnly = on;
    if (s.cfg) s.cfg.readOnly = on;
    svc.log.info('Salt okunur kip değişti', { on });
    return on;
  }));

  ipcMain.handle('db:export', wrap(async (e, { runId, sql, database, format, defaultName }: { runId: string; sql: string; database?: string; format: ExportFormat; defaultName: string }) => {
    const s = getSession(e);
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const ext = format === 'jsonl' ? 'jsonl' : format;
    const r = await dialog.showSaveDialog(win, { defaultPath: `${defaultName}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    s.runs.set(runId, { sql, started: Date.now(), database, rows: 0 });
    try {
      const res = await s.host.request('export', { runId, sql, database, format, filePath: r.filePath });
      return { ...res, filePath: r.filePath };
    } finally {
      s.runs.delete(runId);
    }
  }));

  ipcMain.handle('history:list', (e) => svc.history.list(getSession(e).profileId));
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));
}

// ---------------------------------------------------------------------------
app.setAppUserModelId('app.sqlmaster');
// Uçtan uca testler için ayrı kullanıcı klasörü (yalnızca geliştirme)
if (!app.isPackaged && process.env.SQLM_USER_DATA) app.setPath('userData', process.env.SQLM_USER_DATA);

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  void app.whenReady().then(() => {
    const devAccount = !app.isPackaged && process.env.SQLM_DEV_ACCOUNT === '1';
    svc = createServices({
      userDataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
      cipher: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(b),
      },
      devAccount,
      accountEvents: {
        onStatus: (st) => broadcast('account:status', st),
        onSessionExpired: (code) => showLogin(t(code === 'app_disabled' ? 'auth.errAppDisabled' : code === 'wrong_app' ? 'auth.errWrongApp' : 'auth.errSessionExpired')),
        onUpdate: (info) => mainWindow?.webContents.send('app:update', info),
      },
      onLibraryApplied: () => {
        const prev = currentLang();
        applyAppTheme();
        applyLanguage();
        broadcastStore();
        if (currentLang() !== prev) mainWindow?.webContents.reload();
      },
    });
    svc.log.info('SQL Master başlatıldı', { version: app.getVersion(), devAccount, keychain: svc.secrets.persistent });
    applyLanguage();
    applyAppTheme();
    registerIpc();
    // "Beni hatırla" ile saklı oturum varsa doğrudan açılır (çevrimdışıyken yerel kütüphaneyle)
    if (svc.account.isLoggedIn()) {
      createMainWindow();
      void svc.account.start();
    } else {
      createLoginWindow();
    }
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && showMainWindow());
  });

  app.on('window-all-closed', () => {
    svc?.store.flush();
    app.quit();
  });
}
