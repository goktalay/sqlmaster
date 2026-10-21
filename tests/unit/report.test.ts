// Baskı raporları: şablon sorguları (lehçeye göre), kolon eşleştirme, doğrulama ve HTML üretimi.
import { describe, expect, it } from 'vitest';
import { buildTemplate } from '../../src/core/report/templates';
import { emptyReport, normalizeReport, reconcileColumns, type ReportDef } from '../../src/core/report/model';
import { computeTotal, formatCell, renderReport, type RenderOptions } from '../../src/core/report/render';
import type { ColumnMeta } from '../../src/core/provider';

const COLS: ColumnMeta[] = [
  { name: 'id', type: 'integer', numeric: true },
  { name: 'musteri_id', type: 'integer', numeric: true },
  { name: 'adet', type: 'integer', numeric: true },
  { name: 'tutar', type: 'numeric(12,2)', numeric: true },
  { name: 'durum', type: 'text' },
  { name: 'siparis_tarihi', type: 'timestamp with time zone' },
];
const t = (k: string, v?: Record<string, string | number>) => `${k}${v?.col ? ':' + v.col : ''}`;
const table = { schema: 'satis', name: 'siparisler' };

const OPTS: RenderOptions = {
  locale: 'tr', now: new Date('2026-10-21T09:30:00Z'),
  strings: { page: 'Sayfa {p} / {n}', printed: 'Basım:', total: 'Genel toplam', subtotal: 'Ara toplam', rows: '{n} kayıt', truncated: 'İlk {n} satır', empty: 'Kayıt yok', count: 'Kayıt sayısı' },
};

function report(patch: Partial<ReportDef>): ReportDef {
  return { ...emptyReport({ id: 'r1', connectionId: 'c1', name: 'Siparişler', now: 1 }), ...patch };
}

describe('rapor şablonları', () => {
  it('gruplu döküm: durum kolonuna göre gruplar, tutarları toplar', () => {
    const r = buildTemplate('grouped', { dialect: 'postgres', table, columns: COLS, t });
    expect(r.layout).toBe('grouped');
    expect(r.groupBy).toBe('durum');
    expect(r.sql).toBe('SELECT durum, id, musteri_id, adet, tutar, siparis_tarihi\nFROM satis.siparisler\nORDER BY durum, siparis_tarihi');
    expect(r.columns.find((c) => c.name === 'tutar')!.total).toBe('sum');
    expect(r.columns.find((c) => c.name === 'musteri_id')!.total).toBe('none'); // kimlik kolonu toplanmaz
    expect(r.columns.find((c) => c.name === 'siparis_tarihi')!.format).toBe('datetime');
  });

  it('özet: GROUP BY + sayım/toplam/ortalama; SQL Server tamsayı ortalamasını ondalıklı alır', () => {
    const pg = buildTemplate('summary', { dialect: 'postgres', table, columns: COLS, t });
    expect(pg.sql).toBe('SELECT durum,\n       COUNT(*) AS row_count,\n       SUM(adet) AS sum_adet,\n       AVG(adet) AS avg_adet,\n       SUM(tutar) AS sum_tutar\nFROM satis.siparisler\nGROUP BY durum\nORDER BY sum_adet DESC');
    expect(pg.columns.map((c) => [c.name, c.label, c.total])).toEqual([
      ['durum', 'durum', 'none'], ['row_count', 'rep.tpl.count', 'sum'], ['sum_adet', 'rep.tpl.sumOf:adet', 'sum'],
      ['avg_adet', 'rep.tpl.avgOf:adet', 'avg'], ['sum_tutar', 'rep.tpl.sumOf:tutar', 'sum'],
    ]);
    const ms = buildTemplate('summary', { dialect: 'mssql', table: { database: 'Magaza', schema: 'satis', name: 'siparisler' }, columns: COLS, t });
    expect(ms.sql).toContain('AVG(adet * 1.0) AS avg_adet');
    expect(ms.sql).toContain('FROM Magaza.satis.siparisler');
  });

  it('metin kolonu yoksa gruplu/özet yerine liste üretir; tırnak gerektiren adları tırnaklar', () => {
    const cols: ColumnMeta[] = [{ name: 'Kod', type: 'int', numeric: true }, { name: 'Tutar Toplam', type: 'decimal', numeric: true }];
    const r = buildTemplate('grouped', { dialect: 'mysql', table: { database: 'shop', name: 'order' }, columns: cols, t });
    expect(r.layout).toBe('table');
    expect(r.sql).toBe('SELECT Kod, `Tutar Toplam`\nFROM shop.`order`\nORDER BY Kod');
  });

  it('kart düzeni başlık kolonunu seçer; boş şablon SELECT * üretir', () => {
    const c = buildTemplate('cards', { dialect: 'sqlite', table: { name: 'musteriler' }, columns: [{ name: 'id', type: 'INTEGER' }, { name: 'ad', type: 'TEXT' }, { name: 'sehir', type: 'TEXT' }], t });
    expect(c.layout).toBe('cards');
    expect(c.cardTitle).toBe('ad');
    expect(buildTemplate('blank', { dialect: 'postgres', table, columns: COLS, t }).sql).toBe('SELECT *\nFROM satis.siparisler');
    expect(buildTemplate('blank', { dialect: 'postgres', table: null, columns: [], t }).sql).toBe('');
  });
});

describe('rapor modeli', () => {
  it('kolonları sorguyla eşleştirir: ayarlar ve sıra korunur, yeniler eklenir, gidenler düşer', () => {
    const before = reconcileColumns([], COLS.slice(0, 3));
    before[2] = { ...before[2], label: 'Adet', total: 'sum' };
    const after = reconcileColumns([before[2], before[0], before[1]], [COLS[0], COLS[2], COLS[4]]);
    expect(after.map((c) => c.name)).toEqual(['adet', 'id', 'durum']);
    expect(after[0]).toMatchObject({ label: 'Adet', total: 'sum', numeric: true });
  });

  it('pencereden gelen tanımı doğrular ve sınırlar', () => {
    const n = normalizeReport({ id: 'x', connectionId: 'c', name: '  ', layout: 'piechart' as never, page: { size: 'B5' as never, orientation: 'landscape', margin: 999 }, currency: 'try', columns: [{ name: 'a', total: 'median' } as never, { name: '' } as never] }, 5);
    expect(n).toMatchObject({ name: 'Rapor', layout: 'table', page: { size: 'A4', orientation: 'landscape', margin: 50 }, currency: 'TRY', updatedAt: 5 });
    expect(n.columns).toEqual([{ name: 'a', label: 'a', visible: true, align: 'auto', format: 'auto', decimals: null, total: 'none', numeric: false }]);
  });
});

describe('rapor HTML', () => {
  const data = {
    columns: COLS.slice(2, 5),
    rows: [[2, '100.50', 'Kargoda'], [1, '20', 'Kargoda'], [5, '1000', 'Yeni'], [1, null, '<script>x</script>']],
    truncated: false,
  };

  it('biçimler ve toplamlar', () => {
    const col = { name: 'x', label: 'x', visible: true, align: 'auto' as const, format: 'money' as const, decimals: null, total: 'sum' as const, numeric: true };
    expect(formatCell('1234.5', col, 'tr', 'TRY')).toBe('₺1.234,50');
    expect(formatCell(12.5, { ...col, format: 'percent' }, 'en', 'TRY')).toBe('12.5%');
    expect(formatCell('2026-04-17', { ...col, format: 'date' }, 'tr', 'TRY')).toBe('17.04.2026');
    expect(formatCell('2026-04-17 00:39:00+00', { ...col, format: 'datetime' }, 'en-GB', 'TRY')).toMatch(/^17\/04\/2026, \d\d:39$/);
    expect(formatCell(1234567, { ...col, format: 'auto' }, 'tr', 'TRY')).toBe('1.234.567');
    expect(computeTotal('sum', ['1.5', 2, null, 'x'])).toBe(3.5);
    expect(computeTotal('avg', [1, 2, 3])).toBe(2);
    expect(computeTotal('count', [1, null, '', 'a'])).toBe(2);
    expect(computeTotal('max', [null])).toBeNull();
  });

  it('gruplu düzen: grup başlıkları, ara toplamlar, genel toplam; içerik kaçışlı', () => {
    const def = report({ layout: 'grouped', groupBy: 'durum', title: 'Sipariş dökümü', footer: 'Gizli', columns: reconcileColumns([], data.columns).map((c) => (c.name === 'tutar' ? { ...c, total: 'sum', format: 'number', decimals: 2 } : c)) });
    const html = renderReport(def, data, OPTS);
    expect(html).toContain('<h1>Sipariş dökümü</h1>');
    expect(html.match(/class="gh"/g)).toHaveLength(3); // Kargoda, Yeni, <script>
    expect(html).toContain('durum: <b>Kargoda</b><span class="gc">2 kayıt</span>');
    expect(html).toContain('<td class="lbl">Ara toplam</td><td class="a-right">120,50</td>');
    expect(html).toContain('<td class="lbl">Genel toplam</td><td class="a-right">1.120,50</td>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('@page { size: A4 portrait; margin: 15mm;');
    expect(html).toContain('content: "Sayfa " counter(page) " / " counter(pages) ""');
    expect(html).toContain('@bottom-left { content: "Gizli"');
    expect(html).toContain('Basım: 21.10.2026');
  });

  it('özet kutuları, kartlar, boş sonuç ve satır sınırı uyarısı', () => {
    const cols = reconcileColumns([], data.columns).map((c) => (c.name === 'adet' ? { ...c, total: 'sum' as const } : c));
    const sum = renderReport(report({ layout: 'summary', columns: cols }), { ...data, truncated: true }, OPTS);
    expect(sum).toContain('<div class="kpi"><span>Kayıt sayısı</span><b>4</b></div>');
    expect(sum).toContain('<div class="kpi"><span>adet</span><b>9</b></div>');
    expect(sum).toContain('İlk 4 satır');
    const cards = renderReport(report({ layout: 'cards', cardTitle: 'durum', columns: cols, page: { size: 'A5', orientation: 'landscape', margin: 10 } }), data, OPTS);
    expect(cards.match(/class="card"/g)).toHaveLength(4);
    expect(cards).toContain('repeat(3, 1fr)');
    expect(cards).toContain('size: A5 landscape');
    expect(renderReport(report({ columns: cols }), { ...data, rows: [] }, OPTS)).toContain('<p class="empty">Kayıt yok</p>');
  });
});
