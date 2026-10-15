# SQL Master — Teknik bilgi föyü

sqlmaster.app tanıtım sayfası için. Buradaki her bilgi v0.1.0 kaynak kodundan ve testlerinden doğrulanmıştır; vaat ya da yol haritası içermez.
"Test edilen sürüm" ifadesi, entegrasyon testlerinin CI'da gerçek sunucuya karşı çalıştığı sürümü belirtir.

## Sistem gereksinimleri

| | |
|---|---|
| İşletim sistemi | Windows 10 / 11, 64 bit (x64) |
| Kurulum | `SQL-Master-Setup-<sürüm>.exe` (NSIS; kurulum klasörü seçilebilir, varsayılan `Program Files\Mastertool\SQL Master`, Başlat menüsünde "Master Tool" klasörü, masaüstü kısayolu) |
| Taşınabilir | `SQL-Master-Portable-<sürüm>.exe` (kurulumsuz tek dosya) |
| İndirme boyutu (0.1.0) | Kurulum 126 MB, taşınabilir 126 MB |
| Hesap | Mastertool hesabıyla giriş zorunludur (ilk açılışta internet gerekir) |
| Sürücü / ek yazılım | Gerekmez; tüm veritabanı sürücüleri uygulamanın içindedir (ODBC/.NET/Java kurulumu yok) |

## Teknoloji

| Bileşen | Sürüm | Not |
|---|---|---|
| Electron | 44.7 (Node.js 24) | Masaüstü kabuğu; her bağlantı penceresinin veritabanı işi ayrı bir süreçte (`utilityProcess`) çalışır, arayüz donmaz |
| PostgreSQL sürücüsü | `pg` 8.23 + `pg-cursor` 2.22 | Satırlar sunucu tarafı imleçle akışla okunur |
| SQL Server sürücüsü | `mssql` 12.7 (`tedious` 20.3) | Saf JavaScript TDS istemcisi |
| MySQL / MariaDB sürücüsü | `mysql2` 3.24 | |
| SQLite | Electron'a gömülü `node:sqlite` | Yerel derleme gerektirmez |
| DuckDB | `@duckdb/node-api` 1.5.6 | Dosyaları (CSV, Parquet, JSON, Excel) doğrudan sorgulamak için |
| SSH tüneli | `ssh2` 1.17 | |
| SQL editörü | CodeMirror 6 (`@codemirror/lang-sql` 6.10) | Lehçeye göre sözdizimi renklendirme ve tamamlama |
| Dil | TypeScript | |

## Veri kaynakları

| Kaynak | Test edilen sürüm | Varsayılan port | Kimlik doğrulama | TLS/SSL | SSH tüneli | Salt okunur kip |
|---|---|---|---|---|---|---|
| PostgreSQL | 16 | 5432 | Kullanıcı adı + parola | 4 kip (aşağıda) | Var | Oturum düzeyinde (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`) + ifade denetimi |
| SQL Server | 2022 | 1433 | SQL Server kimlik doğrulaması (kullanıcı adı + parola) | 4 kip | Var | İfade denetimi |
| MySQL | 8.4 | 3306 | Kullanıcı adı + parola | 4 kip | Var | Oturum düzeyinde (`SET SESSION TRANSACTION READ ONLY`) + ifade denetimi |
| MariaDB | 11 | 3306 | Kullanıcı adı + parola | 4 kip | Var | Oturum düzeyinde + ifade denetimi |
| SQLite | (gömülü) | — | — (dosya) | — | — | Bağlantı düzeyinde (`PRAGMA query_only`) + ifade denetimi; dosya değiştirilmez |
| DuckDB | 1.5.6 | — | — (dosya ya da bellek içi) | — | — | Dosya `READ_ONLY` açılır + ifade denetimi |

**TLS/SSL kipleri** (sunucu kaynakları; varsayılan "Tercih et"):

| Kip | PostgreSQL / MySQL / MariaDB | SQL Server |
|---|---|---|
| Kapalı | Şifresiz bağlantı | `encrypt = false` |
| Tercih et | Önce TLS denenir; sunucu TLS desteklemiyorsa şifresiz bağlanır | TLS açık, sertifika doğrulanmaz |
| Zorunlu | TLS şart, sertifika doğrulanmaz | TLS açık, sertifika doğrulanmaz |
| Doğrula (verify-full) | TLS şart, sertifika doğrulanır; isteğe bağlı CA sertifikası | TLS açık, sertifika doğrulanır |

Bağlantının gerçekten şifreli olup olmadığı pencerenin durum çubuğunda gösterilir (SQL Server'da sunucudan sorgulanır).

**SSH tüneli**

- Kimlik doğrulama: özel anahtar dosyası (isteğe bağlı anahtar parolasıyla), parola ya da SSH ajanı (Windows'ta Pageant).
- Sunucu anahtarı ilk bağlantıda SHA256 parmak iziyle kaydedilir. Sonraki bağlantılarda parmak izi değişirse bağlantı durdurulur ve kullanıcıya sorulur.
- 15 saniyede bir canlı tutma (keepalive) gönderilir.

**Nesne gezgini** (ihtiyaç anında yüklenir):

| | PostgreSQL | SQL Server | MySQL / MariaDB | SQLite | DuckDB |
|---|---|---|---|---|---|
| Veritabanları / şemalar | ✓ / ✓ | ✓ / ✓ | ✓ / — | ✓ / — | ✓ / ✓ |
| Tablo, görünüm, kolon, indeks | ✓ | ✓ | ✓ | ✓ | ✓ |
| Materialized view | ✓ | — | — | — | — |
| Fonksiyon / prosedür | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | — | ✓ / — |
| Trigger | ✓ | ✓ | ✓ | ✓ | — |
| Sequence / tip | ✓ / ✓ | ✓ / ✓ | — | — | ✓ / ✓ |

Tablo ve görünüme çift tıklayınca ilk 100 satır açılır. Kod nesnesine (fonksiyon, prosedür, trigger, görünüm) çift tıklayınca tanımı (DDL) renkli editörde açılır.

## Dosya biçimleri (DuckDB)

| Biçim | Nasıl | Not |
|---|---|---|
| CSV / TSV | `SELECT * FROM 'satis.csv'` ya da `read_csv(...)` | Ayırıcı, başlık ve tip otomatik algılanır; DuckDB'ye gömülü |
| Parquet | `SELECT * FROM 'veri.parquet'` | DuckDB'ye gömülü |
| JSON / NDJSON | `read_json_auto('x.json')` | DuckDB'ye gömülü |
| Excel (.xlsx) | `read_xlsx('x.xlsx')` | DuckDB `excel` eklentisi ilk kullanımda otomatik indirilir (o an internet gerekir) |
| DuckDB veritabanı | `.duckdb` dosyası ya da bellek içi | |

Farklı biçimler tek sorguda birleştirilebilir, örneğin CSV ile JSON'u JOIN etmek. İçe aktarma adımı gerekmez.

## Güvenlik

- **Parolalar:** yalnızca işletim sisteminin anahtar zincirinde saklanır (Electron `safeStorage`, Windows'ta DPAPI).
  - Bağlantı profili dosyasında parola yoktur, yalnızca bir referans tutulur.
  - Anahtar zinciri kullanılamıyorsa parola diske hiç yazılmaz, oturum boyunca bellekte tutulur.
- **Pencereler ve günlük:** parolalar ve bağlantı dizeleri arayüz pencerelerine gönderilmez.
  - Günlük dosyalarındaki ve sorgu geçmişindeki her satır parola süzgecinden geçer.
- **Uçtan uca şifreli senkron:** Mastertool hesabıyla bağlantılar, klasörler ve ayarlar cihazlar arasında taşınır.
  - Veri istemcide AES-256-GCM ile şifrelenir. Anahtar hesap şifresinden türetilir (PBKDF2-SHA256, ardından HKDF-SHA256) ve sunucuya gitmez.
  - Sunucu yalnızca şifreli bloğu görür. Girişte şifrenin kendisi değil, ondan türetilmiş bir doğrulama değeri gönderilir.
  - Cihaza özgü alanlar (yerel anahtar dosyası yolu gibi) senkronlanmaz. Senkron ayarlardan kapatılabilir.
- **Salt okunur kip:** yeni bağlantılarda varsayılan olarak açıktır ve iki katmanda uygulanır.
  1. *İfade sınıflandırıcı:* çalıştırılmadan önce her ifade okuma, oturum ya da yazma olarak sınıflandırılır.
     - INSERT/UPDATE/DELETE/MERGE, DDL ve etkisi bilinmeyen komutlar (EXEC, CALL…) yazma sayılır.
     - CTE içindeki DML de yakalanır.
     - Yazma ifadeleri listelenir ve "yalnızca bu seferlik" onay istenir.
  2. *Sunucu/dosya düzeyi:* PostgreSQL ve MySQL/MariaDB oturumu `READ ONLY` açılır; SQLite `query_only`, DuckDB dosyası `READ_ONLY` kipindedir.
     - SQL Server'da bu katman yoktur; orada sınıflandırıcı uygulanır.
- **TLS:** sunucu bağlantılarında TLS varsayılan olarak denenir ("Tercih et").

## Performans ve sınırlar

| | |
|---|---|
| Akış | Satırlar 500'lük parçalar halinde akar; ilk parça gelir gelmez gösterilir |
| Sonuç başına satır sınırı | Varsayılan 10.000; ayarlardan 100 – 1.000.000 arası seçilebilir. Sınır aşılınca sorgu sunucuda durdurulur ve "ilk N satır" bilgisi gösterilir |
| Tablo önizleme | Varsayılan ilk 100 satır; araç çubuğundan 100 / 500 / 1.000 / 5.000 / 10.000 ya da "Tümü (sınırla)" |
| Izgara | Sanal kaydırma (yalnızca görünen satırlar çizilir) |
| Dışa aktarım | Sınırdan bağımsız, sonuç diske akışla yazılır |
| Çoklu sonuç | Bir betikteki her SELECT ayrı sonuç sekmesinde; mesajlar ayrı sekmede |
| Sorgu iptali | Sunucu tarafında: PostgreSQL `pg_cancel_backend`, MySQL/MariaDB `KILL QUERY`, SQL Server TDS iptali, DuckDB `interrupt`; SQLite parçalar arasında durur |
| İptal güvencesi | Sunucu 5 sn içinde yanıt vermezse o pencerenin veritabanı süreci yeniden başlatılır; uygulama donmaz |
| Bağlantı zaman aşımı | 15 sn (PostgreSQL, SQL Server, MySQL), SSH tüneli 20 sn |
| Sorgu zaman aşımı | Yok (uzun sorgular iptal düğmesiyle durdurulur) |
| Eşzamanlılık | Her bağlantı penceresi ayrı süreç; aynı penceredeki çalıştırmalar sıraya alınır |
| Sorgu geçmişi | Bağlantı başına yerelde, en fazla 5.000 kayıt |

## Klavye kısayolları

| Kısayol | İşlev |
|---|---|
| Ctrl+Enter | Seçimi, seçim yoksa tüm betiği çalıştır (SQL editörü, kod görüntüleyici, sorgu oluşturucu) |
| Ctrl+Shift+Enter | İmlecin bulunduğu ifadeyi çalıştır |
| F5 | Tüm betiği çalıştır; tablo verisinde yenile |
| Ctrl+Space | Otomatik tamamlama (yazarken de kendiliğinden açılır) |
| Ctrl+F | Editörde bul / değiştir |
| Ctrl+T | Yeni SQL sekmesi |
| Ctrl+W | Sekmeyi kapat |
| Ctrl+Tab | Sekmeler arasında geç |
| Ctrl+Shift+B | Görsel sorgu oluşturucu |
| Ctrl+C / Ctrl+A | Izgarada seçili hücreleri kopyala / tümünü seç |
| Ctrl+F (ana ekran) | Bağlantılarda ara |
| Ctrl+N (ana ekran) | Yeni bağlantı |
| Enter / F2 / Del | Seçili kartı aç / düzenle / sil |
| Backspace | Üst klasöre dön |
| Ok tuşları + Enter | Nesne ağacında gezin / aç |

## Dışa aktarım biçimleri

| Biçim | Ayrıntı |
|---|---|
| CSV | UTF-8 BOM'lu (Excel Türkçe karakterleri doğru açar), virgül ayırıcı, CRLF |
| TSV | Sekme ayırıcı |
| JSON | Nesne dizisi |
| JSON Lines | Satır başına bir nesne |

Ayrıca ızgaradan panoya kopyalanabilir.

## Diller

Türkçe, English, Français, Deutsch, Español, العربية (sağdan sola düzen), 中文, Русский.

Varsayılan dil işletim sistemi dilidir, desteklenmiyorsa İngilizce. Tema: Gece, Gündüz ya da Sistem (varsayılan).

## Diğer

- Bağlantı kartları ve iç içe klasörler; kartlar sürükle-bırakla klasörlere taşınır.
- Kolon gizleme, sıralama ve filtre, tabloyu getiren SQL'i anında günceller; SQL editöre aktarılabilir.
- Görsel sorgu oluşturucu:
  - Tablolar ağaçtan sürüklenir; JOIN'ler kolonlar arasında çizilir ya da `<tablo>_id` adından tahmin edilir.
  - Toplama, takma ad, sıralama ve koşul eklenebilir.
- Başlangıç seçenekleri: Windows açılınca başlat, küçültünce sistem tepsisinde göster, kapatınca tepsiye gizle.
- Güncelleme bildirimi: yeni sürüm çıkınca uygulama içinde haber verilir; Ayarlar › Hakkında'dan elle denetlenebilir.

## Sürüm geçmişi

| Sürüm | Tarih | Öne çıkanlar |
|---|---|---|
| 0.1.0 | 15 Ekim 2026 | İlk sürüm: PostgreSQL, SQL Server, MySQL/MariaDB, SQLite, DuckDB; nesne gezgini, SQL editörü, görsel sorgu oluşturucu, salt okunur kip, SSH tüneli, şifreli senkron, 8 dil |
