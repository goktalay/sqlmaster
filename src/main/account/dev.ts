// Yerel geliştirme hesabı: yalnızca paketlenmemiş sürümde ve SQLM_DEV_ACCOUNT=1 iken kullanılır.
// Sunucu sözleşmesi gelene kadar uygulamanın geri kalanını geliştirip denemeyi sağlar; senkron yapmaz.
// Paketlenmiş exe'de asla etkin olmaz (bkz. main.ts).
import type { AccountState } from '../../shared/types';
import type { AccountEvents, IAccountService } from './types';

export function createDevAccount(events: AccountEvents): IAccountService {
  let state: AccountState = { loggedIn: false, user: null, email: '', syncEnabled: false, state: 'off', lastSyncAt: null, error: null, devMode: true };
  const emit = () => events.onStatus(state);
  return {
    isLoggedIn: () => state.loggedIn,
    state: () => state,
    async login(email) {
      state = { ...state, loggedIn: true, email, user: { id: 'dev', email: email || 'dev@localhost', name: 'Geliştirici' } };
      emit();
      return { backupFile: null };
    },
    async logout() {
      state = { ...state, loggedIn: false, user: null };
      emit();
    },
    async start() { emit(); },
    async syncNow() { /* senkron yok */ },
    onLocalChange() { /* senkron yok */ },
    async setSyncEnabled() { /* senkron yok */ },
    async deleteRemote() { /* senkron yok */ },
    async checkUpdate() { /* sürüm kontrolü yok */ },
    async latestRelease() { return { version: null }; },
    async trySso() { return { ok: false }; },
    startWatching() { /* ortak oturum yok */ },
    stopWatching() { /* ortak oturum yok */ },
  };
}
