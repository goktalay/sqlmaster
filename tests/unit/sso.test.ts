// Cihazda ortak oturum (SSO): ortak kimlik biçimi, durum işareti ve iki uygulama arasında giriş/çıkış akışları.
// Sunucu sahte (fetch), ortak kimlik deposu bellek içi; durum dosyası geçici klasörde.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSso, decodeCredential, encodeCredential, MAX_CHARS, type Keyring, type SsoStore } from '../../src/main/account/sso';
import { createMastertoolAccount } from '../../src/main/account/mastertool';
import { deriveKeys, encKeyFromMaster, type Kdf } from '../../src/main/account/crypto';
import type { LibraryAdapter } from '../../src/main/account/library';
import type { SyncItem } from '../../src/main/account/sync';
import type { IAccountService } from '../../src/main/account/types';

const KDF: Kdf = { alg: 'PBKDF2-SHA256', salt: 'AAECAwQFBgcICQoLDA0ODw==', iter: 1000 };
const tmp: string[] = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlm-sso-')); tmp.push(d); return d; };
const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((f) => f());
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function memoryKeyring(): Keyring & { value: string | null } {
  const k = { value: null as string | null, get: () => k.value, set: (v: string) => { k.value = v; }, del: () => { k.value = null; } };
  return k;
}

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('zaman aşımı');
    await new Promise((r) => setTimeout(r, 15));
  }
}

// --- Sahte Mastertool sunucusu ---------------------------------------------------------
function fakeServer() {
  const calls: Array<{ route: string; body: Record<string, unknown>; token?: string }> = [];
  const user = { id: 'u1', email: 'demo@ornek.com', name: 'Demo' };
  let ssoSeq = 0;
  let tokSeq = 0;
  const ssoTokens = new Set<string>();
  const appTokens = new Map<string, string | null>(); // uygulama token'ı → türediği sso_token
  let library: { version: number; blob: string } | null = null;
  const fail: Record<string, { status: number; code: string }> = {};
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const route = String(url).replace(/^.*\/api\/sq/, '');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const token = String((init?.headers as Record<string, string>)?.Authorization || '').replace(/^Bearer /, '') || undefined;
    calls.push({ route, body, token });
    const key = `${init?.method} ${route}`;
    if (fail[key]) return json(fail[key].status, { code: fail[key].code });
    const issue = (sso: string | null) => { const t = `app-${++tokSeq}`; appTokens.set(t, sso); return t; };
    const authed = () => token && appTokens.has(token) && (appTokens.get(token) === null || ssoTokens.has(appTokens.get(token)!));
    switch (key) {
      case 'POST /auth/prelogin': return json(200, { kdf: KDF });
      case 'POST /auth/login': {
        const sso = body.sso ? `sso-${++ssoSeq}` : null;
        if (sso) ssoTokens.add(sso);
        return json(200, { token: issue(sso), ...(sso ? { sso_token: sso } : {}), user, kdf: KDF, sync_enabled: true });
      }
      case 'POST /auth/sso':
        if (!ssoTokens.has(String(body.sso_token))) return json(401, { code: 'session_expired' });
        return json(200, { token: issue(String(body.sso_token)), user, kdf: KDF, sync_enabled: true });
      case 'POST /auth/logout': {
        const sso = token ? appTokens.get(token) : null;
        if (token) appTokens.delete(token);
        if (sso) ssoTokens.delete(sso); // ortak oturumdan türetilmiş: tüm aile kapanır
        return json(200, { ok: true, sso_ended: !!sso });
      }
      case 'GET /me': return authed() ? json(200, { user, sync_enabled: true, kdf: KDF }) : json(401, { code: 'session_expired' });
      case 'GET /library': return authed() ? json(200, library ?? { version: null, blob: null }) : json(401, { code: 'session_expired' });
      case 'PUT /library':
        if (!authed()) return json(401, { code: 'session_expired' });
        library = { version: (library?.version ?? 0) + 1, blob: String(body.blob) };
        return json(200, { version: library.version });
      case 'GET /releases/latest': return json(200, { version: null });
      default: return json(404, { code: 'not_found' });
    }
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, fail, ssoTokens };
}

function memoryLibrary(): LibraryAdapter & { items: Map<string, { kind: string; data: Record<string, unknown> }> } {
  const items = new Map<string, { kind: string; data: Record<string, unknown> }>();
  const meta = {};
  return {
    items,
    meta: () => meta,
    current: () => items,
    apply(list: SyncItem[]) { for (const x of list) if (x.deleted) items.delete(x.id); else items.set(x.id, { kind: x.kind, data: x.data as Record<string, unknown> }); },
    persist() { /* bellek */ },
    backupAndClear() { items.clear(); return 'yedek.json'; },
  };
}

function makeApp(server: ReturnType<typeof fakeServer>, sso: SsoStore) {
  const events = { expired: [] as string[], signedIn: 0 };
  const library = memoryLibrary();
  const acc: IAccountService = createMastertoolAccount({
    userDataDir: mkdir(),
    appVersion: '0.1.0',
    protect: (s) => 'enc:' + Buffer.from(s).toString('base64'),
    unprotect: (s) => Buffer.from(s.slice(4), 'base64').toString(),
    library,
    sso,
    fetch: server.fetch,
    onStatus: () => {},
    onUpdate: () => {},
    onSessionExpired: (code) => events.expired.push(code),
    onSignedIn: () => { events.signedIn++; },
  });
  stops.push(() => acc.stopWatching());
  return { acc, events, library };
}

describe('ortak kimlik biçimi', () => {
  it('kodlar, çözer ve 1200 karakter sınırına uyar', () => {
    const json = encodeCredential({ email: 'a@b.c', user: { id: '7', name: 'Ad' }, sso_token: 't', master: Buffer.alloc(32, 1), kdf: KDF, at: 5 });
    const c = decodeCredential(json)!;
    expect(c).toMatchObject({ v: 1, email: 'a@b.c', user: { id: '7', name: 'Ad' }, sso_token: 't', kdf: KDF, at: 5 });
    expect(Buffer.from(c.master, 'base64')).toHaveLength(32);
    const long = encodeCredential({ email: 'a@b.c', user: { id: '7', name: 'x'.repeat(5000) }, sso_token: 't', master: Buffer.alloc(32), kdf: KDF, at: 1 });
    expect(long.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(decodeCredential('{"v":2,"sso_token":"x"}')).toBeNull();
    expect(decodeCredential('bozuk')).toBeNull();
  });

  it('master\'dan türetilen anahtar şifreyle türetilenle aynıdır', async () => {
    const k = await deriveKeys('Gizli-123', KDF);
    expect(encKeyFromMaster(k.master).equals(k.encKey)).toBe(true);
  });

  it('durum işaretini atomik yazar ve değişikliği bildirir', async () => {
    const dir = mkdir();
    const s = createSso({ keyring: memoryKeyring(), stateDir: dir, pollMs: 20 });
    expect(s.readState()).toEqual({ gen: 0, state: 'out', at: 0 });
    const seen: string[] = [];
    const w = s.watch((st) => seen.push(`${st.gen}:${st.state}`));
    stops.push(() => w.stop());
    w.seen(s.bumpState('in').gen); // kendi değişikliğimiz bildirilmez
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual([]);
    createSso({ keyring: memoryKeyring(), stateDir: dir }).bumpState('out'); // başka uygulama
    await until(() => seen.length === 1);
    expect(seen).toEqual(['2:out']);
    expect(fs.readdirSync(dir)).toEqual(['sso-state.json']);
  });
});

describe('iki uygulama arasında ortak oturum', () => {
  const setup = () => {
    const server = fakeServer();
    const keyring = memoryKeyring();
    const dir = mkdir();
    const store = () => createSso({ keyring, stateDir: dir, pollMs: 20 });
    return { server, keyring, a: makeApp(server, store()), b: makeApp(server, store()), shared: store() };
  };

  it('şifreyle giriş ortak kimliği yazar, diğer uygulama şifresiz açılır ve aynı anahtarla senkronlar', async () => {
    const { server, a, b, shared } = setup();
    await a.acc.login('Demo@Ornek.com', 'Gizli-123', true);
    expect(server.calls.find((c) => c.route === '/auth/login')!.body.sso).toBe(true);
    const cred = shared.readCredential()!;
    expect(cred).toMatchObject({ email: 'demo@ornek.com', user: { id: 'u1', name: 'Demo' }, sso_token: 'sso-1' });
    expect(cred.master).toBe((await deriveKeys('Gizli-123', KDF)).master.toString('base64'));
    expect(shared.readState()).toMatchObject({ gen: 1, state: 'in' });

    expect(await b.acc.trySso()).toEqual({ ok: true, backupFile: null });
    expect(server.calls.find((c) => c.route === '/auth/sso')!.body).toMatchObject({ sso_token: 'sso-1', app_version: '0.1.0' });
    expect(b.acc.isLoggedIn()).toBe(true);

    // Şifresiz giren uygulama aynı şifreleme anahtarına sahip: A'nın kütüphanesini çözebilir
    a.library.items.set('c1', { kind: 'connection', data: { name: 'ERP' } });
    await a.acc.syncNow();
    expect(a.acc.state().state).toBe('ok');
    await b.acc.syncNow();
    expect(b.acc.state().state).toBe('ok');
    expect(b.library.items.get('c1')?.data).toEqual({ name: 'ERP' });
  });

  it('birinde çıkış yapılınca diğeri de çıkar; yeniden girişte diğeri kendiliğinden açılır', async () => {
    const { server, a, b, shared } = setup();
    await a.acc.login('demo@ornek.com', 'Gizli-123', true);
    await b.acc.trySso();
    b.library.items.set('yerel', { kind: 'connection', data: { name: 'kalır' } });
    a.acc.startWatching();
    b.acc.startWatching();

    await a.acc.logout();
    expect(server.calls.filter((c) => c.route === '/auth/logout')).toHaveLength(1);
    expect(shared.readCredential()).toBeNull();
    expect(shared.readState().state).toBe('out');
    await until(() => !b.acc.isLoggedIn());
    expect(b.events.expired).toEqual(['signed_out']);
    expect(a.events.expired).toEqual([]); // kendi çıkışını tekrar işlemez
    expect(b.library.items.has('yerel')).toBe(true); // yerel veri silinmez

    await a.acc.login('demo@ornek.com', 'Gizli-123', true);
    await until(() => b.acc.isLoggedIn());
    expect(b.events.signedIn).toBe(1);
    expect(server.calls.filter((c) => c.route === '/auth/sso').at(-1)!.body.sso_token).toBe('sso-2');
  });

  it('sunucuda biten ortak oturum (401) kimliği temizler ve çıkış işareti verir', async () => {
    const { server, a, b, shared } = setup();
    await a.acc.login('demo@ornek.com', 'Gizli-123', true);
    server.ssoTokens.clear(); // ör. Hesabım › Oturumlar'dan kapatıldı
    expect(await b.acc.trySso()).toMatchObject({ ok: false, code: 'session_expired' });
    expect(shared.readCredential()).toBeNull();
    expect(shared.readState()).toMatchObject({ gen: 2, state: 'out' });
  });

  it('uygulama isteğinde 401 session_expired tüm aileyi düşürür', async () => {
    const { server, a, shared } = setup();
    await a.acc.login('demo@ornek.com', 'Gizli-123', true);
    server.ssoTokens.clear();
    await a.acc.start();
    expect(a.acc.isLoggedIn()).toBe(false);
    expect(a.events.expired).toEqual(['session_expired']);
    expect(shared.readCredential()).toBeNull();
    expect(shared.readState().state).toBe('out');
  });

  it('lisans kapalıysa (403 app_disabled) şifresiz açılmaz ama ortak kimlik diğer uygulamalar için kalır', async () => {
    const { server, a, b, shared } = setup();
    await a.acc.login('demo@ornek.com', 'Gizli-123', true);
    server.fail['POST /auth/sso'] = { status: 403, code: 'app_disabled' };
    expect(await b.acc.trySso()).toMatchObject({ ok: false, code: 'app_disabled' });
    expect(b.acc.isLoggedIn()).toBe(false);
    expect(shared.readCredential()?.sso_token).toBe('sso-1');
  });

  it('ortak oturum yoksa (Windows dışı) giriş sso istemez', async () => {
    const server = fakeServer();
    const acc = createMastertoolAccount({
      userDataDir: mkdir(), appVersion: '0.1.0', protect: (s) => s, unprotect: (s) => s, library: memoryLibrary(),
      fetch: server.fetch, onStatus: () => {}, onUpdate: () => {}, onSessionExpired: () => {},
    });
    await acc.login('demo@ornek.com', 'Gizli-123', false);
    expect(server.calls.find((c) => c.route === '/auth/login')!.body.sso).toBeUndefined();
    expect(await acc.trySso()).toEqual({ ok: true });
  });
});
