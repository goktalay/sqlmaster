// Ön yükleme köprüsünün tipli görünümü.
import type { AccountState, ConnectionForm, HistoryEntry, PublicConnection, PublicStore, Settings } from '../../shared/types';
import type { ProviderMeta } from '../../shared/providers';
import type { ColumnMeta, CompletionSchema, NodePath, ServerInfo, TreeNode } from '../../core/provider';
import type { ExecEvent, ExecuteRequest } from '../../core/engine/executor';
import type { ExportFormat, ExportResult } from '../../core/engine/export';
import type { ReportDef } from '../../core/report/model';

type Unsub = () => void;

export interface TestResult {
  ok: boolean;
  ms?: number;
  info?: ServerInfo;
  message?: string;
  sshFingerprint?: string;
  firstSsh?: boolean;
}

export interface Api {
  lang: string;
  version: string;
  providers(): Promise<ProviderMeta[]>;
  showMain(): Promise<void>;
  clipboardWrite(text: string): Promise<void>;
  openFileDialog(opts: { provider?: string; save?: boolean; defaultPath?: string }): Promise<string | null>;
  about(): Promise<{ version: string; electron: string; chrome: string; node: string }>;
  checkUpdate(): Promise<{ ok: boolean; version?: string | null; newer?: boolean; message?: string }>;
  openLicenses(): Promise<void>;

  accountState(): Promise<AccountState & { notice: string | null; appVersion: string }>;
  login(email: string, password: string, remember: boolean): Promise<{ ok: boolean; code?: string; message?: string }>;
  logout(): Promise<void>;
  syncNow(): Promise<void>;
  setSyncEnabled(on: boolean): Promise<{ ok: boolean; code?: string }>;
  deleteRemoteLibrary(): Promise<{ ok: boolean; code?: string }>;
  openWeb(page: 'forgot' | 'register' | 'account' | 'mastertool'): Promise<void>;
  onAccountStatus(cb: (st: AccountState) => void): Unsub;
  onUpdateAvailable(cb: (info: { version: string; notes: string }) => void): Unsub;
  onLibraryBackup(cb: (file: string) => void): Unsub;

  getStore(): Promise<PublicStore>;
  onStoreChanged(cb: (s: PublicStore) => void): Unsub;
  setSettings(patch: Partial<Settings>): Promise<void>;

  saveConnection(form: ConnectionForm): Promise<string>;
  deleteConnection(id: string): Promise<void>;
  duplicateConnection(id: string): Promise<void>;
  moveConnection(id: string, folderId: string | null): Promise<void>;
  testConnection(form: ConnectionForm): Promise<TestResult>;
  openConnection(id: string): Promise<void>;
  saveFolder(f: { id?: string; name: string; parentId?: string | null }): Promise<string>;
  moveFolder(id: string, parentId: string | null): Promise<boolean>;
  deleteFolder(id: string): Promise<void>;

  cwInfo(): Promise<{ connection: PublicConnection; needsPassword: boolean; settings: Settings }>;
  cwConnect(opts?: { password?: string }): Promise<{ ok: boolean; info?: ServerInfo; readOnly?: boolean; message?: string }>;
  dbChildren(node: TreeNode | null): Promise<TreeNode[]>;
  dbDdl(node: TreeNode): Promise<string>;
  dbColumns(path: NodePath): Promise<ColumnMeta[]>;
  dbCompletion(database?: string): Promise<CompletionSchema>;
  dbExecute(p: { runId: string; req: Omit<ExecuteRequest, 'readOnly'> }): Promise<{ errors: number; cancelled: boolean }>;
  dbCancel(runId: string): Promise<void>;
  dbSetReadOnly(on: boolean): Promise<boolean>;
  dbExport(p: { runId: string; sql: string; database?: string; format: ExportFormat; defaultName: string }): Promise<(ExportResult & { filePath: string }) | null>;
  historyList(): Promise<HistoryEntry[]>;
  reportList(): Promise<ReportDef[]>;
  reportSave(def: Partial<ReportDef>): Promise<ReportDef>;
  reportDelete(id: string): Promise<void>;
  reportPrint(html: string): Promise<boolean>;
  reportPdf(html: string, name: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
  onDbEvent(cb: (m: { runId: string; ev: ExecEvent }) => void): Unsub;
  onDbProgress(cb: (m: { runId: string; rows: number }) => void): Unsub;
  onDbReset(cb: (m: { reason: string }) => void): Unsub;
}

export const api = (window as unknown as { api: Api }).api;
