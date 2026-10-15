// Cihazda ortak oturum (SSO) — Mastertool sözleşmesi v1 §2. Master Tool, SSH Master, FTP Masters, SQL Master …
// aynı biçimi uygular: birinde giriş yapılınca diğerleri şifresiz açılır, birinde çıkış yapılınca hepsi kapanır.
// Başvuru: goktalay/mastertool src/sso.js (41d0035).
//
// Ortak kimlik: Windows Kimlik Bilgisi Yöneticisi (kullanıcı kapsamı, DPAPI), @napi-rs/keyring
//   new Entry('Mastertool', 'sso') → {"v":1,"email","user":{"id","name"},"sso_token","master","kdf","at"}
//   master (base64, 32 bayt) şifresiz giren uygulamanın kendi şifreleme anahtarını türetmesi içindir;
//   asla dosyaya, günlüğe ya da sunucuya yazılmaz.
// Durum işareti (gizli bilgi yok): %APPDATA%\Mastertool\sso-state.json = {"gen","state":"in"|"out","at"}
//   Yalnızca "değişti" işaretidir; asıl bilgi her zaman ortak kimlikten okunur. fs.watch + 5 sn yoklama.
import fs from 'node:fs';
import path from 'node:path';
import type { Kdf } from './crypto';

export const SSO_SERVICE = 'Mastertool';
export const SSO_ACCOUNT = 'sso';
export const STATE_FILE = 'sso-state.json';
// Windows kimlik bilgisi blob'u en çok 2560 bayt ve keyring UTF-16 yazar → sözleşme sınırı 1200 karakter
export const MAX_CHARS = 1200;
const POLL_MS = 5000;

export interface Keyring {
  get(): string | null;
  set(value: string): void;
  del(): void;
}

export interface SsoCredential {
  v: 1;
  email: string;
  user: { id: string | null; name: string };
  sso_token: string;
  master: string; // base64, 32 bayt
  kdf: Kdf | null;
  at: number;
}

export interface SsoState {
  gen: number;
  state: 'in' | 'out';
  at: number;
}

export interface SsoWatcher {
  /** Kendi yazdığımız durumu görülmüş say (aynı değişikliği bir daha işlemeyelim) */
  seen(gen: number): void;
  stop(): void;
}

export interface SsoStore {
  readCredential(): SsoCredential | null;
  writeCredential(data: { email: string; user: { id: string | null; name?: string }; sso_token: string; master: Buffer | string; kdf: Kdf | null }): void;
  deleteCredential(): void;
  readState(): SsoState;
  bumpState(state: 'in' | 'out'): SsoState;
  watch(cb: (s: SsoState) => void): SsoWatcher;
}

/** Gerçek depo; modül yüklenemezse (desteklenmeyen platform) null döner ve ortak oturum devre dışı kalır */
export function systemKeyring(): Keyring | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- isteğe bağlı yerel modül
    const { Entry } = require('@napi-rs/keyring') as { Entry: new (service: string, account: string) => { getPassword(): string | null | undefined; setPassword(v: string): void; deletePassword(): boolean } };
    const entry = new Entry(SSO_SERVICE, SSO_ACCOUNT);
    return {
      get: () => entry.getPassword() ?? null,
      set: (v) => entry.setPassword(v),
      del: () => { try { entry.deletePassword(); } catch { /* zaten yok */ } },
    };
  } catch {
    return null;
  }
}

export function encodeCredential(d: { email: string; user: { id: string | null; name?: string }; sso_token: string; master: Buffer | string; kdf: Kdf | null; at: number }): string {
  const cred: SsoCredential = {
    v: 1,
    email: String(d.email || ''),
    user: { id: d.user?.id != null ? String(d.user.id) : null, name: String(d.user?.name || '') },
    sso_token: String(d.sso_token || ''),
    master: Buffer.isBuffer(d.master) ? d.master.toString('base64') : String(d.master || ''),
    kdf: d.kdf ? { alg: d.kdf.alg, iter: d.kdf.iter, salt: d.kdf.salt } : null,
    at: d.at,
  };
  let json = JSON.stringify(cred);
  if (json.length > MAX_CHARS) {
    cred.user.name = cred.user.name.slice(0, Math.max(0, cred.user.name.length - (json.length - MAX_CHARS)));
    json = JSON.stringify(cred);
  }
  if (json.length > MAX_CHARS) throw Object.assign(new Error('credential_too_large'), { code: 'credential_too_large' });
  return json;
}

export function decodeCredential(json: string | null | undefined): SsoCredential | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json) as SsoCredential;
    if (!c || c.v !== 1 || typeof c.sso_token !== 'string' || !c.sso_token) return null;
    return c;
  } catch {
    return null;
  }
}

export function createSso(o: { keyring: Keyring; stateDir: string; now?: () => number; pollMs?: number }): SsoStore {
  const now = o.now ?? Date.now;
  const stateFile = path.join(o.stateDir, STATE_FILE);

  function readState(): SsoState {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<SsoState>;
      return { gen: Number(s.gen) || 0, state: s.state === 'in' ? 'in' : 'out', at: Number(s.at) || 0 };
    } catch {
      return { gen: 0, state: 'out', at: 0 };
    }
  }

  return {
    readCredential() {
      try { return decodeCredential(o.keyring.get()); } catch { return null; }
    },
    writeCredential(data) {
      o.keyring.set(encodeCredential({ ...data, at: now() }));
    },
    deleteCredential() {
      try { o.keyring.del(); } catch { /* yok sayılır */ }
    },
    readState,
    // Okuyan uygulama yarım dosya görmesin diye geçici dosyaya yazılıp yerine taşınır
    bumpState(state) {
      const next: SsoState = { gen: readState().gen + 1, state, at: now() };
      fs.mkdirSync(o.stateDir, { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
      try {
        fs.renameSync(tmp, stateFile);
      } catch {
        fs.writeFileSync(stateFile, JSON.stringify(next), 'utf8'); // başka süreç dosyayı tutuyorsa
        try { fs.unlinkSync(tmp); } catch { /* yok */ }
      }
      return next;
    },
    watch(cb) {
      let lastGen = readState().gen;
      let watcher: fs.FSWatcher | null = null;
      let debounce: NodeJS.Timeout | undefined;
      const check = () => {
        const s = readState();
        if (s.gen !== lastGen) { lastGen = s.gen; cb(s); }
      };
      const soon = () => { clearTimeout(debounce); debounce = setTimeout(check, 60); };
      try {
        fs.mkdirSync(o.stateDir, { recursive: true });
        watcher = fs.watch(o.stateDir, (_ev, name) => { if (!name || String(name) === STATE_FILE) soon(); });
        watcher.on('error', () => { try { watcher?.close(); } catch { /* */ } watcher = null; });
      } catch { watcher = null; }
      const timer = setInterval(check, o.pollMs ?? POLL_MS);
      timer.unref?.();
      return {
        seen(gen) { lastGen = Math.max(lastGen, gen); },
        stop() {
          clearInterval(timer);
          clearTimeout(debounce);
          try { watcher?.close(); } catch { /* */ }
        },
      };
    },
  };
}
