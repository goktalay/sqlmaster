// Sürücülerden gelen değerleri süreçler arası taşınabilir, görüntülenebilir hücre değerlerine indirger.
import type { Cell } from './provider';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Date → "YYYY-MM-DD HH:mm:ss[.SSS]" (UTC bileşenleriyle; sürücüler değeri UTC olarak taşır) */
export function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return String(d);
  const ms = d.getUTCMilliseconds();
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return ms ? `${base}.${pad(ms, 3)}` : base;
}

const MAX_BINARY = 256;

export function toHex(b: Uint8Array): string {
  const n = Math.min(b.length, MAX_BINARY);
  let s = '0x';
  for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0');
  return b.length > n ? `${s}… (${b.length} bayt)` : s;
}

const jsonReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v);

export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
    case 'object':
      if (v instanceof Date) return formatDate(v);
      if (v instanceof Uint8Array) return toHex(v);
      try {
        return JSON.stringify(v, jsonReplacer);
      } catch {
        return String(v);
      }
    default:
      return String(v);
  }
}

export const toRow = (r: unknown[]): Cell[] => r.map(toCell);
