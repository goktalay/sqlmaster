// Ana süreç ve pencereler arasında paylaşılan veri tipleri.
import type { ProviderId, SslMode } from '../core/provider';

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface SshProfile {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: 'key' | 'password' | 'agent';
  /** Bu cihazdaki özel anahtar dosyası (senkronda içerik olarak taşınır) */
  keyPath: string;
  hostKey: string | null;
}

/** Diskteki bağlantı profili. Parolalar burada değil, ISecretStore'da durur. */
export interface ConnectionProfile {
  id: string;
  name: string;
  provider: ProviderId;
  host: string;
  port: number | null;
  database: string;
  user: string;
  /** SQLite/DuckDB dosyası */
  filePath: string;
  sslMode: SslMode;
  /** Varsayılan açık: DML/DDL öncesi onay ister */
  readOnly: boolean;
  savePassword: boolean;
  color: string;
  folderId: string | null;
  comments: string;
  ssh: SshProfile;
  createdAt: number;
  lastUsedAt?: number;
}

/** Pencereye giden kopya: gizli bilgi yerine yalnızca var/yok bilgisi */
export interface PublicConnection extends ConnectionProfile {
  hasPassword: boolean;
  hasSshPassword: boolean;
  hasSshPassphrase: boolean;
}

/** Bağlantı formundan gelen veri: boş parola alanı "değiştirme" demektir */
export interface ConnectionForm extends Omit<ConnectionProfile, 'id' | 'createdAt'> {
  id?: string;
  password?: string;
  clearPassword?: boolean;
  sshPassword?: string;
  sshPassphrase?: string;
}

export interface Settings {
  appTheme: 'dark' | 'light' | 'system';
  language: string | null;
  /** Sonuç kümesi başına satır sınırı */
  rowLimit: number;
  /** Tablo açılınca gösterilen kayıt sayısı */
  previewRows: number;
  editorFontSize: number;
  treeWidth: number;
  /** Bu cihaza özgü (senkronlanmaz): Windows oturumu açılınca başlat, tepsi davranışı */
  openAtLogin: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // Mastertool ortak standardı: varsayılan tema Sistem
  appTheme: 'system',
  language: null,
  rowLimit: 10_000,
  previewRows: 100,
  editorFontSize: 13,
  treeWidth: 300,
  openAtLogin: false,
  minimizeToTray: false,
  closeToTray: false,
};

export interface PublicStore {
  folders: Folder[];
  connections: PublicConnection[];
  settings: Settings;
}

export interface AccountState {
  loggedIn: boolean;
  user: { id: string; email: string; name?: string } | null;
  email: string;
  syncEnabled: boolean;
  state: 'idle' | 'syncing' | 'ok' | 'offline' | 'error' | 'off';
  lastSyncAt: number | null;
  error: string | null;
  errorMessage?: string;
  /** Hesap katmanı sunucu sözleşmesi gelene kadar yerel geliştirme kipinde mi */
  devMode?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  kind: 'server' | 'file';
  defaultPort?: number;
}

export interface HistoryEntry {
  at: number;
  connectionId: string;
  database?: string;
  sql: string;
  ms: number;
  ok: boolean;
  rows?: number;
}
