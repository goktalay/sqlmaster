// Senkron birleştirme mantığı (sunucudan bağımsız, saf fonksiyonlar — birim testli).
// Her öğe: { id, kind, updated_at, rev, device, deleted, data }. Aynı id'de büyük updated_at → büyük rev →
// büyük cihaz kimliği kazanır (deterministik). Silinenler 30 gün mezar taşı olarak tutulur.
import { hashOf, stable } from './crypto';
import type { SyncMetaEntry } from '../store';

export interface SyncItem {
  id: string;
  kind: string;
  updated_at: number;
  rev: number;
  device: string;
  deleted: boolean;
  data: Record<string, unknown> | null;
}

export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SETTINGS_ID = 'settings';

export const newer = (a: SyncItem, b: SyncItem) =>
  a.updated_at !== b.updated_at ? a.updated_at > b.updated_at : (a.rev || 0) !== (b.rev || 0) ? (a.rev || 0) > (b.rev || 0) : String(a.device || '') > String(b.device || '');

export function merge(a: SyncItem[], b: SyncItem[], now = Date.now()): SyncItem[] {
  const map = new Map<string, SyncItem>();
  for (const it of [...a, ...b]) {
    const prev = map.get(it.id);
    if (!prev || newer(it, prev)) map.set(it.id, it);
  }
  return [...map.values()].filter((it) => !(it.deleted && now - it.updated_at > TOMBSTONE_TTL_MS));
}

export const itemsKey = (items: SyncItem[]) =>
  stable([...items].sort((x, y) => (x.id < y.id ? -1 : 1)).map((x) => [x.id, x.updated_at, x.rev, x.deleted]));

/**
 * Yerel verinin o anki halini meta ile karşılaştırır; değişen/yeni/silinen öğelerin damgasını ilerletir.
 * Bu cihazın ayarları ilk kez kayda geçiyorsa updated_at = 0 alır: hesaptaki ayarlar varsayılanların üzerine yazılmaz.
 */
export function refreshMeta(
  meta: Record<string, SyncMetaEntry>,
  current: Map<string, { kind: string; data: Record<string, unknown> }>,
  device: string,
  now = Date.now(),
): boolean {
  let changed = false;
  for (const [id, { kind, data }] of current) {
    const h = hashOf(data);
    const old = meta[id];
    if (!old || old.deleted || old.hash !== h) {
      const fresh = id === SETTINGS_ID && !old;
      meta[id] = { kind, hash: h, updated_at: fresh ? 0 : now, rev: (old ? old.rev : 0) + 1, device, deleted: false };
      changed = true;
    }
  }
  for (const [id, old] of Object.entries(meta)) {
    if (!current.has(id) && !old.deleted) {
      meta[id] = { ...old, hash: null, deleted: true, updated_at: now, rev: old.rev + 1, device };
      changed = true;
    }
    if (meta[id].deleted && now - meta[id].updated_at > TOMBSTONE_TTL_MS) {
      delete meta[id];
      changed = true;
    }
  }
  return changed;
}

export function itemsFromMeta(meta: Record<string, SyncMetaEntry>, current: Map<string, { kind: string; data: Record<string, unknown> }>): SyncItem[] {
  return Object.entries(meta).map(([id, x]) => ({
    id, kind: x.kind, updated_at: x.updated_at, rev: x.rev, device: x.device, deleted: !!x.deleted,
    data: x.deleted ? null : current.get(id)?.data ?? null,
  }));
}
