// Baskı raporu tanımı: bir SQL sorgusu + sayfa düzeni. Bağlantıya bağlı saklanır (store.json › reports).
// Arayüzden ve sürücüden bağımsızdır; doğrulama ve kolon eşleştirme burada (birim testli).
import type { ColumnMeta } from '../provider';

export type ReportLayout = 'table' | 'grouped' | 'summary' | 'cards';
export type ColumnFormat = 'auto' | 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime';
export type TotalKind = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max';
export type ColumnAlign = 'auto' | 'left' | 'center' | 'right';
export type PageSize = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal';

export const LAYOUTS: readonly ReportLayout[] = ['table', 'grouped', 'summary', 'cards'];
export const FORMATS: readonly ColumnFormat[] = ['auto', 'text', 'number', 'money', 'percent', 'date', 'datetime'];
export const TOTALS: readonly TotalKind[] = ['none', 'sum', 'avg', 'count', 'min', 'max'];
export const ALIGNS: readonly ColumnAlign[] = ['auto', 'left', 'center', 'right'];
export const PAGE_SIZES: readonly PageSize[] = ['A4', 'A3', 'A5', 'Letter', 'Legal'];

export interface ReportColumn {
  name: string;
  label: string;
  visible: boolean;
  align: ColumnAlign;
  format: ColumnFormat;
  /** Ondalık basamak; null → biçime göre otomatik */
  decimals: number | null;
  total: TotalKind;
  /** Sorgudan gelen tipten: sayısal mı (hizalama, toplam ve "otomatik" biçim için) */
  numeric: boolean;
}

export interface ReportPage {
  size: PageSize;
  orientation: 'portrait' | 'landscape';
  /** Kenar boşluğu (mm) */
  margin: number;
}

export interface ReportDef {
  id: string;
  connectionId: string;
  name: string;
  database?: string;
  sql: string;
  layout: ReportLayout;
  /** Gruplu düzende gruplama kolonu */
  groupBy: string | null;
  /** Kart düzeninde kart başlığı kolonu */
  cardTitle: string | null;
  page: ReportPage;
  title: string;
  subtitle: string;
  footer: string;
  showDate: boolean;
  showPageNumbers: boolean;
  showRowNumbers: boolean;
  zebra: boolean;
  /** Para biçimi için ISO 4217 kodu (TRY, USD, EUR…) */
  currency: string;
  columns: ReportColumn[];
  /** Oluşturulduğu şablon (bilgi amaçlı) */
  template?: string;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_PAGE: ReportPage = { size: 'A4', orientation: 'portrait', margin: 15 };

export function emptyReport(p: { id: string; connectionId: string; name: string; now?: number }): ReportDef {
  const now = p.now ?? Date.now();
  return {
    id: p.id, connectionId: p.connectionId, name: p.name, sql: '', layout: 'table', groupBy: null, cardTitle: null,
    page: { ...DEFAULT_PAGE }, title: p.name, subtitle: '', footer: '', showDate: true, showPageNumbers: true,
    showRowNumbers: false, zebra: true, currency: 'TRY', columns: [], createdAt: now, updatedAt: now,
  };
}

const NUMERIC_TYPE = /int|num|dec|real|float|double|money|serial|bit\b|number/i;
const DATE_TYPE = /date|time/i;
export const isNumericType = (type: string) => NUMERIC_TYPE.test(type) && !DATE_TYPE.test(type);
export const isDateType = (type: string) => DATE_TYPE.test(type);

export function defaultColumn(meta: ColumnMeta): ReportColumn {
  const numeric = meta.numeric ?? isNumericType(meta.type);
  return {
    name: meta.name, label: meta.name, visible: true, align: 'auto',
    format: isDateType(meta.type) ? (/time/i.test(meta.type) && !/^date$/i.test(meta.type) ? 'datetime' : 'date') : 'auto',
    decimals: null, total: 'none', numeric,
  };
}

/**
 * Sorgu sonucunun kolonlarıyla rapor kolonlarını eşleştirir: var olanların ayarı ve sırası korunur,
 * yeni kolonlar sona eklenir, artık gelmeyenler düşer. Sayısallık her zaman sorgudan güncellenir.
 */
export function reconcileColumns(existing: ReportColumn[], meta: ColumnMeta[]): ReportColumn[] {
  const byName = new Map(meta.map((m) => [m.name, m]));
  const kept = existing.filter((c) => byName.has(c.name)).map((c) => {
    const m = byName.get(c.name)!;
    return { ...c, numeric: m.numeric ?? isNumericType(m.type) };
  });
  const known = new Set(kept.map((c) => c.name));
  const added = meta.filter((m) => !known.has(m.name)).map(defaultColumn);
  return [...kept, ...added];
}

// --- Doğrulama (depoya yazmadan önce; pencereden gelen veriye güvenilmez) -----------------
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const int = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

export function normalizeReport(raw: Partial<ReportDef> & { id: string; connectionId: string }, now = Date.now()): ReportDef {
  const base = emptyReport({ id: raw.id, connectionId: raw.connectionId, name: '', now });
  const cols = Array.isArray(raw.columns) ? raw.columns.slice(0, 200) : [];
  return {
    ...base,
    name: str(raw.name, 200).trim() || 'Rapor',
    database: raw.database ? str(raw.database, 200) : undefined,
    sql: str(raw.sql, 200_000),
    layout: oneOf(raw.layout, LAYOUTS, 'table'),
    groupBy: raw.groupBy ? str(raw.groupBy, 200) : null,
    cardTitle: raw.cardTitle ? str(raw.cardTitle, 200) : null,
    page: {
      size: oneOf(raw.page?.size, PAGE_SIZES, 'A4'),
      orientation: raw.page?.orientation === 'landscape' ? 'landscape' : 'portrait',
      margin: int(raw.page?.margin, 0, 50, DEFAULT_PAGE.margin),
    },
    title: str(raw.title, 300),
    subtitle: str(raw.subtitle, 500),
    footer: str(raw.footer, 500),
    showDate: bool(raw.showDate, true),
    showPageNumbers: bool(raw.showPageNumbers, true),
    showRowNumbers: bool(raw.showRowNumbers, false),
    zebra: bool(raw.zebra, true),
    currency: /^[A-Z]{3}$/.test(String(raw.currency)) ? String(raw.currency) : 'TRY',
    columns: cols.map((c) => ({
      name: str(c?.name, 200),
      label: str(c?.label ?? c?.name, 200),
      visible: bool(c?.visible, true),
      align: oneOf(c?.align, ALIGNS, 'auto'),
      format: oneOf(c?.format, FORMATS, 'auto'),
      decimals: c?.decimals == null ? null : int(c.decimals, 0, 6, 2),
      total: oneOf(c?.total, TOTALS, 'none'),
      numeric: bool(c?.numeric, false),
    })).filter((c) => c.name),
    template: raw.template ? str(raw.template, 40) : undefined,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: now,
  };
}
