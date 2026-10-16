# Mastertool hesap sözleşmesi — SQL Master (v1, HEPGO sunucu oturumundan doğrulandı)

Sunucu canlı: `https://sqlmaster.app/api/sq/health`. Kaynak: goktalay/fabrika-yonetim `docs/sqlmaster-api.md`.
Test vektörü (`Test1234!` / `AAECAwQFBgcICQoLDA0ODw==` / 310000) birim testinde doğrulanır.

| Konu | Değer |
|---|---|
| API tabanı | `https://sqlmaster.app` (`SQLM_API` ile değişir), önek `/api/sq` |
| Ön giriş | `POST /auth/prelogin {email}` → `{kdf:{alg:"PBKDF2-SHA256",salt,iter}}` |
| Giriş | `POST /auth/login {email, auth_hash, device, app_version}` → `{token, user:{id,email,name}, kdf, sync_enabled}` |
| Oturum | `POST /auth/logout`, `GET /me`, `PUT /settings {sync_enabled}` |
| Kütüphane | `GET/PUT/DELETE /library`; PUT `{base_version, blob}` → `{version}`; çakışma 409 `{version, blob}`; blob ≤ 5 MB |
| Sürüm | `GET /releases/latest` → `{version, notes, size, sha256, portable, portable_size, date}` ya da `{version:null}` |
| Yükleme | `POST /releases/<v>/setup` ve `/portable`, başlık `X-Release-Key` (secret `SQLM_RELEASE_KEY`), ≤ 90 MB parçalar |
| Hatalar | `bad_credentials`, `unverified`, `suspended`, `rate_limited`, 401 `session_expired`, 403 `app_disabled` / `wrong_app` |
| Şifreleme | `encKey = HKDF(master, info="sqlm-enc-v1")`, AES-256-GCM; açık metin `{schema:1, items:[…]}` |
| Öğe türleri | `connection`, `folder`, `settings` (`query` sözleşmede var, v1 istemci kullanmıyor; parolalar yalnız şifreli blob içinde) |
| Web sayfaları | `https://sqlmaster.app/kayit`, `/sifremi-unuttum`, `/hesabim` + `?app=sq&lang=&theme=` (sunucu mastertool.download'a yönlendirir) |
| Mastertool düğmesi | `https://mastertool.download/?lang=&theme=` |

## Cihazda ortak oturum (SSO) — 6 Mastertool uygulaması

Bir uygulamada giriş yapılınca diğerleri şifresiz açılır; birinde çıkış yapılınca hepsi kapanır. Başvuru: goktalay/mastertool `src/sso.js` (41d0035). Kod: `src/main/account/sso.ts`, akışlar `mastertool.ts`.

| | |
|---|---|
| Şifreyle giriş | `POST /auth/login {…, sso:true}` → `{token, sso_token, …}`; ortak kimlik yazılır, durum `{gen+1,"in"}` |
| Şifresiz giriş | `POST /auth/sso {sso_token, device, app_version}` → `{token, user, kdf, sync_enabled}`; şifreleme anahtarı `HKDF(master, "sqlm-enc-v1")` |
| Çıkış | `POST /auth/logout` (Bearer) → ortak kimlik silinir → kendi token'ı silinir → durum `{gen+1,"out"}` |
| Ortak kimlik | Windows Kimlik Bilgisi Yöneticisi, `@napi-rs/keyring` `Entry('Mastertool','sso')`; JSON ≤ 1200 karakter: `{v:1, email, user:{id,name}, sso_token, master, kdf, at}` |
| Durum işareti | `%APPDATA%\Mastertool\sso-state.json` `{gen, state, at}` (geçici dosya + rename); `fs.watch` + 5 sn yoklama |

- Açılışta kendi oturumu yoksa ve ortak kimlik varsa `/auth/sso` denenir; 401 → ortak kimlik silinir, durum "out"; 403 `app_disabled` → giriş ekranında mesaj.
- Durum değişince ortak kimlik okunur:
  - kimlik yok + oturum açık → yerel çıkış (giriş ekranı, "başka uygulamada çıkış yapıldı"); kütüphane silinmez.
  - kimlik var + oturum kapalı → `/auth/sso`.
  - aynı hesap yeniden girmiş → yalnız bağ güncellenir.
  - başka hesap → çıkış + `/auth/sso`; eski kütüphane yedeklenir.
- Herhangi bir istekte 401 `session_expired` → yerel çıkış + ortak kimlik silinir + durum "out". `app_disabled` / `wrong_app` ortak kimliğe dokunmaz.
- `master` ve `sso_token` asla dosyaya, günlüğe ya da sunucuya yazılmaz; `account.json` yalnızca `sso_token`'ın SHA-256 özetini (bağ) tutar.
- Tek örnek: `requestSingleInstanceLock`; ikinci açılışta (ör. Master Tool tepsi menüsü) ana pencere ya da giriş penceresi gizliyse gösterilir, simge durumundaysa geri yüklenir, öne gelir.
- Yalnız Windows'ta etkindir; diğer platformlarda ve geliştirme hesabında devre dışı.
