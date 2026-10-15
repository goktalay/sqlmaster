// Ana süreç ↔ veritabanı süreci (utilityProcess) mesaj sözleşmesi.
import type { ColumnMeta, CompletionSchema, ConnectionConfig, NodePath, ServerInfo, TreeNode } from '../core/provider';
import type { ExecEvent, ExecuteRequest } from '../core/engine/executor';
import type { ExportFormat, ExportResult } from '../core/engine/export';

export interface HostMethods {
  connect(p: { cfg: ConnectionConfig }): { info: ServerInfo; sshFingerprint?: string };
  serverInfo(p: Record<string, never>): ServerInfo;
  children(p: { node: TreeNode | null }): TreeNode[];
  ddl(p: { node: TreeNode }): string;
  columns(p: { path: NodePath }): ColumnMeta[];
  completion(p: { database?: string }): CompletionSchema;
  execute(p: { runId: string; req: ExecuteRequest }): { errors: number; cancelled: boolean };
  cancel(p: { runId: string }): void;
  export(p: { runId: string; sql: string; database?: string; format: ExportFormat; filePath: string }): ExportResult;
  setReadOnly(p: { on: boolean }): void;
  close(p: Record<string, never>): void;
}

export type HostMethod = keyof HostMethods;

export type HostRequest = { [K in HostMethod]: { id: number; method: K; params: Parameters<HostMethods[K]>[0] } }[HostMethod];

export type HostMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: string }
  | { runId: string; event: ExecEvent }
  | { runId: string; progress: number };
