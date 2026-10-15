// Mastertool hesabı + uçtan uca şifreli kütüphane senkronu (SSH Master v1.2 / FTP Masters v1.1 ile aynı model).
// Uçlar varsayılan olarak /api/sq/* (sözleşme HEPGO sunucu oturumundan kesinleşecek; bkz. docs/account-contract.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AccountState } from '../../shared/types';
import { AccountError, compareVersions, type AccountEvents, type IAccountService } from './types';
import { decryptLibrary, deriveKeys, encryptLibrary, hashOf, type Kdf } from './crypto';
import { itemsFromMeta, itemsKey, merge, refreshMeta, SETTINGS_ID, type SyncItem } from './sync';
import type { LibraryAdapter } from './library';

export const API_BASE = process.env.SQLM_API || 'https://sqlmaster.app';
export const API_PREFIX = '/api/sq';
export const WEB_BASE = process.env.SQLM_WEB || 'https://mastertool.download';
export const WEB_PAGES: Record<string, string> = { forgot: '/sifremi-unuttum', register: '/kayit', account: '/hesabim' };

const SYNC_DEBOUNCE_MS = 3000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

export interface MastertoolDeps extends AccountEvents {
  userDataDir: string;
  appVersion: string;
  /** OS anahtar zinciriyle şifreleme (oturum belirteci ve şifreleme anahtarı için) */
  protect(text: string): string;
  unprotect(text: string): string;
  library: LibraryAdapter;
  fetch?: typeof fetch;
  log?: (msg: string, data?: unknown) => void;
}

interface Session {
  token: string;
  user: { id: string; email: string; name?: string };
  encKey: Buffer;
  kdfSalt: string;
  syncEnabled: boolean;
}

export function createMastertoolAccount(deps: MastertoolDeps): IAccountService {
  const file = path.join(deps.userDataDir, 'account.json');
  const doFetch = deps.fetch ?? fetch;

  interface Saved {
    deviceId: string; email: string; remember: boolean; lastUserId: string | null;
    token?: string; encKey?: string; user?: Session['user']; kdfSalt?: string; syncEnabled?: boolean;
    lastSyncAt?: number | null; libraryVersion?: number | null;
  }
  let saved: Saved = { deviceId: crypto.randomUUID(), email: '', remember: true, lastUserId: null };
  try { saved = { ...saved, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* ilk açılış */ }

  let session: Session | null = null;
  if (saved.token && saved.encKey && saved.user) {
    try {
      session = {
        token: deps.unprotect(saved.token),
        encKey: Buffer.from(deps.unprotect(saved.encKey), 'base64'),
        user: saved.user,
        kdfSalt: saved.kdfSalt ?? '',
        syncEnabled: saved.syncEnabled !== false,
      };
    } catch { session = null; }
  }

  const status: { state: AccountState['state']; lastSyncAt: number | null; error: string | null; errorMessage?: string; libraryVersion: number | null } = {
    state: 'idle', lastSyncAt: saved.lastSyncAt ?? null, error: null, libraryVersion: saved.libraryVersion ?? null,
  };

  function persist() {
    const out: Saved = { ...saved };
    if (session && saved.remember) {
      out.token = deps.protect(session.token);
      out.encKey = deps.protect(session.encKey.toString('base64'));
      out.user = session.user;
      out.kdfSalt = session.kdfSalt;
      out.syncEnabled = session.syncEnabled;
    } else {
      delete out.token; delete out.encKey;
    }
    out.lastSyncAt = status.lastSyncAt;
    out.libraryVersion = status.libraryVersion;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  const publicState = (): AccountState => ({
    loggedIn: !!session,
    user: session?.user ?? null,
    email: saved.email,
    syncEnabled: session?.syncEnabled ?? false,
    state: status.state,
    lastSyncAt: status.lastSyncAt,
    error: status.error,
    errorMessage: status.errorMessage,
  });

  const setStatus = (patch: Partial<typeof status>) => {
    Object.assign(status, patch);
    deps.onStatus(publicState());
  };

  async function api<T = Record<string, unknown>>(method: string, route: string, opts: { token?: string; body?: unknown; timeout?: number } = {}): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 20000);
    let res: Response;
    try {
      res = await doFetch(API_BASE + API_PREFIX + route, {
        method,
        headers: {
          Accept: 'application/json',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctl.signal,
      });
    } catch {
      throw new AccountError(0, 'offline');
    } finally {
      clearTimeout(timer);
    }
    let json: Record<string, unknown> | null = null;
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* boş gövde */ }
    if (!res.ok) {
      const code = String((json && (json.code || json.detail)) || `http_${res.status}`);
      throw new AccountError(res.status, code, json?.message as string | undefined, json);
    }
    return (json ?? {}) as T;
  }

  const deviceName = () => `${os.hostname()} (${process.platform === 'win32' ? 'Windows' : process.platform})`.slice(0, 120);

  let debounce: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  const stopTimers = () => {
    if (debounce) clearTimeout(debounce);
    if (interval) clearInterval(interval);
    debounce = interval = null;
  };

  function expire(code = 'session_expired') {
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: code });
    deps.onSessionExpired(code);
  }

  async function authed<T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<T> {
    if (!session) throw new AccountError(401, 'session_expired');
    try {
      return await api<T>(method, route, { token: session.token, body });
    } catch (e) {
      const err = e as AccountError;
      if (err.status === 401) expire('session_expired');
      else if (err.status === 403 && ['app_disabled', 'wrong_app'].includes(err.code)) expire(err.code);
      throw e;
    }
  }

  // --- Senkron -------------------------------------------------------------------
  function localItems(): SyncItem[] {
    const lib = deps.library;
    const cur = lib.current();
    if (refreshMeta(lib.meta(), cur, saved.deviceId)) lib.persist();
    return itemsFromMeta(lib.meta(), cur);
  }

  function applyItems(items: SyncItem[]) {
    deps.library.apply(items);
    // Uygulanan verinin özetini kaydet ki yerel değişiklik sanılmasın
    const cur = deps.library.current();
    const m = deps.library.meta();
    for (const [id, x] of Object.entries(m)) if (!x.deleted && cur.has(id)) x.hash = hashOf(cur.get(id)!.data);
    deps.library.persist();
  }

  async function syncOnce() {
    if (!session) return;
    if (!session.syncEnabled) { setStatus({ state: 'off', error: null }); return; }
    setStatus({ state: 'syncing', error: null });
    try {
      let local = localItems();
      let remote = await authed<{ version: number | null; blob: string | null }>('GET', '/library');
      for (let attempt = 0; attempt < 4; attempt++) {
        let remoteItems: SyncItem[] = [];
        if (remote.blob) {
          const lib = decryptLibrary<{ items?: SyncItem[] }>(session.encKey, remote.blob);
          remoteItems = Array.isArray(lib.items) ? lib.items : [];
        }
        const remoteHasSettings = remoteItems.some((x) => x.id === SETTINGS_ID && !x.deleted);
        const merged = merge(remoteHasSettings ? local.filter((x) => !(x.id === SETTINGS_ID && !x.updated_at)) : local, remoteItems);
        if (itemsKey(merged) !== itemsKey(local)) applyItems(merged);
        if (remote.blob && itemsKey(merged) === itemsKey(remoteItems)) {
          status.libraryVersion = remote.version;
          break;
        }
        const blob = encryptLibrary(session.encKey, { schema: 1, items: merged });
        if (Buffer.byteLength(blob) > MAX_BLOB_BYTES) throw new AccountError(413, 'too_large');
        try {
          const put = await authed<{ version: number }>('PUT', '/library', { base_version: remote.version ?? null, blob });
          status.libraryVersion = put.version;
          break;
        } catch (e) {
          const err = e as AccountError;
          const body = err.body as { version?: number; blob?: string } | undefined;
          if (err.status !== 409 || !body) throw e;
          remote = { version: body.version ?? null, blob: body.blob ?? null };
          local = merged;
        }
      }
      status.lastSyncAt = Date.now();
      persist();
      setStatus({ state: 'ok', error: null });
    } catch (e) {
      const err = e as AccountError;
      const code = err.code || 'error';
      if (code === 'session_expired') return;
      deps.log?.('Senkron hatası', { code, message: err.message });
      setStatus({ state: code === 'offline' ? 'offline' : 'error', error: code, errorMessage: err.message });
    }
  }

  let running: Promise<void> | null = null;
  let again = false;
  function syncNow(): Promise<void> {
    if (!session) return Promise.resolve();
    if (running) { again = true; return running; }
    running = syncOnce().finally(() => {
      running = null;
      if (again) { again = false; void syncNow(); }
    });
    return running;
  }

  async function checkUpdate() {
    try {
      const r = await authed<{ version?: string; notes?: string }>('GET', '/releases/latest');
      if (r?.version && compareVersions(r.version, deps.appVersion) > 0) deps.onUpdate({ version: r.version, notes: r.notes || '' });
    } catch { /* bildirim isteğe bağlı */ }
  }

  async function setSyncEnabled(on: boolean) {
    await authed('PUT', '/settings', { sync_enabled: !!on });
    session!.syncEnabled = !!on;
    persist();
    setStatus({ state: on ? 'idle' : 'off' });
    if (on) void syncNow();
  }

  return {
    isLoggedIn: () => !!session,
    state: publicState,
    async login(email, password, remember) {
      email = String(email || '').trim().toLowerCase();
      const pre = await api<{ kdf: Kdf }>('POST', '/auth/prelogin', { body: { email } });
      const { authHash, encKey } = await deriveKeys(password, pre.kdf);
      const res = await api<{ token: string; user: Session['user']; kdf?: Kdf; sync_enabled?: boolean }>('POST', '/auth/login', {
        body: { email, auth_hash: authHash, device: deviceName(), app_version: String(deps.appVersion).slice(0, 30) },
      });
      let key = encKey;
      if (res.kdf && res.kdf.salt !== pre.kdf.salt) key = (await deriveKeys(password, res.kdf)).encKey;
      // Farklı hesapla giriş: bu bilgisayardaki kütüphane başka hesaba ait olabilir; birleştirme yerine yedekle
      let backupFile: string | null = null;
      if (saved.lastUserId && saved.lastUserId !== res.user.id) backupFile = deps.library.backupAndClear();
      session = { token: res.token, user: res.user, encKey: key, kdfSalt: (res.kdf ?? pre.kdf).salt, syncEnabled: res.sync_enabled !== false };
      saved.email = email;
      saved.remember = !!remember;
      saved.lastUserId = res.user.id;
      if (backupFile) { status.libraryVersion = null; status.lastSyncAt = null; }
      persist();
      setStatus({ error: null });
      return { backupFile };
    },
    async logout() {
      const token = session?.token;
      session = null;
      stopTimers();
      persist();
      setStatus({ state: 'idle', error: null });
      if (token) api('POST', '/auth/logout', { token }).catch(() => {});
    },
    async start() {
      if (!session) return;
      stopTimers();
      interval = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
      try {
        const me = await authed<{ user?: Session['user']; sync_enabled?: boolean; kdf?: Kdf }>('GET', '/me');
        session.user = me.user ?? session.user;
        session.syncEnabled = me.sync_enabled !== false;
        if (me.kdf && session.kdfSalt && me.kdf.salt !== session.kdfSalt) return expire(); // şifre başka yerde değişti
        persist();
      } catch (e) {
        const err = e as AccountError;
        if (err.status === 401 || err.status === 403) return;
        setStatus({ state: err.code === 'offline' ? 'offline' : 'error', error: err.code });
      }
      await syncNow();
      void checkUpdate();
    },
    syncNow,
    onLocalChange() {
      if (!session || !session.syncEnabled) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void syncNow(), SYNC_DEBOUNCE_MS);
    },
    setSyncEnabled,
    async deleteRemote() {
      await authed('DELETE', '/library');
      await setSyncEnabled(false);
      status.libraryVersion = null;
      persist();
    },
    checkUpdate,
  };
}
