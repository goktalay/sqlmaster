// Tanıtım sitesi (sqlmaster.app) için uygulamanın içinden ekran görüntüleri: docs/screenshots/*.png + manifest.json.
// Örnek veri: "magaza" PostgreSQL veritabanı (satis şeması) ve DuckDB için /veri/satislar.csv, /veri/magazalar.json.
// Kullanım: xvfb-run -a -s "-screen 0 1700x1100x24" node tests/e2e/screenshots.mjs
//   (PG: SQLM_SHOT_PG=host:port:user:pass:db, varsayılan 127.0.0.1:55432:postgres:secret:magaza; DuckDB dosya klasörü: SQLM_SHOT_FILES=/veri)
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });
const [host, port, user, pass, db] = (process.env.SQLM_SHOT_PG || '127.0.0.1:55432:postgres:secret:magaza').split(':');
const filesDir = process.env.SQLM_SHOT_FILES || '/veri';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlm-shots-'));
const W = 1600, H = 1000;

// Gösterim amaçlı ek bağlantı kartları (bağlanılmaz; adresler örnek alan adları)
const now = Date.now();
const base = { port: null, database: '', user: '', filePath: '', sslMode: 'prefer', readOnly: true, savePassword: true, comments: '', createdAt: now,
  ssh: { enabled: false, host: '', port: 22, user: '', auth: 'key', keyPath: '', hostKey: null } };
fs.writeFileSync(path.join(userData, 'store.json'), JSON.stringify({
  folders: [{ id: 'f-uretim', name: 'Üretim', parentId: null }, { id: 'f-rapor', name: 'Raporlama', parentId: null }],
  connections: [
    { ...base, id: 'c-erp', name: 'ERP (SQL Server)', provider: 'mssql', host: 'erp-sql.ornek.local', database: 'ERP', user: 'rapor', color: '#ef4444', folderId: null },
    { ...base, id: 'c-web', name: 'E-ticaret (MySQL)', provider: 'mysql', host: 'web-db.ornek.local', database: 'eticaret', user: 'okuyucu', color: '#f97316', folderId: null, ssh: { ...base.ssh, enabled: true, host: 'bastion.ornek.local', user: 'deploy' } },
    { ...base, id: 'c-env', name: 'Envanter (SQLite)', provider: 'sqlite', host: '', filePath: 'C:\\Veriler\\envanter.db', color: '#22d3ee', folderId: null },
    { ...base, id: 'c-duck', name: 'Satış dosyaları (DuckDB)', provider: 'duckdb', host: '', filePath: '', color: '#fbbf24', folderId: null, readOnly: false },
    { ...base, id: 'c-crm', name: 'CRM (PostgreSQL)', provider: 'postgres', host: 'crm-db.ornek.local', database: 'crm', user: 'analist', color: '#a855f7', folderId: 'f-uretim' },
    { ...base, id: 'c-bi', name: 'Rapor ambarı (MariaDB)', provider: 'mysql', host: 'bi.ornek.local', database: 'ambar', user: 'bi', color: '#34d399', folderId: 'f-rapor' },
  ],
  settings: { appTheme: 'system', language: 'tr', rowLimit: 10000, previewRows: 100, editorFontSize: 13, treeWidth: 300, openAtLogin: false, minimizeToTray: true, closeToTray: false },
  syncMeta: {},
}, null, 2));

const manifest = [];
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({
  executablePath: electronPath,
  args: [path.join(root, 'dist-app', 'main', 'main.js'), '--no-sandbox', '--lang=tr'],
  env: { ...process.env, SQLM_DEV_ACCOUNT: '1', SQLM_USER_DATA: userData },
  cwd: filesDir,
  colorScheme: 'dark',
});
app.on('window', (w) => w.setDefaultTimeout(25000));

async function shot(page, file, theme, title, caption) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(out, file) });
  manifest.push({ file, theme, title, caption });
  console.log('»', file);
}

const typeSql = async (page, sql) => {
  await page.click('.sql-tab:not(.hidden) .cm-content');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
};

try {
  const login = await app.firstWindow();
  await login.waitForSelector('#email');
  await login.fill('#email', 'demo@ornek.com');
  await login.fill('#password', 'demo');
  const mainP = app.waitForEvent('window');
  await login.click('#submit');
  const main = await mainP;
  await main.setViewportSize({ width: W, height: H });
  await main.waitForSelector('.conn-card');

  // PostgreSQL bağlantısını formdan ekle (parola yalnız bu oturumun belleğinde)
  await main.click('#btnNewConn');
  await main.waitForSelector('#f-host');
  await main.fill('#f-name', 'Mağaza (PostgreSQL)');
  await main.fill('#f-host', host === '127.0.0.1' ? 'localhost' : host);
  await main.fill('#f-port', port);
  await main.fill('#f-user', user);
  await main.fill('#f-pass', pass);
  await main.fill('#f-db', db);
  await main.selectOption('#f-folder', 'f-uretim');
  await main.click('.modal footer .btn:has-text("Bağlantıyı dene")');
  await main.waitForSelector('.test-result.ok', { timeout: 20000 });
  await shot(main, '03-baglanti-formu-gece.png', 'dark', 'Bağlantı formu', 'Bağlantıyı deneyin: sürüm, TLS durumu ve kullanıcı anında görünür');
  await main.click('.modal .btn.primary');
  await main.waitForTimeout(600);
  await main.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await shot(main, '01-ana-ekran-gece.png', 'dark', 'Bağlantı kartları', 'Tüm veritabanlarınız kartlar halinde; klasörlere sürükleyip düzenleyin');
  await shot(main, '02-ana-ekran-gunduz.png', 'light', 'Bağlantı kartları (gündüz)', 'Gece, gündüz ya da sistem teması — tek tıkla');
  await main.emulateMedia({ colorScheme: 'dark' });

  // Bağlantı penceresi (Üretim klasöründeki kart)
  await main.dblclick('.folder-card:has-text("Üretim")');
  const cwP = app.waitForEvent('window');
  await main.dblclick('.conn-card:has-text("Mağaza")');
  const cw = await cwP;
  await cw.setViewportSize({ width: W, height: H });
  await cw.waitForSelector('.status-dot.on', { timeout: 30000 });
  await cw.waitForSelector('.trow.k-schema:has-text("satis")');
  // public şeması otomatik açılır; kapatıp satis şemasını aç
  const pub = '.tnode:has(> .trow.k-schema:has-text("public"))';
  if (await cw.locator(`${pub}.open`).count()) await cw.click(`${pub} > .trow .tchev`);
  const sat = '.tnode:has(> .trow.k-schema:has-text("satis"))';
  await cw.click(`${sat} > .trow .tchev`);
  await cw.click(`${sat} .trow.k-folder:has-text("Tablolar") .tchev`);
  await cw.waitForSelector('.trow.k-table:has-text("siparisler")');
  await cw.click(`${sat} .trow.k-folder:has-text("Görünümler") .tchev`);
  await cw.click(`${sat} .trow.k-folder:has-text("Fonksiyonlar") .tchev`);

  // Tablo verisi: kolon gizle + sırala + filtre → SQL
  await cw.dblclick('.trow.k-table:has-text("siparisler")');
  await cw.waitForSelector('.data-tab:not(.hidden) .grid-row');
  await cw.click('.data-tab:not(.hidden) .gh:has-text("urun_id")', { button: 'right' });
  await cw.click('.ctx button:has-text("Kolonu gizle")');
  await cw.waitForFunction(() => /SELECT id, musteri_id, adet/.test(document.querySelector('.data-tab:not(.hidden) .sql-preview-host')?.textContent || ''));
  await cw.click('.data-tab:not(.hidden) .gh:has-text("tutar") .gh-name');
  await cw.click('.data-tab:not(.hidden) .gh:has-text("tutar") .gh-name');
  await cw.waitForFunction(() => /ORDER BY tutar DESC/.test(document.querySelector('.data-tab:not(.hidden) .sql-preview-host')?.textContent || ''));
  await cw.click('.data-tab:not(.hidden) [data-a="filter"]');
  await cw.selectOption('#fc', 'durum');
  await cw.selectOption('#fo', '=');
  await cw.fill('#fv', 'Kargoda');
  await cw.click('.modal .btn.primary');
  await cw.waitForFunction(() => /WHERE durum = 'Kargoda'/.test(document.querySelector('.data-tab:not(.hidden) .sql-preview-host')?.textContent || ''));
  await cw.waitForFunction(() => /kayıt/.test(document.querySelector('.data-tab:not(.hidden) .tb-status')?.textContent || ''));
  await shot(cw, '04-tablo-verisi-gece.png', 'dark', 'Şema gezgini ve tablo verisi', 'Kolon gizle, sırala, filtrele — veriyi çeken SQL anında güncellenir');
  await shot(cw, '05-tablo-verisi-gunduz.png', 'light', 'Şema gezgini ve tablo verisi (gündüz)', 'Tablolar, görünümler, fonksiyonlar, trigger’lar: ihtiyaç anında yüklenir');
  await cw.emulateMedia({ colorScheme: 'dark' });

  // SQL editörü: çoklu sonuç
  await cw.click('.wtab:has-text("SQL 1")');
  await typeSql(cw, `-- Aylık ciro ve en çok satan ürünler
SELECT ay, siparis, ciro
FROM satis.aylik_ciro;

SELECT u.ad AS urun, u.kategori, sum(s.adet) AS adet, sum(s.tutar) AS ciro
FROM satis.siparisler s
JOIN satis.urunler u ON u.id = s.urun_id
WHERE s.durum <> 'İade'
GROUP BY u.ad, u.kategori
ORDER BY ciro DESC;`);
  await cw.keyboard.press('Control+Enter');
  await cw.waitForFunction(() => document.querySelectorAll('.sql-tab:not(.hidden) .res-tab').length >= 3);
  await cw.click('.sql-tab:not(.hidden) .res-tab:nth-child(2)');
  await cw.click('.sql-tab:not(.hidden) .cm-content');
  await cw.keyboard.press('Control+End');
  await shot(cw, '06-sql-editor-gece.png', 'dark', 'SQL editörü', 'Ctrl+Enter ile çalıştırın; çoklu sonuç, otomatik tamamlama, iptal');
  await shot(cw, '07-sql-editor-gunduz.png', 'light', 'SQL editörü (gündüz)', 'Sözdizimi renklendirme ve tablo/kolon tamamlama');
  await cw.emulateMedia({ colorScheme: 'dark' });

  // Görsel sorgu oluşturucu
  await cw.click('#btnBuilder');
  await cw.waitForSelector('.builder-tab:not(.hidden) .qb-canvas-wrap');
  const drop = async (name, x, y) => {
    const src = await cw.$(`.trow.k-table:has-text("${name}")`);
    const dst = await cw.$('.builder-tab:not(.hidden) .qb-canvas-wrap');
    const box = await dst.boundingBox();
    const dt = await cw.evaluateHandle(() => new DataTransfer());
    await src.dispatchEvent('dragstart', { dataTransfer: dt });
    await dst.dispatchEvent('drop', { dataTransfer: dt, clientX: box.x + x, clientY: box.y + y });
  };
  await drop('musteriler', 50, 30);
  await cw.waitForFunction(() => document.querySelectorAll('.qb-table').length === 1);
  await drop('siparisler', 420, 70);
  await cw.waitForFunction(() => document.querySelectorAll('.qb-table').length === 2);
  await drop('urunler', 790, 20);
  await cw.waitForFunction(() => document.querySelectorAll('.qb-join').length >= 2);
  await cw.locator('.qb-table').nth(0).locator('input[data-col="sehir"]').check();
  await cw.locator('.qb-table').nth(2).locator('input[data-col="kategori"]').check();
  await cw.locator('.qb-table').nth(1).locator('input[data-col="tutar"]').check();
  const rows = cw.locator('.builder-tab:not(.hidden) .qb-grid tbody tr');
  await rows.nth(2).locator('select[data-f="aggregate"]').selectOption('SUM');
  await rows.nth(2).locator('input[data-f="alias"]').fill('ciro');
  await rows.nth(2).locator('input[data-f="alias"]').dispatchEvent('change');
  await rows.nth(2).locator('select[data-f="sort"]').selectOption('DESC');
  await cw.fill('.builder-tab:not(.hidden) [data-a="limit"]', '20');
  await cw.dispatchEvent('.builder-tab:not(.hidden) [data-a="limit"]', 'change');
  await cw.click('.builder-tab:not(.hidden) [data-a="run"]');
  await cw.waitForSelector('.builder-tab:not(.hidden) .grid-row', { timeout: 20000 });
  await cw.click('.builder-tab:not(.hidden) .res-tab[data-tab="cols"]');
  await shot(cw, '08-sorgu-olusturucu-gece.png', 'dark', 'Görsel sorgu oluşturucu', 'Tabloları sürükleyin, JOIN’leri çizin; SQL canlı oluşur ve çalışır');

  // DDL / kod görüntüleyici
  await cw.dblclick('.trow.k-function:has-text("musteri_cirosu")');
  await cw.waitForFunction(() => /CREATE OR REPLACE FUNCTION/.test(document.querySelector('.code-tab:not(.hidden) .cm-content')?.textContent || ''));
  await shot(cw, '09-ddl-goruntuleyici-gece.png', 'dark', 'Kod ve DDL görüntüleyici', 'Fonksiyon, prosedür, trigger ve görünüm tanımları renkli editörde');

  // Salt okunur koruması
  await cw.click('#btnNewSql');
  await typeSql(cw, "UPDATE satis.siparisler\nSET durum = 'Teslim edildi'\nWHERE durum = 'Kargoda';");
  await cw.keyboard.press('Control+Enter');
  await cw.waitForSelector('.modal:has-text("Salt okunur kip")');
  await shot(cw, '12-salt-okunur-gece.png', 'dark', 'Salt okunur mod', 'Veriyi değiştiren komutlar çalışmadan önce onayınızı ister');
  await cw.click('.modal .btn:has-text("Vazgeç")');

  // Ayarlar
  await cw.click('#btnSettings');
  await cw.waitForSelector('.set-wrap');
  await shot(cw, '11-ayarlar-gece.png', 'dark', 'Ayarlar', '8 dil, tema, başlangıç, Mastertool hesabı ve şifreli senkron');
  await cw.keyboard.press('Escape');
  await cw.close();

  // DuckDB: dosyaları doğrudan sorgula
  await main.bringToFront();
  await main.click('.crumb:has-text("Tüm bağlantılar")');
  const dwP = app.waitForEvent('window');
  await main.dblclick('.conn-card:has-text("Satış dosyaları")');
  const dw = await dwP;
  await dw.setViewportSize({ width: W, height: H });
  await dw.waitForSelector('.status-dot.on', { timeout: 30000 });
  await typeSql(dw, `-- CSV ve JSON dosyalarını tek sorguda birleştirin
SELECT m.bolge, m.il, s.urun,
       count(*) AS fatura, round(sum(s.tutar), 2) AS ciro
FROM 'satislar.csv' s
JOIN read_json_auto('magazalar.json') m USING (magaza_kodu)
GROUP BY ALL
ORDER BY ciro DESC;`);
  await dw.keyboard.press('Control+Enter');
  await dw.waitForSelector('.sql-tab:not(.hidden) .grid-row', { timeout: 20000 });
  await shot(dw, '10-duckdb-dosyalar-gece.png', 'dark', 'CSV, Parquet, JSON ve Excel', 'DuckDB ile dosyaları içe aktarmadan doğrudan SQL ile sorgulayın');

  manifest.sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n${manifest.length} ekran görüntüsü:`, out);
} catch (e) {
  for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(os.tmpdir(), `shot-hata-${i}.png`) }).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
