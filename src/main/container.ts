// Servis kökü (composition root): tüm servisler burada bir kez kurulur ve bağımlılıkları açıkça verilir.
// Testlerde ya da farklı ortamlarda (geliştirme hesabı gibi) yalnızca bu fabrika değişir.
import path from 'node:path';
import type { ILogger } from './logger';
import { createLogger } from './logger';
import { createSecretStore, type ICipher, type ISecretStore } from './secrets';
import { Store } from './store';
import { History } from './history';
import type { AccountEvents, IAccountService } from './account/types';
import { createMastertoolAccount } from './account/mastertool';
import { createDevAccount } from './account/dev';
import { createLibraryAdapter } from './account/library';

export interface Services {
  log: ILogger;
  secrets: ISecretStore;
  store: Store;
  history: History;
  account: IAccountService;
}

export interface ServiceOptions {
  userDataDir: string;
  appVersion: string;
  cipher: ICipher;
  devAccount: boolean;
  accountEvents: AccountEvents;
  onLibraryApplied: () => void;
}

export function createServices(o: ServiceOptions): Services {
  const log = createLogger(path.join(o.userDataDir, 'logs'), process.env.SQLM_DEBUG ? 'debug' : 'info');
  const secrets = createSecretStore(path.join(o.userDataDir, 'secrets.json'), o.cipher);
  const store = new Store(path.join(o.userDataDir, 'store.json'), secrets);
  const history = new History(path.join(o.userDataDir, 'history.jsonl'));
  const protect = (s: string) => (o.cipher.isAvailable() ? 'enc:' + o.cipher.encrypt(s).toString('base64') : '');
  const unprotect = (s: string) => {
    if (!s.startsWith('enc:')) throw new Error('korumasız değer');
    return o.cipher.decrypt(Buffer.from(s.slice(4), 'base64'));
  };
  const account = o.devAccount
    ? createDevAccount(o.accountEvents)
    : createMastertoolAccount({
        ...o.accountEvents,
        userDataDir: o.userDataDir,
        appVersion: o.appVersion,
        protect,
        unprotect,
        library: createLibraryAdapter(store, secrets, o.userDataDir, o.onLibraryApplied),
        log: (m, d) => log.warn(m, d),
      });
  store.onLibraryChange = () => account.onLocalChange();
  if (!secrets.persistent) log.warn('İşletim sistemi anahtar zinciri kullanılamıyor: parolalar yalnızca oturum boyunca bellekte tutulacak');
  return { log, secrets, store, history, account };
}
