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
