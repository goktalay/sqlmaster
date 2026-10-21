# SQL Master

Mastertool ailesinin (SSH Master, FTP Masters) veritabanı istemcisi. PostgreSQL, SQL Server, MySQL/MariaDB,
SQLite ve DuckDB üzerinden CSV/Parquet/JSON/Excel dosyalarına bağlanır.

- **Ana ekran:** "Bağlantı ekle" kartı, bağlantı kartları, sürükle-bırak klasörler, arama
- **Bağlantı penceresi:** lazy nesne ağacı, sekmeli SQL editörü (Ctrl+Enter, otomatik tamamlama, çoklu sonuç, iptal),
  tablo verisi (kolon gizle/sırala/filtre → SQL canlı güncellenir), kod/DDL editörü, görsel sorgu oluşturucu
- **Baskı raporları:** "Rapor ekle" şablonları (liste, gruplu döküm, özet, kart/etiket) seçilen tablodan baskıya hazır
  sorgu üretir; kolon başlığı/biçim/toplam, sayfa boyutu/yönü, başlık ve alt bilgi; canlı önizleme, yazdırma ve PDF
- **Güvenlik:** parolalar yalnız OS anahtar zincirinde, TLS varsayılan, bağlantı başına salt okunur kip (varsayılan açık),
  SSH tünel, log/geçmişte parola yok
- **Hesap:** Mastertool girişi zorunlu, uçtan uca şifreli bağlantı kütüphanesi senkronu

## Geliştirme

```bash
npm ci
npm run typecheck
npm test                    # birim testleri
npm run test:integration    # gerçek veritabanları (Docker gerekir; yoksa ilgili testler atlanır)
SQLM_DEV_ACCOUNT=1 npm start   # yerel geliştirme hesabıyla (sunucu gerekmez; paketli exe'de kapalı)
xvfb-run -a node tests/e2e/smoke.mjs   # Electron uçtan uca duman testi (PG: SQLM_E2E_PG=host:port:user:pass:db)
```

Dış sunucuya karşı entegrasyon: `SQLM_EXTERNAL_POSTGRES=postgres://u:p@host:5432/db` (MSSQL, MYSQL, MARIADB için de).

## Yayın

`v1.2.3` etiketi gönderilince GitHub Actions Windows'ta `SQL-Master-Setup-1.2.3.exe` ve `SQL-Master-Portable-1.2.3.exe`
üretir, Release'e ekler ve `SQLM_RELEASE_KEY` secret'ı tanımlıysa sqlmaster.app'e yükler.

## Yapı

```
src/core       sağlayıcı arayüzü, kayıt, SQL katmanı (bölme, sınıflandırma, ızgara SQL'i, sorgu oluşturucu), yürütücü, sağlayıcılar
src/dbhost     bağlantı başına veritabanı süreci (utilityProcess)
src/main       Electron ana süreç: servisler, depo, anahtar zinciri, log, hesap, pencereler, IPC
src/preload    güvenli köprü
src/renderer   giriş, ana ekran, bağlantı penceresi
docs/          kararlar (ADR), aşamalar, hesap sözleşmesi
```
