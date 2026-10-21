// Bağlantı penceresinin paylaşılan durumu.
import type { CompletionSchema, ServerInfo, SqlDialect, TreeNode } from '../../core/provider';
import type { PublicConnection, Settings } from '../../shared/types';
import type { ReportDef } from '../../core/report/model';
import { providerMeta } from '../../shared/providers';
import { api } from '../lib/api';

export interface Tab {
  id: string;
  title: string;
  icon: string;
  el: HTMLElement;
  /** Kapatmadan önce sorulacak (kaydedilmemiş SQL) */
  dirty?: () => boolean;
  onActivate?: () => void;
  onClose?: () => void;
}

export interface Ctx {
  conn: PublicConnection;
  info: ServerInfo | null;
  dialect: SqlDialect;
  settings: Settings;
  readOnly: boolean;
  /** Sunucudaki veritabanları (SQL sekmesinde seçilebilir) */
  databases: string[];
  defaultDatabase: string | undefined;
  openTab(tab: Tab): void;
  activateTab(id: string): boolean;
  closeTab(id: string): void;
  openSql(sql?: string, database?: string, title?: string): void;
  openData(node: TreeNode): void;
  openCode(node: TreeNode): void;
  /** Sorgu oluşturucuyu açar; düğüm verilirse tuvale ekler */
  openBuilder(node?: TreeNode): void;
  /** Kayıtlı raporu tasarım sekmesinde açar */
  openReport(def: ReportDef): void;
  /** "Rapor ekle" sihirbazı; tablo verilirse önceden seçilir */
  addReport(table?: TreeNode): void;
  completion(database?: string): Promise<CompletionSchema | null>;
  setStatus(text: string): void;
}

const cache = new Map<string, Promise<CompletionSchema | null>>();

export function makeCompletion(dbDefault: () => string | undefined) {
  return (database?: string) => {
    const key = database ?? dbDefault() ?? '';
    let p = cache.get(key);
    if (!p) {
      p = api.dbCompletion(database).catch(() => null);
      cache.set(key, p);
    }
    return p;
  };
}

export const resetCompletion = () => cache.clear();

export const dialectOf = (c: PublicConnection): SqlDialect => providerMeta(c.provider).dialect;
