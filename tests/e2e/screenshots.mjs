// Tanıtım sitesi (sqlmaster.app) için uygulamanın içinden ekran görüntüleri: docs/screenshots[/en]/*.png + manifest.json.
// İki set: Türkçe (varsayılan) ve İngilizce (SQLM_SHOT_LANG=en). Dosya adları ve sıra iki sette aynıdır.
// Örnek veri — tr: "magaza" PostgreSQL veritabanı (satis şeması), /veri/satislar.csv + magazalar.json;
//              en: "store" veritabanı (sales şeması), /data-en/sales.csv + stores.json. Hazırlık: scripts/shot-data.sh
// Kullanım: xvfb-run -a -s "-screen 0 1700x1100x24" node tests/e2e/screenshots.mjs
//   (PG: SQLM_SHOT_PG=host:port:user:pass, varsayılan 127.0.0.1:55432:postgres:secret)
import { _electron as electron } from 'playwright-core';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const LANG = process.env.SQLM_SHOT_LANG === 'en' ? 'en' : 'tr';
const out = path.join(root, 'docs', 'screenshots', ...(LANG === 'en' ? ['en'] : []));
fs.mkdirSync(out, { recursive: true });
const [host, port, user, pass] = (process.env.SQLM_SHOT_PG || '127.0.0.1:55432:postgres:secret').split(':');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlm-shots-'));
const W = 1600, H = 1000;

// Arayüz metinleri uygulamanın kendi çeviri dosyalarından (seçiciler dilden bağımsız kalsın)
const bundled = await build({ entryPoints: [path.join(root, 'src/shared/i18n.ts')], bundle: true, format: 'esm', write: false, platform: 'node' });
const { STRINGS } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const T = (k) => STRINGS[LANG][k] ?? STRINGS.en[k];

// Dile göre örnek veri ve açıklamalar
const L = {
  tr: {
    db: 'magaza', schema: 'satis', files: '/veri', domain: 'ornek.local', email: 'demo@ornek.com',
    folders: ['Üretim', 'Raporlama'],
    cards: ['ERP (SQL Server)', 'E-ticaret (MySQL)', 'Envanter (SQLite)', 'Satış dosyaları (DuckDB)', 'CRM (PostgreSQL)', 'Rapor ambarı (MariaDB)'],
    sqliteFile: 'C:\\Veriler\\envanter.db', users: ['rapor', 'okuyucu', 'analist', 'bi'], dbs: ['ERP', 'eticaret', 'crm', 'ambar'],
    newConn: 'Mağaza (PostgreSQL)', newConnShort: 'Mağaza', duckShort: 'Satış dosyaları',
    customers: 'musteriler', orders: 'siparisler', products: 'urunler', func: 'musteri_cirosu',
    hideCol: 'urun_id', afterHide: /SELECT id, musteri_id, adet/, sortCol: 'tutar', filterCol: 'durum', filterVal: 'Kargoda',
    qbCols: ['sehir', 'kategori', 'tutar'], qbAlias: 'ciro',
    sql: `-- Aylık ciro ve en çok satan ürünler
SELECT ay, siparis, ciro
FROM satis.aylik_ciro;

SELECT u.ad AS urun, u.kategori, sum(s.adet) AS adet, sum(s.tutar) AS ciro
FROM satis.siparisler s
JOIN satis.urunler u ON u.id = s.urun_id
WHERE s.durum <> 'İade'
GROUP BY u.ad, u.kategori
ORDER BY ciro DESC;`,
    update: "UPDATE satis.siparisler\nSET durum = 'Teslim edildi'\nWHERE durum = 'Kargoda';",
    duck: `-- CSV ve JSON dosyalarını tek sorguda birleştirin
SELECT m.bolge, m.il, s.urun,
       count(*) AS fatura, round(sum(s.tutar), 2) AS ciro
FROM 'satislar.csv' s
JOIN read_json_auto('magazalar.json') m USING (magaza_kodu)
GROUP BY ALL
ORDER BY ciro DESC;`,
    cap: {
      '01': ['Bağlantı kartları', 'Tüm veritabanlarınız kartlar halinde; klasörlere sürükleyip düzenleyin'],
      '02': ['Bağlantı kartları (gündüz)', 'Gece, gündüz ya da sistem teması — tek tıkla'],
      '03': ['Bağlantı formu', 'Bağlantıyı deneyin: sürüm, TLS durumu ve kullanıcı anında görünür'],
      '04': ['Şema gezgini ve tablo verisi', 'Kolon gizle, sırala, filtrele — veriyi çeken SQL anında güncellenir'],
      '05': ['Şema gezgini ve tablo verisi (gündüz)', 'Tablolar, görünümler, fonksiyonlar, trigger’lar: ihtiyaç anında yüklenir'],
      '06': ['SQL editörü', 'Ctrl+Enter ile çalıştırın; çoklu sonuç, otomatik tamamlama, iptal'],
      '07': ['SQL editörü (gündüz)', 'Sözdizimi renklendirme ve tablo/kolon tamamlama'],
      '08': ['Görsel sorgu oluşturucu', 'Tabloları sürükleyin, JOIN’leri çizin; SQL canlı oluşur ve çalışır'],
      '09': ['Kod ve DDL görüntüleyici', 'Fonksiyon, prosedür, trigger ve görünüm tanımları renkli editörde'],
      '10': ['CSV, Parquet, JSON ve Excel', 'DuckDB ile dosyaları içe aktarmadan doğrudan SQL ile sorgulayın'],
      '11': ['Ayarlar', '8 dil, tema, başlangıç, Mastertool hesabı ve şifreli senkron'],
      '12': ['Salt okunur mod', 'Veriyi değiştiren komutlar çalışmadan önce onayınızı ister'],
    },
  },
  en: {
    db: 'store', schema: 'sales', files: '/data-en', domain: 'example.local', email: 'demo@example.com',
    folders: ['Production', 'Reporting'],
    cards: ['ERP (SQL Server)', 'E-commerce (MySQL)', 'Inventory (SQLite)', 'Sales files (DuckDB)', 'CRM (PostgreSQL)', 'Reporting warehouse (MariaDB)'],
    sqliteFile: 'C:\\Data\\inventory.db', users: ['reporting', 'reader', 'analyst', 'bi'], dbs: ['ERP', 'shop', 'crm', 'warehouse'],
    newConn: 'Store (PostgreSQL)', newConnShort: 'Store', duckShort: 'Sales files',
    customers: 'customers', orders: 'orders', products: 'products', func: 'customer_revenue',
    hideCol: 'product_id', afterHide: /SELECT id, customer_id, qty/, sortCol: 'amount', filterCol: 'status', filterVal: 'Shipped',
    qbCols: ['city', 'category', 'amount'], qbAlias: 'revenue',
    sql: `-- Monthly revenue and best-selling products
SELECT month, orders, revenue
FROM sales.monthly_revenue;

SELECT p.name AS product, p.category, sum(o.qty) AS qty, sum(o.amount) AS revenue
FROM sales.orders o
JOIN sales.products p ON p.id = o.product_id
WHERE o.status <> 'Returned'
GROUP BY p.name, p.category
ORDER BY revenue DESC;`,
    update: "UPDATE sales.orders\nSET status = 'Delivered'\nWHERE status = 'Shipped';",
    duck: `-- Join CSV and JSON files in a single query
SELECT st.region, st.city, s.product,
       count(*) AS invoices, round(sum(s.amount), 2) AS revenue
FROM 'sales.csv' s
JOIN read_json_auto('stores.json') st USING (store_code)
GROUP BY ALL
ORDER BY revenue DESC;`,
    cap: {
      '01': ['Connection cards', 'All your databases as cards; drag them into folders to organize'],
      '02': ['Connection cards (light)', 'Dark, light or system theme — one click away'],
      '03': ['Connection form', 'Test the connection: server version, TLS status and user at a glance'],
      '04': ['Schema explorer and table data', 'Hide, sort and filter columns — the SQL behind the grid updates live'],
      '05': ['Schema explorer and table data (light)', 'Tables, views, functions, triggers: loaded on demand'],
      '06': ['SQL editor', 'Run with Ctrl+Enter; multiple result sets, autocomplete, cancel'],
      '07': ['SQL editor (light)', 'Syntax highlighting with table and column completion'],
      '08': ['Visual query builder', 'Drag tables in, draw joins; SQL is generated live and runs'],
      '09': ['Code and DDL viewer', 'Functions, procedures, triggers and view definitions, highlighted'],
      '10': ['CSV, Parquet, JSON and Excel', 'Query files directly with SQL via DuckDB — no import step'],
      '11': ['Settings', '8 languages, theme, startup, Mastertool account and encrypted sync'],
      '12': ['Read-only mode', 'Statements that change data ask for your confirmation first'],
    },
  },
}[LANG];
const db = L.db, sc = L.schema, filesDir = L.files;

// Gösterim amaçlı ek bağlantı kartları (bağlanılmaz; adresler örnek alan adları)
const now = Date.now();
const base = { port: null, database: '', user: '', filePath: '', sslMode: 'prefer', readOnly: true, savePassword: true, comments: '', createdAt: now,
  ssh: { enabled: false, host: '', port: 22, user: '', auth: 'key', keyPath: '', hostKey: null } };
const [erp, web, env, duck, crm, bi] = L.cards;
const [uRep, uRead, uAn, uBi] = L.users;
const [dErp, dWeb, dCrm, dBi] = L.dbs;
fs.writeFileSync(path.join(userData, 'store.json'), JSON.stringify({
  folders: [{ id: 'f-uretim', name: L.folders[0], parentId: null }, { id: 'f-rapor', name: L.folders[1], parentId: null }],
  connections: [
    { ...base, id: 'c-erp', name: erp, provider: 'mssql', host: `erp-sql.${L.domain}`, database: dErp, user: uRep, color: '#ef4444', folderId: null },
    { ...base, id: 'c-web', name: web, provider: 'mysql', host: `web-db.${L.domain}`, database: dWeb, user: uRead, color: '#f97316', folderId: null, ssh: { ...base.ssh, enabled: true, host: `bastion.${L.domain}`, user: 'deploy' } },
    { ...base, id: 'c-env', name: env, provider: 'sqlite', host: '', filePath: L.sqliteFile, color: '#22d3ee', folderId: null },
    { ...base, id: 'c-duck', name: duck, provider: 'duckdb', host: '', filePath: '', color: '#fbbf24', folderId: null, readOnly: false },
    { ...base, id: 'c-crm', name: crm, provider: 'postgres', host: `crm-db.${L.domain}`, database: dCrm, user: uAn, color: '#a855f7', folderId: 'f-uretim' },
    { ...base, id: 'c-bi', name: bi, provider: 'mysql', host: `bi.${L.domain}`, database: dBi, user: uBi, color: '#34d399', folderId: 'f-rapor' },
  ],
  settings: { appTheme: 'system', language: LANG, rowLimit: 10000, previewRows: 100, editorFontSize: 13, treeWidth: 300, openAtLogin: false, minimizeToTray: true, closeToTray: false },
  syncMeta: {},
}, null, 2));

const manifest = [];
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({
  executablePath: electronPath,
  args: [path.join(root, 'dist-app', 'main', 'main.js'), '--no-sandbox', `--lang=${LANG}`],
  env: { ...process.env, SQLM_DEV_ACCOUNT: '1', SQLM_USER_DATA: userData },
  cwd: filesDir,
  colorScheme: 'dark',
});
app.on('window', (w) => w.setDefaultTimeout(25000));

async function shot(page, file, theme) {
  const [title, caption] = L.cap[file.slice(0, 2)];
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
  await login.fill('#email', L.email);
  await login.fill('#password', 'demo');
  const mainP = app.waitForEvent('window');
  await login.click('#submit');
  const main = await mainP;
  await main.setViewportSize({ width: W, height: H });
  await main.waitForSelector('.conn-card');

  // PostgreSQL bağlantısını formdan ekle (parola yalnız bu oturumun belleğinde)
  await main.click('#btnNewConn');
  await main.waitForSelector('#f-host');
  await main.fill('#f-name', L.newConn);
  await main.fill('#f-host', host === '127.0.0.1' ? 'localhost' : host);
  await main.fill('#f-port', port);
  await main.fill('#f-user', user);
  await main.fill('#f-pass', pass);
  await main.fill('#f-db', db);
  await main.selectOption('#f-folder', 'f-uretim');
  await main.click(`.modal footer .btn:has-text("${T('form.test')}")`);
  await main.waitForSelector('.test-result.ok', { timeout: 20000 });
  await shot(main, '03-baglanti-formu-gece.png', 'dark');
  await main.click('.modal .btn.primary');
  await main.waitForTimeout(600);
  await main.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await shot(main, '01-ana-ekran-gece.png', 'dark');
  await shot(main, '02-ana-ekran-gunduz.png', 'light');
  await main.emulateMedia({ colorScheme: 'dark' });

  // Bağlantı penceresi (Üretim klasöründeki kart)
  await main.dblclick(`.folder-card:has-text("${L.folders[0]}")`);
  const cwP = app.waitForEvent('window');
  await main.dblclick(`.conn-card:has-text("${L.newConnShort}")`);
  const cw = await cwP;
  await cw.setViewportSize({ width: W, height: H });
  await cw.waitForSelector('.status-dot.on', { timeout: 30000 });
  await cw.waitForSelector(`.trow.k-schema:has-text("${sc}")`);
  // public şeması otomatik açılır; kapatıp satis şemasını aç
  const pub = '.tnode:has(> .trow.k-schema:has-text("public"))';
  if (await cw.locator(`${pub}.open`).count()) await cw.click(`${pub} > .trow .tchev`);
  const sat = `.tnode:has(> .trow.k-schema:has-text("${sc}"))`;
  await cw.click(`${sat} > .trow .tchev`);
  await cw.click(`${sat} .trow.k-folder:has-text("${T('tree.tables')}") .tchev`);
  await cw.waitForSelector(`.trow.k-table:has-text("${L.orders}")`);
  await cw.click(`${sat} .trow.k-folder:has-text("${T('tree.views')}") .tchev`);
  await cw.click(`${sat} .trow.k-folder:has-text("${T('tree.functions')}") .tchev`);

  // Tablo verisi: kolon gizle + sırala + filtre → SQL
  await cw.dblclick(`.trow.k-table:has-text("${L.orders}")`);
  await cw.waitForSelector('.data-tab:not(.hidden) .grid-row');
  await cw.click(`.data-tab:not(.hidden) .gh:has-text("${L.hideCol}")`, { button: 'right' });
  await cw.click(`.ctx button:has-text("${T('data.hideColumn')}")`);
  await cw.waitForFunction((re) => new RegExp(re).test(document.querySelector('.data-tab:not(.hidden) .sql-preview-host')?.textContent || ''), L.afterHide.source);
  await cw.click(`.data-tab:not(.hidden) .gh:has-text("${L.sortCol}") .gh-name`);
  await cw.click(`.data-tab:not(.hidden) .gh:has-text("${L.sortCol}") .gh-name`);
  await cw.waitForFunction((c) => (document.querySelector('.data-tab:not(.hidden) .sql-preview-host')?.textContent || '').includes(`ORDER BY ${c} DESC`), L.sortCol);
  await cw.click('.data-tab:not(.hidden) [data-a="filter"]');
  await cw.selectOption('#fc', L.filterCol);
  await cw.selectOption('#fo', '=');
  await cw.fill('#fv', L.filterVal);
  await cw.click('.modal .btn.primary');
  await cw.waitForFunction(([c, v]) => (document.querySelector('.data-tab:not(.hidden) .sql-preview-host')?.textContent || '').includes(`WHERE ${c} = '${v}'`), [L.filterCol, L.filterVal]);
  await cw.waitForFunction((w) => (document.querySelector('.data-tab:not(.hidden) .tb-status')?.textContent || '').includes(w), T('data.rows').split(' ')[1]);
  await shot(cw, '04-tablo-verisi-gece.png', 'dark');
  await shot(cw, '05-tablo-verisi-gunduz.png', 'light');
  await cw.emulateMedia({ colorScheme: 'dark' });

  // SQL editörü: çoklu sonuç
  await cw.click('.wtab:has-text("SQL 1")');
  await typeSql(cw, L.sql);
  await cw.keyboard.press('Control+Enter');
  await cw.waitForFunction(() => document.querySelectorAll('.sql-tab:not(.hidden) .res-tab').length >= 3);
  await cw.click('.sql-tab:not(.hidden) .res-tab:nth-child(2)');
  await cw.click('.sql-tab:not(.hidden) .cm-content');
  await cw.keyboard.press('Control+End');
  await shot(cw, '06-sql-editor-gece.png', 'dark');
  await shot(cw, '07-sql-editor-gunduz.png', 'light');
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
  await drop(L.customers, 50, 30);
  await cw.waitForFunction(() => document.querySelectorAll('.qb-table').length === 1);
  await drop(L.orders, 420, 70);
  await cw.waitForFunction(() => document.querySelectorAll('.qb-table').length === 2);
  await drop(L.products, 790, 20);
  await cw.waitForFunction(() => document.querySelectorAll('.qb-join').length >= 2);
  await cw.locator('.qb-table').nth(0).locator(`input[data-col="${L.qbCols[0]}"]`).check();
  await cw.locator('.qb-table').nth(2).locator(`input[data-col="${L.qbCols[1]}"]`).check();
  await cw.locator('.qb-table').nth(1).locator(`input[data-col="${L.qbCols[2]}"]`).check();
  const rows = cw.locator('.builder-tab:not(.hidden) .qb-grid tbody tr');
  await rows.nth(2).locator('select[data-f="aggregate"]').selectOption('SUM');
  await rows.nth(2).locator('input[data-f="alias"]').fill(L.qbAlias);
  await rows.nth(2).locator('input[data-f="alias"]').dispatchEvent('change');
  await rows.nth(2).locator('select[data-f="sort"]').selectOption('DESC');
  await cw.fill('.builder-tab:not(.hidden) [data-a="limit"]', '20');
  await cw.dispatchEvent('.builder-tab:not(.hidden) [data-a="limit"]', 'change');
  await cw.click('.builder-tab:not(.hidden) [data-a="run"]');
  await cw.waitForSelector('.builder-tab:not(.hidden) .grid-row', { timeout: 20000 });
  await cw.click('.builder-tab:not(.hidden) .res-tab[data-tab="cols"]');
  await shot(cw, '08-sorgu-olusturucu-gece.png', 'dark');

  // DDL / kod görüntüleyici
  await cw.dblclick(`.trow.k-function:has-text("${L.func}")`);
  await cw.waitForFunction(() => /CREATE OR REPLACE FUNCTION/.test(document.querySelector('.code-tab:not(.hidden) .cm-content')?.textContent || ''));
  await shot(cw, '09-ddl-goruntuleyici-gece.png', 'dark');

  // Salt okunur koruması
  await cw.click('#btnNewSql');
  await typeSql(cw, L.update);
  await cw.keyboard.press('Control+Enter');
  await cw.waitForSelector(`.modal:has-text("${T('ro.title')}")`);
  await shot(cw, '12-salt-okunur-gece.png', 'dark');
  await cw.click(`.modal .btn:has-text("${T('common.giveUp')}")`);

  // Ayarlar
  await cw.click('#btnSettings');
  await cw.waitForSelector('.set-wrap');
  await shot(cw, '11-ayarlar-gece.png', 'dark');
  await cw.keyboard.press('Escape');
  await cw.close();

  // DuckDB: dosyaları doğrudan sorgula
  await main.bringToFront();
  await main.click(`.crumb:has-text("${T('app.all')}")`);
  const dwP = app.waitForEvent('window');
  await main.dblclick(`.conn-card:has-text("${L.duckShort}")`);
  const dw = await dwP;
  await dw.setViewportSize({ width: W, height: H });
  await dw.waitForSelector('.status-dot.on', { timeout: 30000 });
  await typeSql(dw, L.duck);
  await dw.keyboard.press('Control+Enter');
  await dw.waitForSelector('.sql-tab:not(.hidden) .grid-row', { timeout: 20000 });
  await shot(dw, '10-duckdb-dosyalar-gece.png', 'dark');

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
