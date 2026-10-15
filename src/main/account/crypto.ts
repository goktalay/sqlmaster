// Uçtan uca şifreli kütüphane: anahtarlar istemcide türetilir, sunucu ne şifreyi ne anahtarı görür.
//   master   = PBKDF2-SHA256(şifre, salt, iter, 32B)
//   encKey   = HKDF-SHA256(master, salt = boş, info = "sqlm-enc-v1", 32B)   → AES-256-GCM
//   authHash = base64(PBKDF2-SHA256(master, şifre, 1, 32B))                → girişte gönderilen tek değer
// Blob: base64(iv12 ‖ şifreli metin ‖ tag16). (SSH Master / FTP Masters ile aynı yapı, farklı info etiketi.)
import crypto from 'node:crypto';
import { AccountError } from './types';

export interface Kdf {
  alg: string;
  salt: string;
  iter: number;
}

export const ENC_INFO = 'sqlm-enc-v1';

const pbkdf2 = (pass: Buffer, salt: Buffer, iter: number, len: number) =>
  new Promise<Buffer>((resolve, reject) => crypto.pbkdf2(pass, salt, iter, len, 'sha256', (e, k) => (e ? reject(e) : resolve(k))));

export async function deriveKeys(password: string, kdf: Kdf): Promise<{ authHash: string; encKey: Buffer }> {
  if (!kdf || kdf.alg !== 'PBKDF2-SHA256') throw new AccountError(0, 'unsupported_kdf');
  const pw = Buffer.from(password, 'utf8');
  const master = await pbkdf2(pw, Buffer.from(kdf.salt, 'base64'), kdf.iter, 32);
  const authHash = (await pbkdf2(master, pw, 1, 32)).toString('base64');
  const encKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(ENC_INFO), 32));
  master.fill(0);
  return { authHash, encKey };
}

export function encryptLibrary(key: Buffer, obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

export function decryptLibrary<T = unknown>(key: Buffer, blob: string): T {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 29) throw new AccountError(0, 'decrypt_failed');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } catch {
    throw new AccountError(0, 'decrypt_failed');
  }
}

/** Anahtar sırası sabit JSON (içerik değişti mi karşılaştırması için) */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export const hashOf = (data: unknown) => crypto.createHash('sha256').update(stable(data)).digest('base64');
