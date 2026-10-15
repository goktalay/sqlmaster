# Aşamalar ve kabul kriterleri

Durum: ✅ tamam · 🟡 kısmen · ⏳ sırada

## Aşama 0 — İskelet ✅
- Electron + TS iskeleti, servis kökü (`main/container.ts`), log (parola maskeli), OS anahtar zinciri kasası
- Giriş penceresi ve SSH Master tasarımıyla ana ekran (Bağlantı ekle kartı, bağlantı kartları, sürüklenebilir klasörler), gece/gündüz, tr/en
- CI: tip denetimi + derleme + birim + entegrasyon + Electron duman testi; Release: Windows Setup/Portable + sunucuya yükleme

## Aşama 1 — PostgreSQL uçtan uca ✅
- Bağlantı formu (test, TLS, salt okunur, parola kaydetme, SSH tünel), bağlantı penceresi
- Lazy ağaç: veritabanı → şema → tablolar/görünümler/matview/yabancı tablolar/fonksiyonlar/prosedürler/trigger'lar/sequence'ler/tipler → kolonlar/indeksler/kısıtlar
- Çift tıklama: tablo/görünüm → ilk N kayıt; kod nesneleri → renkli editörde tanım (görünüm/tablo DDL'i bağlam menüsünden)
- Izgara ↔ SQL: kolon gizle/göster, sıralama, filtre SELECT'e yansır ve görünür
- SQL editörü: sekmeler, Ctrl+Enter (seçili/tümü), Ctrl+Shift+Enter (imleçteki ifade), F5, çoklu sonuç, iptal, otomatik tamamlama, geçmiş
- Görsel sorgu oluşturucu: sürükle-bırak tablolar, JOIN çizme (tür değiştirme), kolon/takma ad/toplama/sıralama, koşullar, canlı ve düzenlenebilir SQL, çalıştırma
- Dışa aktarım (CSV/TSV/JSON) akışla

## Aşama 2 — Diğer P0 sağlayıcılar ✅
- SQL Server, MySQL/MariaDB, SQLite, DuckDB (CSV/Parquet/JSON/Excel)

## Aşama 3 — Hesap ve senkron ✅ (gerçek hesapla uçtan uca deneme bekliyor)
- Sözleşme v1 doğrulandı (test vektörü birim testinde); sunucu canlı; sağ üstte Mastertool düğmesi

## Aşama 4 — P1 ⏳
- Oracle (oracledb thin), ClickHouse, Snowflake, ODBC; SFTP/S3 dosya kaynakları; kayıt düzenleme (ızgarada INSERT/UPDATE); şema karşılaştırma

## Kabul örnekleri
| Kriter | Durum | Kanıt |
|---|---|---|
| 1M satırlık tabloda ilk sonuç < 2 sn, UI donmaz, iptal çalışır | ✅ | `tests/integration/postgres.test.ts` (ilk parça ölçülür), ayrı veritabanı süreci, iptal testleri her sağlayıcıda |
| CSV ile Parquet tek sorguda JOIN | ✅ | `tests/integration/files.test.ts` (CSV + Parquet + JSON) |
| 500k satır bellek taşmadan dışa aktarım | ✅ | akışlı `exportQuery` (geri basınçlı); testte 300k satır CSV, yığın artışı sınırlı |
| Her sağlayıcı: bağlantı, şema listeleme, sorgu, iptal | ✅ | PG, SQL Server, MySQL, MariaDB, SQLite, DuckDB testleri |

## Kapsam dışı (v1)
NoSQL, ER diyagramı, sunucu modu, .bak okuma.
