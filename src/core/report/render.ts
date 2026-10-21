// Rapor → baskıya hazır, kendi kendine yeten HTML belgesi (betik yok). Aynı belge önizlemede (iframe),
// yazdırmada ve PDF'te kullanılır. Sayfa boyutu/kenar boşluğu @page ile, sayfa numarası @page kenar kutularıyla.
import type { Cell, ColumnMeta } from '../provider';
import type { ReportColumn, ReportDef, TotalKind } from './model';

export interface ReportData {
  columns: ColumnMeta[];
  rows: Cell[][];
  truncated: boolean;
}

export interface RenderOptions {
  locale: string;
  dir?: 'ltr' | 'rtl';
  now: Date;
  /** Önizleme: ekranda kâğıt görünümü */
  preview?: boolean;
  strings: {
    /** "Sayfa {p} / {n}" */
    page: string;
    printed: string;
    total: string;
    subtotal: string;
    /** "{n} kayıt" */
    rows: string;
    /** "İlk {n} satır gösteriliyor (satır sınırı)" */
    truncated: string;
    empty: string;
    /** Özet kutusunda kayıt sayısı başlığı */
    count: string;
  };
}

const PAGE_MM: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };

export const escHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const cssStr = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
const fill = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

export function toNumber(v: Cell | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i.test(v)) return Number(v);
  return null;
}

/** Veritabanından gelen tarih metnini (ör. "2026-04-17 00:39:00+00") çözer; yalnız tarihse UTC'de gösterilir */
function toDate(v: Cell): { d: Date; dateOnly: boolean } | null {
  if (typeof v === 'number') return { d: new Date(v), dateOnly: false };
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { d: new Date(s + 'T00:00:00Z'), dateOnly: true };
  const iso = s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : { d, dateOnly: false };
}

export function formatCell(v: Cell | undefined, col: ReportColumn, locale: string, currency: string): string {
  if (v === null || v === undefined || v === '') return '';
  const n = toNumber(v);
  const nf = (o: Intl.NumberFormatOptions) => { try { return new Intl.NumberFormat(locale, o); } catch { return new Intl.NumberFormat('en', o); } };
  const digits = (def: number) => {
    const x = col.decimals ?? def;
    return { minimumFractionDigits: x, maximumFractionDigits: x };
  };
  switch (col.format) {
    case 'text':
      return String(v);
    case 'number':
      return n === null ? String(v) : nf(digits(Number.isInteger(n) ? 0 : 2)).format(n);
    case 'money':
      if (n === null) return String(v);
      try { return new Intl.NumberFormat(locale, { style: 'currency', currency, ...digits(2) }).format(n); } catch { return nf(digits(2)).format(n); }
    case 'percent':
      return n === null ? String(v) : nf({ style: 'percent', ...digits(Number.isInteger(n) ? 0 : 1) }).format(n / 100);
    case 'date':
    case 'datetime': {
      const p = toDate(v);
      if (!p) return String(v);
      const o: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', ...(col.format === 'datetime' && !p.dateOnly ? { hour: '2-digit', minute: '2-digit' } : {}), ...(p.dateOnly ? { timeZone: 'UTC' } : {}) };
      try { return new Intl.DateTimeFormat(locale, o).format(p.d); } catch { return String(v); }
    }
    default:
      if (typeof v === 'boolean') return v ? '✓' : '—';
      if (col.numeric && n !== null) return nf(col.decimals !== null ? digits(2) : { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
      return String(v);
  }
}

export function computeTotal(kind: TotalKind, values: (Cell | undefined)[]): number | null {
  if (kind === 'none') return null;
  if (kind === 'count') return values.filter((v) => v !== null && v !== undefined && v !== '').length;
  const nums = values.map(toNumber).filter((x): x is number => x !== null);
  if (!nums.length) return null;
  switch (kind) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
  }
}

const alignOf = (c: ReportColumn) => (c.align !== 'auto' ? c.align : c.numeric || c.format === 'number' || c.format === 'money' || c.format === 'percent' ? 'right' : 'left');

export function renderReport(def: ReportDef, data: ReportData, o: RenderOptions): string {
  const S = o.strings;
  const idx = new Map(data.columns.map((c, i) => [c.name, i]));
  const val = (row: Cell[], c: ReportColumn) => row[idx.get(c.name)!];
  // "Otomatik" sayısal kolonlarda ondalık basamak kolon boyunca sabit: herhangi bir değer kesirliyse hepsi 2 basamak
  const effective = (c: ReportColumn): ReportColumn => {
    if (c.format !== 'auto' || !c.numeric || c.decimals !== null || !idx.has(c.name)) return c;
    const i = idx.get(c.name)!;
    const frac = data.rows.some((r) => { const n = toNumber(r[i]); return n !== null && !Number.isInteger(n); });
    return { ...c, decimals: frac ? 2 : 0 };
  };
  const cols = def.columns.filter((c) => c.visible && idx.has(c.name)).map(effective);
  const fmt = (v: Cell | undefined, c: ReportColumn) => escHtml(formatCell(v, c, o.locale, def.currency));
  const fmtTotal = (n: number | null, c: ReportColumn) => {
    if (n === null) return '';
    const asCol = c.total === 'count' ? { ...c, format: 'number' as const, decimals: 0 } : c.format === 'auto' || c.format === 'text' ? { ...c, format: 'number' as const } : c;
    return escHtml(formatCell(n, asCol, o.locale, def.currency));
  };
  const hasTotals = cols.some((c) => c.total !== 'none');
  const [w, hgt] = PAGE_MM[def.page.size] ?? PAGE_MM.A4;
  const [pw, ph] = def.page.orientation === 'landscape' ? [hgt, w] : [w, hgt];
  const m = def.page.margin;

  // --- Gövde ---------------------------------------------------------------------------
  const rowNo = def.showRowNumbers;
  const tableCols = def.layout === 'grouped' && def.groupBy ? cols.filter((c) => c.name !== def.groupBy) : cols;
  const thead = `<thead><tr>${rowNo ? '<th class="rn">#</th>' : ''}${tableCols.map((c) => `<th class="a-${alignOf(c)}">${escHtml(c.label || c.name)}</th>`).join('')}</tr></thead>`;
  const bodyRows = (rows: Cell[][], start: number) =>
    rows.map((r, i) => `<tr>${rowNo ? `<td class="rn">${start + i + 1}</td>` : ''}${tableCols.map((c) => `<td class="a-${alignOf(c)}">${fmt(val(r, c), c)}</td>`).join('')}</tr>`).join('');
  const totalRow = (rows: Cell[][], label: string, cls: string) => {
    if (!hasTotals) return '';
    const cells = tableCols.map((c) => `<td class="a-${alignOf(c)}">${fmtTotal(computeTotal(c.total, rows.map((r) => val(r, c))), c)}</td>`);
    // Etiket ilk toplamsız hücreye (yoksa sıra no hücresine) yazılır
    const first = tableCols.findIndex((c) => c.total === 'none');
    if (rowNo) return `<tr class="${cls}"><td class="rn"></td>${first >= 0 ? cells.map((x, i) => (i === first ? `<td class="lbl">${escHtml(label)}</td>` : x)).join('') : cells.join('')}</tr>`;
    return `<tr class="${cls}">${first >= 0 ? cells.map((x, i) => (i === first ? `<td class="lbl">${escHtml(label)}</td>` : x)).join('') : cells.join('')}</tr>`;
  };

  let body = '';
  if (!data.rows.length) {
    body = `<p class="empty">${escHtml(S.empty)}</p>`;
  } else if (def.layout === 'cards') {
    const titleCol = cols.find((c) => c.name === def.cardTitle) ?? cols[0];
    const rest = cols.filter((c) => c !== titleCol);
    body = `<div class="cards">${data.rows.map((r) => `<div class="card"><div class="card-t">${titleCol ? fmt(val(r, titleCol), titleCol) : ''}</div>${rest.map((c) => {
      const v = fmt(val(r, c), c);
      return v ? `<div class="card-r"><span>${escHtml(c.label || c.name)}</span><b>${v}</b></div>` : '';
    }).join('')}</div>`).join('')}</div>`;
  } else if (def.layout === 'grouped' && def.groupBy && idx.has(def.groupBy)) {
    const gcol = cols.find((c) => c.name === def.groupBy) ?? def.columns.find((c) => c.name === def.groupBy) ?? { name: def.groupBy, label: def.groupBy, visible: true, align: 'auto', format: 'auto', decimals: null, total: 'none', numeric: false } as ReportColumn;
    const groups: { key: string; value: Cell; rows: Cell[][] }[] = [];
    for (const r of data.rows) {
      const v = val(r, gcol);
      const key = String(v ?? '');
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(r);
      else groups.push({ key, value: v, rows: [r] });
    }
    const span = tableCols.length + (rowNo ? 1 : 0);
    let n = 0;
    body = `<table>${thead}${groups.map((g) => {
      const html = `<tbody class="grp"><tr class="gh"><td colspan="${span}">${escHtml(gcol.label || gcol.name)}: <b>${fmt(g.value, gcol) || '—'}</b><span class="gc">${escHtml(fill(S.rows, { n: new Intl.NumberFormat(o.locale).format(g.rows.length) }))}</span></td></tr>${bodyRows(g.rows, n)}${totalRow(g.rows, S.subtotal, 'sub')}</tbody>`;
      n += g.rows.length;
      return html;
    }).join('')}<tfoot>${totalRow(data.rows, S.total, 'tot')}</tfoot></table>`;
  } else {
    let kpis = '';
    if (def.layout === 'summary') {
      const boxes = [`<div class="kpi"><span>${escHtml(S.count)}</span><b>${escHtml(new Intl.NumberFormat(o.locale).format(data.rows.length))}</b></div>`];
      for (const c of cols.filter((x) => x.total !== 'none').slice(0, 4)) {
        boxes.push(`<div class="kpi"><span>${escHtml(c.label || c.name)}</span><b>${fmtTotal(computeTotal(c.total, data.rows.map((r) => val(r, c))), c)}</b></div>`);
      }
      kpis = `<div class="kpis">${boxes.join('')}</div>`;
    }
    body = `${kpis}<table>${thead}<tbody>${bodyRows(data.rows, 0)}</tbody><tfoot>${totalRow(data.rows, S.total, 'tot')}</tfoot></table>`;
  }

  const printed = def.showDate
    ? `${escHtml(S.printed)} ${escHtml(new Intl.DateTimeFormat(o.locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(o.now))}`
    : '';
  const [pre, mid, post] = (() => {
    const a = S.page.split('{p}');
    const b = (a[1] ?? '').split('{n}');
    return [a[0] ?? '', b[0] ?? '', b[1] ?? ''];
  })();
  const pageBox = def.showPageNumbers ? `@bottom-right { content: ${cssStr(pre)} counter(page) ${cssStr(mid)} counter(pages) ${cssStr(post)}; font: 8pt ${'var(--f)'}; color: #6b7280; }` : '';
  const footBox = def.footer ? `@bottom-left { content: ${cssStr(def.footer)}; font: 8pt var(--f); color: #6b7280; }` : '';
  const end = `<div class="end">${escHtml(fill(S.rows, { n: new Intl.NumberFormat(o.locale).format(data.rows.length) }))}${data.truncated ? ` · <span class="warn">${escHtml(fill(S.truncated, { n: data.rows.length }))}</span>` : ''}</div>`;

  return `<!doctype html>
<html lang="${escHtml(o.locale)}" dir="${o.dir ?? 'ltr'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escHtml(def.title || def.name)}</title>
<style>
:root { --f: "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
@page { size: ${def.page.size} ${def.page.orientation}; margin: ${m}mm; ${pageBox} ${footBox} }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.5pt/1.4 var(--f); color: #111827; background: #fff; }
.hdr { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding-bottom: 8px; margin-bottom: 12px; border-bottom: 2px solid #111827; }
h1 { margin: 0; font-size: 17pt; font-weight: 700; letter-spacing: -.2px; }
.sub { margin-top: 3px; color: #4b5563; font-size: 10pt; }
.meta { color: #6b7280; font-size: 8.5pt; white-space: nowrap; text-align: end; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tfoot { display: table-row-group; }
th { text-align: start; font-size: 8.5pt; font-weight: 700; color: #374151; background: #eef2f7; padding: 5px 7px; border-bottom: 1px solid #cbd5e1; }
td { padding: 4px 7px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
tr { break-inside: avoid; }
${def.zebra ? 'tbody tr:nth-child(even) td { background: #f8fafc; }' : ''}
.a-right { text-align: end; font-variant-numeric: tabular-nums; }
.a-center { text-align: center; }
.a-left { text-align: start; }
.rn { width: 1%; color: #9ca3af; text-align: end; font-variant-numeric: tabular-nums; }
.grp { break-inside: auto; }
tr.gh td { background: #e0f2fe !important; color: #0c4a6e; font-size: 9.5pt; padding: 6px 7px; border-bottom: 1px solid #7dd3fc; break-after: avoid; }
.gc { float: inline-end; font-weight: 400; color: #0369a1; font-size: 8.5pt; }
tr.sub td { font-weight: 600; background: #f1f5f9 !important; border-bottom: 1px solid #94a3b8; }
tr.tot td { font-weight: 700; background: #e2e8f0 !important; border-top: 2px solid #111827; border-bottom: none; }
td.lbl { text-align: start; }
.kpis { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.kpi { flex: 1 1 120px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; break-inside: avoid; }
.kpi span { display: block; font-size: 8pt; color: #6b7280; }
.kpi b { font-size: 13pt; font-variant-numeric: tabular-nums; }
.cards { display: grid; grid-template-columns: repeat(${def.page.orientation === 'landscape' ? 3 : 2}, 1fr); gap: 8px; }
.card { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; break-inside: avoid; }
.card-t { font-weight: 700; font-size: 10.5pt; margin-bottom: 4px; }
.card-r { display: flex; justify-content: space-between; gap: 10px; font-size: 8.5pt; padding: 1px 0; border-top: 1px dotted #e5e7eb; }
.card-r span { color: #6b7280; }
.card-r b { font-weight: 500; text-align: end; }
.empty { color: #6b7280; padding: 24px 0; text-align: center; }
.end { margin-top: 10px; color: #6b7280; font-size: 8pt; }
.warn { color: #b45309; }
${o.preview ? `@media screen {
  html { background: #525659; }
  body { width: ${pw}mm; min-height: ${ph}mm; margin: 16px auto; padding: ${m}mm; box-shadow: 0 2px 12px rgba(0,0,0,.45); }
  .pf { display: flex; justify-content: space-between; margin-top: 18px; color: #9ca3af; font-size: 8pt; border-top: 1px dashed #d1d5db; padding-top: 4px; }
}
@media print { .pf { display: none; } }` : '.pf { display: none; }'}
</style></head><body>
<header class="hdr"><div><h1>${escHtml(def.title || def.name)}</h1>${def.subtitle ? `<div class="sub">${escHtml(def.subtitle)}</div>` : ''}</div><div class="meta">${printed}</div></header>
${body}
${end}
${def.footer ? `<div class="pf"><span>${escHtml(def.footer)}</span></div>` : ''}
</body></html>`;
}
