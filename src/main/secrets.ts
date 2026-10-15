// Gizli bilgi kasası: parolalar yalnızca işletim sistemi anahtar zinciriyle korunur.
// Electron safeStorage, anahtarı Windows'ta DPAPI, macOS'ta Keychain, Linux'ta libsecret/kwallet ile saklar.
// Profil dosyasında (store.json) yalnızca referans vardır; şifreli değerler secrets.json'dadır.
// safeStorage kullanılamıyorsa (ör. anahtar zinciri olmayan Linux) parolalar diske yazılmaz, yalnız oturum boyunca bellekte tutulur.
import fs from 'node:fs';
import path from 'node:path';

export interface ICipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface ISecretStore {
  readonly persistent: boolean;
  get(ref: string): string;
  set(ref: string, value: string): void;
  delete(ref: string): void;
  has(ref: string): boolean;
  /** Önekle başlayan tüm referansları siler (bağlantı silinince) */
  deletePrefix(prefix: string): void;
}

export function createSecretStore(file: string, cipher: ICipher): ISecretStore {
  const memory = new Map<string, string>();
  let data: Record<string, string> = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* ilk açılış */ }
  const persistent = cipher.isAvailable();
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };
  return {
    persistent,
    get(ref) {
      if (memory.has(ref)) return memory.get(ref)!;
      const v = data[ref];
      if (!v || !persistent) return '';
      try { return cipher.decrypt(Buffer.from(v, 'base64')); } catch { return ''; }
    },
    set(ref, value) {
      if (!value) return this.delete(ref);
      if (!persistent) { memory.set(ref, value); return; }
      data[ref] = cipher.encrypt(value).toString('base64');
      memory.delete(ref);
      save();
    },
    delete(ref) {
      memory.delete(ref);
      if (ref in data) { delete data[ref]; save(); }
    },
    has(ref) {
      return memory.has(ref) || (persistent && !!data[ref]);
    },
    deletePrefix(prefix) {
      for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k);
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix));
      if (keys.length) { for (const k of keys) delete data[k]; save(); }
    },
  };
}
