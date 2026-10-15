// Uçtan uca duman testi: gerçek Electron uygulamasını (geliştirme hesabıyla) açar, PostgreSQL'e bağlanır,
// tablo açar, kolon gizleyip SQL'in güncellendiğini doğrular, sorgu oluşturucuyu dener ve ekran görüntüleri alır.
// Kullanım: xvfb-run -a node tests/e2e/smoke.mjs  (PG: SQLM_E2E_PG=host:port:user:pass:db)
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const shots = process.env.SQLM_SHOTS || path.join(root, 'e2e-shots');
fs.mkdirSync(shots, { recursive: true });
const [host, port, user, pass, db] = (process.env.SQLM_E2E_PG || '127.0.0.1:55432:postgres:secret:shop').split(':');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlm-e2e-'));
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

// Electron ikilisi ilk kullanımda indirilir (npm postinstall yok): yoksa indir
if (!fs.existsSync(electronPath)) execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); console.log('  ✓ ' + msg); };

const app = await electron.launch({
  executablePath: electronPath,
  args: [path.join(root, 'dist-app', 'main', 'main.js'), '--no-sandbox'],
  colorScheme: 'dark',
  env: { ...process.env, SQLM_DEV_ACCOUNT: '1', SQLM_USER_DATA: userData, LANG: 'tr_TR.UTF-8' },
});
app.process().stdout.on('data', (d) => { if (String(d).includes('[trace]')) process.stdout.write(String(d)); });
const shot = (page, name) => { console.log('» ' + name); return page.screenshot({ path: path.join(shots, `${name}.png`) }); };
app.on('window', (w) => { w.setDefaultTimeout(20000); w.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text()); }); w.on('pageerror', (e) => console.log('[pageerror]', e.message)); });

try {
  // --- Giriş
  const login = await app.firstWindow();
  login.setDefaultTimeout(20000);
  await login.waitForSelector('#email');
  await shot(login, '01-giris');
  await login.fill('#email', 'muhammed@ornek.com');
  await login.fill('#password', 'x');
  const mainP = app.waitForEvent('window', { timeout: 20000 });
  await login.click('#submit');
  const main = await mainP;
  await main.waitForSelector('.new-card');
  await main.setViewportSize({ width: 1180, height: 720 });
  assert(await main.isVisible('.welcome .new-card'), 'ana ekranda "Bağlantı ekle" kartı var');
  await shot(main, '02-ana-ekran-bos');

  // --- Bağlantı formu
  await main.click('.welcome .new-card');
  await main.waitForSelector('#f-host');
  await main.fill('#f-name', 'Demo mağaza (PG)');
  await main.fill('#f-host', host);
  await main.fill('#f-port', port);
  await main.fill('#f-user', user);
  await main.fill('#f-pass', pass);
  await main.fill('#f-db', db);
  await main.click('.modal footer .btn:has-text("Bağlantıyı dene")');
  await main.waitForSelector('.test-result.ok, .test-result.err', { timeout: 20000 });
  await shot(main, '03-baglanti-formu');
  assert(await main.isVisible('.test-result.ok'), 'bağlantı testi başarılı');
  await main.click('.modal .btn.primary');
  await main.waitForSelector('.conn-card');
  await main.click('#btnNewFolder');
  await main.fill('#pv', 'Üretim');
  await main.click('.modal .btn.primary');
  await main.waitForSelector('.folder-card');
  await shot(main, '04-ana-ekran-kartlar');

  // --- Bağlantı penceresi (çift tıklama)
  const cwP = app.waitForEvent('window', { timeout: 20000 });
  await main.dblclick('.conn-card');
  const cw = await cwP;
  await cw.setViewportSize({ width: 1400, height: 860 });
  await cw.waitForSelector('.trow.k-folder', { timeout: 30000 });
  await cw.waitForSelector('.status-dot.on');
  assert(true, 'bağlantı penceresi açıldı ve bağlandı');
  // Tablolar klasörünü aç
  await cw.click('.trow.k-folder:has-text("Tablolar") .tchev');
  await cw.waitForSelector('.trow.k-table:has-text("customers")');
  await shot(cw, '05-baglanti-penceresi');

  // --- Tablo çift tıklama → ilk 100 kayıt
  await cw.dblclick('.trow.k-table:has-text("customers")');
  await cw.waitForSelector('.data-tab:not(.hidden) .grid-row');
  await cw.waitForFunction(() => /kayıt/.test(document.querySelector('.data-tab:not(.hidden) .tb-status')?.textContent || ''));
  const sql1 = await cw.textContent('.data-tab:not(.hidden) .sql-preview-host .cm-content');
  assert(sql1.includes('SELECT *') && sql1.includes('FROM public.customers') && sql1.includes('LIMIT 100'), `ilk SQL: ${sql1}`);
  const rows = await cw.$$eval('.data-tab:not(.hidden) .grid-row', (r) => r.length);
  assert(rows > 10, `ızgarada satırlar çizildi (${rows} görünür satır)`);
  await shot(cw, '06-tablo-verisi');

  // --- Kolon gizle → SELECT listesi değişir
  await cw.click('.data-tab:not(.hidden) .gh:has-text("email")', { button: 'right' });
  await cw.click('.ctx button:has-text("Kolonu gizle")');
  await cw.waitForFunction(() => /SELECT id, name, country, created/.test(document.querySelector('.data-tab:not(.hidden) .sql-preview-host .cm-content')?.textContent || ''));
  assert(true, 'kolon gizlenince SELECT listesi güncellendi');
  // Sıralama: başlığa tıkla → ORDER BY
  await cw.click('.data-tab:not(.hidden) .gh:has-text("name") .gh-name');
  await cw.waitForFunction(() => /ORDER BY name/.test(document.querySelector('.data-tab:not(.hidden) .sql-preview-host .cm-content')?.textContent || ''));
  assert(true, 'başlık tıklaması ORDER BY ekledi');
  // Hücreden filtre: = değer
  await cw.click('.data-tab:not(.hidden) .grid-row .gc[data-c="2"]', { button: 'right' });
  await cw.click('.ctx button:has-text("= “")');
  await cw.waitForFunction(() => /WHERE country = /.test(document.querySelector('.data-tab:not(.hidden) .sql-preview-host .cm-content')?.textContent || ''));
  assert(true, 'hücre menüsünden filtre WHERE ekledi');
  await cw.waitForTimeout(400);
  await shot(cw, '07-gizle-sirala-filtre');

  // --- View DDL (kod editörü)
  await cw.click('.trow.k-folder:has-text("Görünümler") .tchev');
  // görünüm çift tıklamada veri açar; tanımı bağlam menüsünden (fonksiyonlar çift tıklamada kod açar)
  await cw.click('.trow.k-view:has-text("big_orders")', { button: 'right' });
  await cw.click('.ctx button:has-text("DDL göster")');
  await cw.waitForFunction(() => /CREATE OR REPLACE VIEW/.test(document.querySelector('.code-tab:not(.hidden) .cm-content')?.textContent || ''));
  assert(true, 'view tanımı sözdizimi renkli kod editöründe açıldı');
  await shot(cw, '08-view-kod');

  // --- SQL editörü: Ctrl+Enter, çoklu sonuç
  await cw.click('#btnNewSql');
  await cw.click('.sql-tab:not(.hidden) .cm-content');
  await cw.keyboard.type("select country, count(*) from customers group by 1 order by 2 desc;\nselect * from orders where total > 300 limit 50;");
  await cw.keyboard.press('Control+Enter');
  await cw.waitForFunction(() => document.querySelectorAll('.sql-tab:not(.hidden) .res-tab').length >= 3, null, { timeout: 15000 });
  assert(true, 'Ctrl+Enter iki sonuç kümesi üretti');
  await shot(cw, '09-sql-editor');

  // --- Salt okunur: UPDATE onay ister
  await cw.click('.sql-tab:not(.hidden) .cm-content');
  await cw.keyboard.press('Control+a');
  await cw.keyboard.type("update customers set country = 'TR' where id = 1");
  await cw.keyboard.press('Control+Enter');
  await cw.waitForSelector('.modal:has-text("Salt okunur kip")');
  assert(true, 'salt okunur kipte UPDATE onay penceresi açtı');
  await shot(cw, '10-salt-okunur-onay');
  await cw.click('.modal .btn:has-text("Vazgeç")');

  // --- Sorgu oluşturucu
  await cw.click('#btnBuilder');
  await cw.waitForSelector('.builder-tab:not(.hidden) .qb-canvas-wrap');
  const drag = async (name, x, y) => {
    const src = await cw.$(`.trow.k-table:has-text("${name}")`);
    const dst = await cw.$('.builder-tab:not(.hidden) .qb-canvas-wrap');
    const box = await dst.boundingBox();
    const dataTransfer = await cw.evaluateHandle(() => new DataTransfer());
    await src.dispatchEvent('dragstart', { dataTransfer });
    await dst.dispatchEvent('drop', { dataTransfer, clientX: box.x + x, clientY: box.y + y });
  };
  await drag('customers', 60, 40);
  await cw.waitForSelector('.qb-table');
  await drag('orders', 420, 60);
  await cw.waitForFunction(() => document.querySelectorAll('.qb-table').length === 2);
  // otomatik JOIN (orders.customer_id → customers.id)
  await cw.waitForSelector('.qb-join');
  await cw.locator('.qb-table').nth(0).locator('input[data-col="name"]').check();
  await cw.locator('.qb-table').nth(1).locator('input[data-col="total"]').check();
  await cw.waitForFunction(() => /INNER JOIN public\.orders o ON c\.id = o\.customer_id/.test(document.querySelector('.builder-tab:not(.hidden) .qb-sql-host .cm-content')?.textContent || ''));
  assert(true, 'sürükle-bırak tablolar + otomatik JOIN + kolon seçimi SQL üretti');
  await cw.click('.builder-tab:not(.hidden) [data-a="run"]');
  await cw.waitForSelector('.builder-tab:not(.hidden) .grid-row', { timeout: 15000 });
  assert(true, 'üretilen SQL çalıştı');
  await shot(cw, '11-sorgu-olusturucu');

  // --- Gündüz teması
  await cw.click('#btnTheme');
  await cw.emulateMedia({ colorScheme: 'light' });
  await main.emulateMedia({ colorScheme: 'light' });
  await cw.waitForTimeout(500);
  await shot(cw, '12-gunduz-temasi');
  await main.bringToFront();
  await main.waitForTimeout(300);
  await shot(main, '13-ana-ekran-gunduz');

  console.log('\nTÜM ADIMLAR BAŞARILI — ekran görüntüleri:', shots);
} catch (e) {
  for (const w of app.windows()) console.log('[dom]', await w.evaluate(() => JSON.stringify({ tabs: [...document.querySelectorAll('.ws')].map((x) => ({ cls: x.className, status: x.querySelector('.tb-status')?.textContent, rows: x.querySelectorAll('.grid-row').length, spacer: x.querySelector('.grid-spacer')?.style.height, bodyH: x.querySelector('.grid-body')?.clientHeight })) })).catch((e) => e.message));
  for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(shots, `hata-${i}.png`) }).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
