// Hesap katmanının soyut arayüzü. Uygulama yalnızca bunu tanır; somut sınıf Mastertool sunucusuyla
// (sözleşme v1, /api/sq/...) ya da yerel geliştirme kipiyle konuşur.
import type { AccountState } from '../../shared/types';

export interface UpdateInfo {
  version: string;
  notes: string;
}

export interface IAccountService {
  isLoggedIn(): boolean;
  state(): AccountState;
  login(email: string, password: string, remember: boolean): Promise<{ backupFile: string | null }>;
  logout(): Promise<void>;
  /** Açılışta: oturum doğrulama, senkron, sürüm kontrolü */
  start(): Promise<void>;
  syncNow(): Promise<void>;
  /** Kütüphane değişti: birkaç saniye sonra senkronla */
  onLocalChange(): void;
  setSyncEnabled(on: boolean): Promise<void>;
  deleteRemote(): Promise<void>;
  checkUpdate(): Promise<void>;
  /** Ayarlar › Hakkında › Güncellemeleri denetle */
  latestRelease(): Promise<{ version: string | null; notes?: string }>;
  /** Ortak oturum (sso.ts): kendi oturumu yokken cihazdaki ortak kimlikle şifresiz giriş dener */
  trySso(): Promise<SsoResult>;
  /** Ortak oturum durumunu izlemeye başlar (başka uygulamada giriş/çıkış) */
  startWatching(): void;
  stopWatching(): void;
}

export interface SsoResult {
  ok: boolean;
  code?: string;
  backupFile?: string | null;
}

export interface AccountEvents {
  onStatus(st: AccountState): void;
  onSessionExpired(code: string): void;
  onUpdate(info: UpdateInfo): void;
  /** Başka bir Mastertool uygulamasındaki girişle şifresiz oturum açıldı */
  onSignedIn?(backupFile: string | null): void;
}

export class AccountError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly body?: unknown) {
    super(message || code);
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}
