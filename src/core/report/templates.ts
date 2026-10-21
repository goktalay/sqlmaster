// "Rapor ekle" şablonları: seçilen tablonun kolonlarına göre baskıya hazır örnek sorgu + düzen üretir.
// Sorgular lehçeye göre tırnaklanır; satır sınırı uygulamanın genel sınırıyla çalıştırılırken uygulanır.
import type { ColumnMeta, SqlDialect } from '../provider';
import { ident, qualified, type TableRef } from '../sql/dialect';
import { defaultColumn, isDateType, isNumericType, type ReportColumn, type ReportLayout } from './model';

export type TemplateId = 'list' | 'grouped' | 'summary' | 'cards' | 'blank';
export const TEMPLATE_IDS: readonly TemplateId[] = ['list', 'grouped', 'summary', 'cards', 'blank'];

export interface TemplateInput {
  dialect: SqlDialect;
  table: TableRef | null;
  columns: ColumnMeta[];
  /** Kolon etiketleri için çeviri (rep.tpl.* anahtarları) */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export interface TemplateResult {
  sql: string;
  layout: ReportLayout;
  groupBy: string | null;
  cardTitle: string | null;
  showRowNumbers: boolean;
  columns: ReportColumn[];
}

const isId = (n: string) => /^id$|_id$|^id_|[a-z]Id$/i.test(n);
const numericOf = (c: ColumnMeta) => c.numeric ?? isNumericType(c.type);
// Gruplamaya en uygun metin kolonları (durum, kategori, şehir…)
const GROUP_HINT = /status|durum|state|category|kategori|type|tip|segment|city|sehir|şehir|^il$|region|bolge|bölge|country|ulke|ülke|department|departman|group|grup/i;

function pick(columns: ColumnMeta[]) {
  const texts = columns.filter((c) => !numericOf(c) && !isDateType(c.type) && !isId(c.name));
  const nums = columns.filter((c) => numericOf(c) && !isId(c.name));
  const dates = columns.filter((c) => isDateType(c.type));
  const group = texts.find((c) => GROUP_HINT.test(c.name)) ?? texts[0] ?? null;
  return { texts, nums, dates, group };
}

const alias = (prefix: string, name: string) => `${prefix}_${name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'col'}`;

export function buildTemplate(id: TemplateId, inp: TemplateInput): TemplateResult {
  const d = inp.dialect;
  const q = (n: string) => ident(n, d);
  const from = inp.table ? qualified(inp.table, d) : null;
  const cols = inp.columns;
  const { texts, nums, group } = pick(cols);
  const base: TemplateResult = { sql: '', layout: 'table', groupBy: null, cardTitle: null, showRowNumbers: false, columns: [] };
  const withCols = (metas: ColumnMeta[], patch: (c: ReportColumn) => Partial<ReportColumn> = () => ({})) =>
    metas.map((m) => { const c = defaultColumn(m); return { ...c, ...patch(c) }; });

  if (!from || id === 'blank' || !cols.length) {
    return { ...base, sql: from ? `SELECT *\nFROM ${from}` : '' };
  }

  if (id === 'list' || ((id === 'grouped' || id === 'summary') && !group)) {
    const sel = cols.slice(0, 8);
    const order = texts[0] ?? sel[0];
    return {
      ...base,
      sql: `SELECT ${sel.map((c) => q(c.name)).join(', ')}\nFROM ${from}\nORDER BY ${q(order.name)}`,
      showRowNumbers: true,
      columns: withCols(sel),
    };
  }

  if (id === 'grouped') {
    const g = group!;
    const rest = cols.filter((c) => c.name !== g.name).slice(0, 6);
    const sel = [g, ...rest];
    const second = rest.find((c) => !numericOf(c)) ?? rest[0];
    const sums = new Set(nums.slice(0, 3).map((c) => c.name));
    return {
      ...base,
      sql: `SELECT ${sel.map((c) => q(c.name)).join(', ')}\nFROM ${from}\nORDER BY ${q(g.name)}${second ? ', ' + q(second.name) : ''}`,
      layout: 'grouped',
      groupBy: g.name,
      columns: withCols(sel, (c) => (sums.has(c.name) ? { total: 'sum' } : {})),
    };
  }

  if (id === 'summary') {
    const g = group!;
    const measured = nums.slice(0, 3);
    const parts = [q(g.name), `COUNT(*) AS ${q('row_count')}`];
    const out: ReportColumn[] = [
      { ...defaultColumn(g) },
      { ...defaultColumn({ name: 'row_count', type: 'bigint', numeric: true }), label: inp.t('rep.tpl.count'), total: 'sum', format: 'number', decimals: 0 },
    ];
    measured.forEach((m, i) => {
      const s = alias('sum', m.name);
      parts.push(`SUM(${q(m.name)}) AS ${q(s)}`);
      out.push({ ...defaultColumn({ name: s, type: 'numeric', numeric: true }), label: inp.t('rep.tpl.sumOf', { col: m.name }), total: 'sum' });
      if (i === 0) {
        const a = alias('avg', m.name);
        // SQL Server tamsayı ortalamasını tamsayıya yuvarlar
        parts.push(`AVG(${d === 'mssql' ? `${q(m.name)} * 1.0` : q(m.name)}) AS ${q(a)}`);
        out.push({ ...defaultColumn({ name: a, type: 'numeric', numeric: true }), label: inp.t('rep.tpl.avgOf', { col: m.name }), total: 'avg', decimals: 2 });
      }
    });
    const order = measured.length ? q(alias('sum', measured[0].name)) : q('row_count');
    return {
      ...base,
      sql: `SELECT ${parts.join(',\n       ')}\nFROM ${from}\nGROUP BY ${q(g.name)}\nORDER BY ${order} DESC`,
      layout: 'summary',
      columns: out,
    };
  }

  // Kartlar / etiketler: başlık + birkaç satır bilgi
  const title = texts[0] ?? cols[0];
  const rest = cols.filter((c) => c.name !== title.name && !isId(c.name)).slice(0, 5);
  const sel = [title, ...rest];
  return {
    ...base,
    sql: `SELECT ${sel.map((c) => q(c.name)).join(', ')}\nFROM ${from}\nORDER BY ${q(title.name)}`,
    layout: 'cards',
    cardTitle: title.name,
    columns: withCols(sel),
  };
}
