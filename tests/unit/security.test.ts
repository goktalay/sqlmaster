import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, scrub } from '../../src/main/logger';
import { createSecretStore } from '../../src/main/secrets';
import { decryptLibrary, deriveKeys, encryptLibrary } from '../../src/main/account/crypto';
import { merge, refreshMeta, type SyncItem } from '../../src/main/account/sync';
import { compareVersions } from '../../src/main/account/types';
import type { SyncMetaEntry } from '../../src/main/store';

describe('log redaction', () => {
  it('masks passwords in URIs, key=value pairs and SQL', () => {
    expect(redact('postgres://ali:S3cr3t@db:5432/app')).toBe('postgres://ali:***@db:5432/app');
    expect(redact('Server=x;User Id=sa;Password=Gizli!1;')).toBe('Server=x;User Id=sa;Password=***;');
    expect(redact("CREATE USER bob WITH PASSWORD 'p@ss'")).toBe('CREATE USER bob WITH PASSWORD ***');
    expect(redact("ALTER USER 'a'@'%' IDENTIFIED BY 'x''y'")).toBe("ALTER USER 'a'@'%' IDENTIFIED BY ***");
  });
  it('removes secret fields from objects', () => {
    expect(scrub({ host: 'h', password: 'p', nested: { passphrase: 'q', ok: 1 }, list: [{ token: 't' }] })).toEqual({ host: 'h', password: '***', nested: { passphrase: '***', ok: 1 }, list: [{ token: '***' }] });
  });
});

describe('secret store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlm-sec-'));
  const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decrypt: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString() };
  it('never writes plaintext to disk', () => {
    const file = path.join(dir, 'secrets.json');
    const s = createSecretStore(file, cipher);
    s.set('conn:1:password', 'çokGizli');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('çokGizli');
    expect(createSecretStore(file, cipher).get('conn:1:password')).toBe('çokGizli');
    s.deletePrefix('conn:1:');
    expect(createSecretStore(file, cipher).has('conn:1:password')).toBe(false);
  });
  it('keeps secrets in memory only when the keychain is unavailable', () => {
    const file = path.join(dir, 'none.json');
    const s = createSecretStore(file, { ...cipher, isAvailable: () => false });
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('end-to-end encrypted library', () => {
  it('derives keys and round-trips the blob; wrong key fails', async () => {
    const kdf = { alg: 'PBKDF2-SHA256', salt: Buffer.from('tuz-tuz-tuz-tuz!').toString('base64'), iter: 1000 };
    const a = await deriveKeys('şifre', kdf);
    const b = await deriveKeys('başka', kdf);
    expect(a.authHash).not.toBe(b.authHash);
    const blob = encryptLibrary(a.encKey, { schema: 1, items: [{ id: 'x', data: { password: 'p' } }] });
    expect(Buffer.from(blob, 'base64').toString('latin1')).not.toContain('password');
    expect(decryptLibrary(a.encKey, blob)).toEqual({ schema: 1, items: [{ id: 'x', data: { password: 'p' } }] });
    expect(() => decryptLibrary(b.encKey, blob)).toThrow('decrypt_failed');
  });

  it('matches the server contract test vector (sqlm-enc-v1)', async () => {
    const k = await deriveKeys('Test1234!', { alg: 'PBKDF2-SHA256', salt: 'AAECAwQFBgcICQoLDA0ODw==', iter: 310000 });
    expect(k.authHash).toBe('mLBQ6HQqD19kX/VavErWYq+7tM4mCmGfic7GuQQlBMY=');
    expect(k.encKey.subarray(0, 8).toString('hex')).toBe('69fa902720ef92b1');
  });

  it('merges by updated_at, rev, then device; drops old tombstones', () => {
    const it = (id: string, updated_at: number, rev = 1, device = 'a', deleted = false): SyncItem => ({ id, kind: 'connection', updated_at, rev, device, deleted, data: deleted ? null : { v: `${id}-${updated_at}-${device}` } });
    const now = 100 * 864e5;
    const out = merge([it('1', 10), it('2', 20, 1, 'a'), it('3', 5, 1, 'a', true)], [it('1', 11), it('2', 20, 1, 'b'), it('4', 1, 1, 'a', true)], now);
    expect(Object.fromEntries(out.map((x) => [x.id, x.data?.v ?? 'deleted']))).toEqual({ '1': '1-11-a', '2': '2-20-b' });
  });

  it('tracks local changes and deletions in metadata', () => {
    const meta: Record<string, SyncMetaEntry> = {};
    const cur = new Map([['c1', { kind: 'connection', data: { name: 'A' } }], ['settings', { kind: 'settings', data: { appTheme: 'dark' } }]]);
    expect(refreshMeta(meta, cur, 'dev', 1000)).toBe(true);
    expect(meta.settings.updated_at).toBe(0); // ilk ayar kaydı hesaptaki ayarları ezmez
    expect(refreshMeta(meta, cur, 'dev', 2000)).toBe(false);
    cur.set('c1', { kind: 'connection', data: { name: 'B' } });
    refreshMeta(meta, cur, 'dev', 3000);
    expect(meta.c1).toMatchObject({ rev: 2, updated_at: 3000 });
    cur.delete('c1');
    refreshMeta(meta, cur, 'dev', 4000);
    expect(meta.c1).toMatchObject({ deleted: true, rev: 3 });
  });

  it('compares versions', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.9', '1.0.0')).toBe(-1);
  });
});
