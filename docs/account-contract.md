# Mastertool hesap sözleşmesi — SQL Master (VARSAYIM, kesinleşmedi)

HEPGO sunucu oturumu sözleşmeyi gönderene kadar istemci FTP Masters v1 sözleşmesinin uyarlamasını kullanır.
Değişiklik gerekirse yalnızca `src/main/account/mastertool.ts` (+ `scripts/upload-sqlmaster.sh`) güncellenir.

| Konu | Varsayım |
|---|---|
| API tabanı | `https://sqlmaster.app` (`SQLM_API` ile değişir), önek `/api/sq` |
| Ön giriş | `POST /auth/prelogin {email}` → `{kdf:{alg:"PBKDF2-SHA256",salt,iter}}` |
| Giriş | `POST /auth/login {email, auth_hash, device, app_version}` → `{token, user:{id,email,name}, kdf, sync_enabled}` |
| Oturum | `POST /auth/logout`, `GET /me`, `PUT /settings {sync_enabled}` |
| Kütüphane | `GET/PUT/DELETE /library`; PUT `{base_version, blob}` → `{version}`; çakışma 409 `{version, blob}`; blob ≤ 5 MB |
| Sürüm | `GET /releases/latest` → `{version, notes}` |
| Yükleme | `POST /releases/<v>/setup` ve `/portable`, başlık `X-Release-Key` (secret `SQLM_RELEASE_KEY`), ≤ 90 MB parçalar |
| Hatalar | `bad_credentials`, `unverified`, `suspended`, `rate_limited`, 401 `session_expired`, 403 `app_disabled` / `wrong_app` |
| Şifreleme | `encKey = HKDF(master, info="sqlm-enc-v1")`, AES-256-GCM; açık metin `{schema:1, items:[…]}` |
| Öğe türleri | `connection`, `folder`, `settings` (parolalar yalnız şifreli blob içinde) |
| Web sayfaları | `https://mastertool.download` + `/kayit`, `/sifremi-unuttum`, `/hesabim` (`SQLM_WEB` ile değişir) |
