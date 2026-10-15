# Mimari karar kayıtları (ADR)

## ADR-001 — Yığın: Electron + TypeScript (plandaki .NET/Avalonia yerine)

**Durum:** Kabul edildi (kullanıcı .NET isterse yeniden değerlendirilecek) · **Tarih:** 2026-10-15

**Bağlam.** VeriKöprü planı .NET 8 + Avalonia önerir ama yığının değişebileceğini de söyler. Kullanıcı SQL Master'ın
SSH Master ve FTP Masters ile "aynı mantıkta çalışmasını" istedi; ikisi de Electron uygulamasıdır ve ortak tasarım
dili (renk değişkenleri, kartlar, paneller, ikonlar, gece/gündüz, çok dil), Mastertool hesap/senkron kodu, NSIS
kurulum betiği ve yayın iş akışı paylaşır.

**Karar.** Electron 44 (Node 24) + TypeScript. Ana süreç/ön yükleme/veritabanı süreci esbuild ile CommonJS'e,
pencereler tarayıcı paketine derlenir. Tip denetimi `tsc --noEmit`, testler Vitest.

**Sonuçlar.** Aile ile aynı CSS/ikon/hesap modeli birebir taşındı; sürücüler Node ekosisteminden (aşağıda) geldi.
Bedeli: .NET'e göre daha büyük kurulum (~100 MB). Plan disiplinleri (sağlayıcı arayüzü, güvenlik kuralları,
aşama/kabul kriterleri) aynen uygulandı.

## ADR-002 — Sağlayıcı modeli ve kayıt

`src/core/provider.ts`: `IDataSourceProvider` (id, yetenekler, `connect`) ve `IDataSourceConnection`
(`serverInfo`, lazy `getChildren`, akışlı `query` — 500'lük parça / varsayılan 10.000 satır sınırı, `cancel`,
`getObjectDdl`, `getColumns`, `getCompletionSchema`, `setReadOnly`). Sağlayıcılar `registry.ts`'e kaydolur;
arayüz ve ana süreç hiçbir sürücüyü içe aktarmaz. Betik bölme, salt okunur sınıflandırma ve olay akışı
sağlayıcıdan bağımsız `core/engine/executor.ts`'tedir.

## ADR-003 — Sürücü seçimi (lisanslar)

| Kaynak | Paket | Lisans | Not |
|---|---|---|---|
| PostgreSQL | `pg`, `pg-cursor` | MIT | sunucu tarafı imleç ile akış |
| SQL Server | `mssql` (tedious) | MIT | parti başına çoklu sonuç |
| MySQL/MariaDB | `mysql2` | MIT | KILL QUERY ile iptal |
| SQLite | `node:sqlite` (Node/Electron yerleşik) | MIT (Node) | yerel derleme yok; better-sqlite3 gerekmedi |
| CSV/Parquet/JSON/Excel | `@duckdb/node-api` | MIT | N-API: Electron için yeniden derleme yok |
| SSH tünel | `ssh2` | MIT | anahtar tercihli, sunucu anahtarı sabitlenir |
| Editör | CodeMirror 6 | MIT | lehçeli SQL, şema tamamlama |

Yerel modül derlemesi yok (`npmRebuild: false`); `ssh2`'nin isteğe bağlı `cpu-features`'ı yüklenemezse ssh2 onsuz çalışır.

## ADR-004 — Bağlantı başına ayrı veritabanı süreci

Her bağlantı penceresi bir Electron `utilityProcess` açar (`src/dbhost/host.ts`). Sürücüler ana süreci ve arayüzü
asla bloklamaz (SQLite senkron çalışır). Çalıştırmalar sırayla yürütülür; iptal önce sunucu tarafında yapılır
(pg_cancel_backend, KILL QUERY, TDS attention, DuckDB interrupt), 5 sn'de bitmezse süreç öldürülüp bağlantı yeniden
kurulur. Parolalar bu sürece yalnız bellekte gider.

Not: Electron IPC'de `invoke` yanıtı önceden gönderilmiş büyük `send` mesajlarını geçebilir; çalıştırmanın bitişi bu
yüzden akıştaki `done` olayıyla belirlenir (`renderer/conn/runner.ts`).

## ADR-005 — Güvenlik

- Parolalar yalnızca OS anahtar zinciriyle korunur: Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux
  libsecret). Profil dosyasında (`store.json`) parola yok; şifreli değerler `secrets.json`'da referansla durur.
  Anahtar zinciri yoksa parola diske yazılmaz, oturum boyunca bellekte tutulur.
- TLS varsayılan: sunucu bağlantıları "tercih et" kipinde açılır (önce TLS); şifresiz düşülürse pencere uyarır.
  "Zorunlu" ve "Zorunlu + doğrula" seçenekleri var.
- Salt okunur kip bağlantı başına, varsayılan açık. İki katman: (1) sınıflandırıcı DML/DDL/bilinmeyen komutları
  çalıştırmadan önce engeller ve tek seferlik onay ister; (2) desteklenen veritabanlarında oturum da salt okunur
  açılır (PG `SET SESSION CHARACTERISTICS … READ ONLY`, MySQL `SET SESSION TRANSACTION READ ONLY`, SQLite
  `PRAGMA query_only`, DuckDB `READ_ONLY` erişim kipi). SQL Server'da yalnız sınıflandırıcı (oturum düzeyi yok).
- Log ve geçmişte parola/bağlantı dizesi yok: `redact()` URI kimlik bilgilerini, `password=…`, SQL'deki
  `PASSWORD '…'`/`IDENTIFIED BY '…'` kalıplarını maskeler; nesnelerde gizli alanlar silinir.
- SSH: anahtarla giriş önerilir; sunucu anahtarı ilk bağlantıda kaydedilir, değişirse bağlantı reddedilir.
- Pencereler `contextIsolation`, `nodeIntegration: false`, sıkı CSP; harici bağlantılar yalnız tarayıcıda açılır.

## ADR-006 — Mastertool hesabı

SSH Master v1.2 / FTP Masters v1.1 ile aynı model (`src/main/account/`): prelogin/login (PBKDF2 → authHash),
"Beni hatırla" (belirteç ve şifreleme anahtarı DPAPI ile), çevrimdışı açılış, uçtan uca şifreli kütüphane senkronu
(AES-256-GCM, HKDF info `sqlm-enc-v1`), yeni sürüm bildirimi, `app_version = app.getVersion()`. Arayüz yalnızca
`IAccountService`'i tanır. Uçlar `/api/sq/*` — sözleşme v1 HEPGO sunucu oturumundan doğrulandı (bkz. `account-contract.md`). Paketlenmemiş sürümde `SQLM_DEV_ACCOUNT=1` ile yerel geliştirme
hesabı kullanılabilir; paketlenmiş exe'de bu yol kapalıdır.

## ADR-007 — Kurulum

NSIS + portable; artefakt adları `SQL-Master-Setup-<v>.exe` / `SQL-Master-Portable-<v>.exe`.
`build/installer.nsh` SSH Master'dan birebir alındı (main 5cc0578): Mastertool ortak kurulum klasörü ve
Başlat menüsü kategorisi ("Master Tool", kullanıcı kararı; kurulum klasörü Mastertool).
