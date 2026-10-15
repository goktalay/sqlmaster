// Bağlantı kütüphanesi deposu (userData/store.json): klasörler, bağlantı profilleri, ayarlar, senkron meta verisi.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ProviderId, SslMode } from '../core/provider';
import { DEFAULT_SETTINGS, type ConnectionForm, type ConnectionProfile, type Folder, type PublicConnection, type PublicStore, type Settings } from '../shared/types';
import type { ISecretStore } from './secrets';

export interface SyncMetaEntry {
  kind: string;
  hash: string | null;
  updated_at: number;
  rev: number;
  device: string;
  deleted: boolean;
}

export interface StoreData {
  folders: Folder[];
  connections: ConnectionProfile[];
  settings: Settings;
  syncMeta: Record<string, SyncMetaEntry>;
}

export const secretRef = {
  password: (id: string) => `conn:${id}:password`,
  sshPassword: (id: string) => `conn:${id}:sshPassword`,
  sshPassphrase: (id: string) => `conn:${id}:sshPassphrase`,
  prefix: (id: string) => `conn:${id}:`,
};

const PROVIDERS: ProviderId[] = ['postgres', 'mssql', 'mysql', 'sqlite', 'duckdb'];
const SSL: SslMode[] = ['disable', 'prefer', 'require', 'verify-full'];
const uid = () => crypto.randomBytes(8).toString('hex');
const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);
const num = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
};

export class Store {
  data: StoreData;
  private timer: NodeJS.Timeout | null = null;
  /** Kütüphane değişince (senkron tetiklemek için) */
  onLibraryChange: () => void = () => {};
  onChange: () => void = () => {};

  constructor(private file: string, private secrets: ISecretStore) {
    this.data = { folders: [], connections: [], settings: { ...DEFAULT_SETTINGS }, syncMeta: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
    } catch { /* ilk açılış */ }
  }

  save({ library = true }: { library?: boolean } = {}): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
    if (library) this.onLibraryChange();
    this.onChange();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  publicConnection(c: ConnectionProfile): PublicConnection {
    return {
      ...c,
      hasPassword: this.secrets.has(secretRef.password(c.id)),
      hasSshPassword: this.secrets.has(secretRef.sshPassword(c.id)),
      hasSshPassphrase: this.secrets.has(secretRef.sshPassphrase(c.id)),
    };
  }

  public(): PublicStore {
    return { folders: this.data.folders, settings: this.data.settings, connections: this.data.connections.map((c) => this.publicConnection(c)) };
  }

  get(id: string): ConnectionProfile | undefined {
    return this.data.connections.find((c) => c.id === id);
  }

  /** Form verisini doğrulayıp profile çevirir (yeni ya da mevcut) */
  normalize(form: ConnectionForm, existing?: ConnectionProfile): ConnectionProfile {
    const provider = oneOf(form.provider, PROVIDERS, 'postgres');
    const ssh = form.ssh || ({} as ConnectionForm['ssh']);
    const p: ConnectionProfile = {
      id: existing?.id ?? uid(),
      createdAt: existing?.createdAt ?? Date.now(),
      lastUsedAt: existing?.lastUsedAt,
      name: str(form.name, 120) || str(form.host, 120) || path.basename(str(form.filePath)) || provider,
      provider,
      host: str(form.host, 255),
      port: num(form.port, 1, 65535),
      database: str(form.database, 255),
      user: str(form.user, 255),
      filePath: str(form.filePath, 1000),
      sslMode: oneOf(form.sslMode, SSL, 'prefer'),
      readOnly: form.readOnly !== false,
      savePassword: form.savePassword !== false,
      color: /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : '#22d3ee',
      folderId: form.folderId && this.data.folders.some((f) => f.id === form.folderId) ? form.folderId : null,
      comments: str(form.comments, 2000),
      ssh: {
        enabled: !!ssh.enabled,
        host: str(ssh.host, 255),
        port: num(ssh.port, 1, 65535) ?? 22,
        user: str(ssh.user, 255),
        auth: oneOf(ssh.auth, ['key', 'password', 'agent'] as const, 'key'),
        keyPath: str(ssh.keyPath, 1000),
        hostKey: existing && existing.ssh.host === str(ssh.host, 255) && existing.ssh.port === (num(ssh.port, 1, 65535) ?? 22) ? existing.ssh.hostKey : null,
      },
    };
    return p;
  }

  saveConnection(form: ConnectionForm): string {
    const existing = form.id ? this.get(form.id) : undefined;
    const p = this.normalize(form, existing);
    if (existing) Object.assign(existing, p);
    else this.data.connections.push(p);
    if (!p.savePassword || form.clearPassword) this.secrets.delete(secretRef.password(p.id));
    if (form.password && p.savePassword) this.secrets.set(secretRef.password(p.id), form.password);
    if (form.sshPassword) this.secrets.set(secretRef.sshPassword(p.id), form.sshPassword);
    if (form.sshPassphrase) this.secrets.set(secretRef.sshPassphrase(p.id), form.sshPassphrase);
    if (p.ssh.auth !== 'password') this.secrets.delete(secretRef.sshPassword(p.id));
    this.save();
    return p.id;
  }

  deleteConnection(id: string): void {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this.secrets.deletePrefix(secretRef.prefix(id));
    this.save();
  }

  duplicateConnection(id: string, suffix: string): string | null {
    const c = this.get(id);
    if (!c) return null;
    const copy: ConnectionProfile = { ...structuredClone(c), id: uid(), name: c.name + suffix, createdAt: Date.now(), lastUsedAt: undefined };
    this.data.connections.push(copy);
    for (const key of ['password', 'sshPassword', 'sshPassphrase'] as const) {
      const v = this.secrets.get(secretRef[key](id));
      if (v) this.secrets.set(secretRef[key](copy.id), v);
    }
    this.save();
    return copy.id;
  }

  moveConnection(id: string, folderId: string | null): void {
    const c = this.get(id);
    if (c) c.folderId = folderId && this.data.folders.some((f) => f.id === folderId) ? folderId : null;
    this.save();
  }

  touch(id: string): void {
    const c = this.get(id);
    if (c) { c.lastUsedAt = Date.now(); this.save({ library: false }); }
  }

  rememberHostKey(id: string, fp: string): void {
    const c = this.get(id);
    if (c && c.ssh.hostKey !== fp) { c.ssh.hostKey = fp; this.save(); }
  }

  saveFolder(f: { id?: string; name: string; parentId?: string | null }): string {
    let folder = f.id ? this.data.folders.find((x) => x.id === f.id) : undefined;
    if (!folder) {
      folder = { id: uid(), name: '', parentId: f.parentId ?? null };
      this.data.folders.push(folder);
    }
    folder.name = str(f.name, 120);
    this.save();
    return folder.id;
  }

  /** Klasörü kendi alt klasörüne taşımayı reddeder */
  moveFolder(id: string, parentId: string | null): boolean {
    for (let p = parentId; p; p = this.data.folders.find((x) => x.id === p)?.parentId ?? null) if (p === id) return false;
    const f = this.data.folders.find((x) => x.id === id);
    if (f) f.parentId = parentId;
    this.save();
    return true;
  }

  /** Klasör silinince içeriği üst klasöre taşınır */
  deleteFolder(id: string): void {
    const f = this.data.folders.find((x) => x.id === id);
    if (!f) return;
    for (const c of this.data.connections) if (c.folderId === id) c.folderId = f.parentId;
    for (const sub of this.data.folders) if (sub.parentId === id) sub.parentId = f.parentId;
    this.data.folders = this.data.folders.filter((x) => x.id !== id);
    this.save();
  }
}
