// Pencerelere açılan güvenli köprü (contextIsolation). Parolalar ve bağlantı dizeleri pencerelere asla gelmez.
import { contextBridge, ipcRenderer } from 'electron';

const on = (channel: string) => (cb: (data: unknown) => void) => {
  const listener = (_e: unknown, data: unknown) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const inv = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  lang: ipcRenderer.sendSync('app:lang') as string,
  version: ipcRenderer.sendSync('app:version') as string,
  providers: inv('app:providers'),
  showMain: inv('app:showMain'),
  clipboardWrite: inv('clipboard:write'),
  openFileDialog: inv('dialog:openFile'),

  // hesap
  accountState: inv('account:state'),
  login: (email: string, password: string, remember: boolean) => ipcRenderer.invoke('account:login', { email, password, remember }),
  logout: inv('account:logout'),
  syncNow: inv('account:syncNow'),
  setSyncEnabled: inv('account:setSync'),
  deleteRemoteLibrary: inv('account:deleteRemote'),
  openWeb: inv('account:openWeb'),
  onAccountStatus: on('account:status'),
  onUpdateAvailable: on('app:update'),
  onLibraryBackup: on('account:backup'),

  // depo
  getStore: inv('store:get'),
  onStoreChanged: on('store:changed'),
  setSettings: inv('settings:set'),

  // bağlantılar / klasörler
  saveConnection: inv('conn:save'),
  deleteConnection: inv('conn:delete'),
  duplicateConnection: inv('conn:duplicate'),
  moveConnection: (id: string, folderId: string | null) => ipcRenderer.invoke('conn:move', { id, folderId }),
  testConnection: inv('conn:test'),
  openConnection: inv('conn:open'),
  saveFolder: inv('folder:save'),
  moveFolder: (id: string, parentId: string | null) => ipcRenderer.invoke('folder:move', { id, parentId }),
  deleteFolder: inv('folder:delete'),

  // bağlantı penceresi
  cwInfo: inv('cw:info'),
  cwConnect: inv('cw:connect'),
  dbChildren: inv('db:children'),
  dbDdl: inv('db:ddl'),
  dbColumns: inv('db:columns'),
  dbCompletion: inv('db:completion'),
  dbExecute: inv('db:execute'),
  dbCancel: inv('db:cancel'),
  dbSetReadOnly: inv('db:setReadOnly'),
  dbExport: inv('db:export'),
  historyList: inv('history:list'),
  reveal: inv('shell:reveal'),
  onDbEvent: on('db:event'),
  onDbProgress: on('db:progress'),
  onDbReset: on('db:reset'),
};

export type PreloadApi = typeof api;
contextBridge.exposeInMainWorld('api', api);
