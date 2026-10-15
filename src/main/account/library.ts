// Bağlantı kütüphanesi ↔ senkron öğeleri dönüşümü.
// Parolalar senkron blob'una açık metin girer ama blob istemcide AES-256-GCM ile şifrelenir;
// yerelde yeniden ISecretStore'a (anahtar zinciri) yazılır. Cihaza özgü alanlar (anahtar dosyası yolu,
// son kullanım) gönderilmez; SSH özel anahtarı dosya içeriğiyle taşınır.
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile, Folder, Settings } from '../../shared/types';
import { secretRef, type Store, type SyncMetaEntry } from '../store';
import type { ISecretStore } from '../secrets';
import type { SyncItem } from './sync';

export const CONN_FIELDS = ['name', 'provider', 'host', 'port', 'database', 'user', 'filePath', 'sslMode', 'readOnly', 'savePassword', 'color', 'folderId', 'comments', 'createdAt'] as const;
export const SETTINGS_FIELDS = ['appTheme', 'language', 'rowLimit', 'previewRows', 'editorFontSize'] as const;

export interface LibraryAdapter {
  meta(): Record<string, SyncMetaEntry>;
  current(): Map<string, { kind: string; data: Record<string, unknown> }>;
  apply(items: SyncItem[]): void;
  persist(): void;
  backupAndClear(): string | null;
}

export function createLibraryAdapter(store: Store, secrets: ISecretStore, userDataDir: string, onApplied: () => void): LibraryAdapter {
  const keysDir = path.join(userDataDir, 'keys');
  const readKey = (p: string) => { try { return p ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };

  return {
    meta: () => store.data.syncMeta,
    current() {
      const out = new Map<string, { kind: string; data: Record<string, unknown> }>();
      for (const c of store.data.connections) {
        const data: Record<string, unknown> = {};
        for (const k of CONN_FIELDS) data[k] = c[k] ?? null;
        data.ssh = { enabled: c.ssh.enabled, host: c.ssh.host, port: c.ssh.port, user: c.ssh.user, auth: c.ssh.auth, hostKey: c.ssh.hostKey };
        data.password = c.savePassword ? secrets.get(secretRef.password(c.id)) : '';
        data.sshPassword = secrets.get(secretRef.sshPassword(c.id));
        data.sshPassphrase = secrets.get(secretRef.sshPassphrase(c.id));
        data.sshPrivateKey = c.ssh.enabled && c.ssh.auth === 'key' ? readKey(c.ssh.keyPath) : '';
        out.set(c.id, { kind: 'connection', data });
      }
      for (const f of store.data.folders) out.set(f.id, { kind: 'folder', data: { name: f.name, parentId: f.parentId } });
      const s: Record<string, unknown> = {};
      for (const k of SETTINGS_FIELDS) s[k] = store.data.settings[k] ?? null;
      out.set('settings', { kind: 'settings', data: s });
      return out;
    },
    apply(items) {
      const old = new Map(store.data.connections.map((c) => [c.id, c]));
      const live = items.filter((x) => !x.deleted && x.data);
      const folders: Folder[] = live.filter((x) => x.kind === 'folder').map((x) => ({ id: x.id, name: String(x.data!.name ?? ''), parentId: (x.data!.parentId as string) || null }));
      const connections: ConnectionProfile[] = [];
      const liveIds = new Set<string>();
      for (const x of live.filter((i) => i.kind === 'connection')) {
        const d = x.data as Record<string, unknown> & { ssh?: Partial<ConnectionProfile['ssh']> };
        const prev = old.get(x.id);
        liveIds.add(x.id);
        let keyPath = prev?.ssh.keyPath ?? '';
        const pk = String(d.sshPrivateKey ?? '');
        if (pk && readKey(keyPath) !== pk) {
          fs.mkdirSync(keysDir, { recursive: true });
          keyPath = path.join(keysDir, `${x.id}.key`);
          fs.writeFileSync(keyPath, pk, { encoding: 'utf8', mode: 0o600 });
        }
        const c = { id: x.id } as ConnectionProfile;
        for (const k of CONN_FIELDS) (c as unknown as Record<string, unknown>)[k] = d[k];
        c.createdAt = Number(d.createdAt) || prev?.createdAt || Date.now();
        c.lastUsedAt = prev?.lastUsedAt;
        c.ssh = {
          enabled: !!d.ssh?.enabled, host: d.ssh?.host ?? '', port: d.ssh?.port ?? 22, user: d.ssh?.user ?? '',
          auth: d.ssh?.auth ?? 'key', hostKey: d.ssh?.hostKey ?? null, keyPath,
        };
        connections.push(store.normalize({ ...c, ssh: c.ssh }, c));
        const setSecret = (ref: string, v: unknown) => (v ? secrets.set(ref, String(v)) : secrets.delete(ref));
        setSecret(secretRef.password(x.id), d.password);
        setSecret(secretRef.sshPassword(x.id), d.sshPassword);
        setSecret(secretRef.sshPassphrase(x.id), d.sshPassphrase);
      }
      for (const id of old.keys()) if (!liveIds.has(id)) secrets.deletePrefix(secretRef.prefix(id));
      const s = live.find((x) => x.kind === 'settings');
      const settings: Partial<Settings> = {};
      if (s) for (const k of SETTINGS_FIELDS) if (k in s.data! && s.data![k] !== null) (settings as Record<string, unknown>)[k] = s.data![k];
      const meta: Record<string, SyncMetaEntry> = {};
      for (const it of items) meta[it.id] = { kind: it.kind, hash: null, updated_at: it.updated_at, rev: it.rev || 0, device: it.device, deleted: !!it.deleted };
      // Klasör referanslarını normalize() klasörler yerleştikten sonra doğrulasın
      store.data.folders = folders;
      store.data.connections = connections.map((c) => ({ ...c, folderId: c.folderId && folders.some((f) => f.id === c.folderId) ? c.folderId : null }));
      Object.assign(store.data.settings, settings);
      store.data.syncMeta = meta;
      onApplied();
    },
    persist: () => store.flush(),
    backupAndClear() {
      const has = store.data.connections.length || store.data.folders.length;
      let file: string | null = null;
      if (has) {
        file = path.join(userDataDir, `store-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify({ folders: store.data.folders, connections: store.data.connections }, null, 2), 'utf8');
      }
      for (const c of store.data.connections) secrets.deletePrefix(secretRef.prefix(c.id));
      store.data.connections = [];
      store.data.folders = [];
      store.data.syncMeta = {};
      store.flush();
      return file;
    },
  };
}
