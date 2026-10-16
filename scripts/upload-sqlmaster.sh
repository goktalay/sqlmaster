#!/usr/bin/env bash
# Exe'leri sqlmaster.app'e yükler (Mastertool sözleşmesi v1, §4 — SQL Master uçları HEPGO sunucu oturumundan kesinleşecek; bkz. docs/account-contract.md).
# Kullanım: upload-sqlmaster.sh <sürüm> <setup.exe> [notlar] [portable.exe]
# Anahtar SQLM_RELEASE_KEY ortam değişkeninden okunur; tanımlı değilse uyarı verip çıkar.
#
# Her dosya ayrı istekle ve ≤ 90 MB parçalar halinde gönderilir: sunucunun önündeki Cloudflare
# tek istekte 100 MB üstünü reddeder (413).
#   Kurulum:  POST /api/sq/releases/<sürüm>/setup     (zorunlu; sürüm kaydını oluşturur)
#   Portable: POST /api/sq/releases/<sürüm>/portable  (isteğe bağlı; başarısızsa yayın sürer)
# 409 exists → zaten yüklü, atlanır. Son parçanın yanıtındaki sha256 yerel dosyayla karşılaştırılır.
set -euo pipefail

VERSION="$1"
SETUP="$2"
NOTES="${3:-}"
PORTABLE="${4:-}"
[ -n "$NOTES" ] || NOTES="SQL Master $VERSION"
API="${SQLM_API:-https://sqlmaster.app}/api/sq/releases"
PART_BYTES="${SQLM_PART_BYTES:-90000000}"     # test için küçültülebilir

# Kopyala-yapıştırda kalan baştaki/sondaki boşluk ve satır sonları anahtarı geçersiz kılmasın
SQLM_RELEASE_KEY="$(printf '%s' "${SQLM_RELEASE_KEY:-}" | tr -d '[:space:]')"
if [ -z "$SQLM_RELEASE_KEY" ]; then
  echo "::warning::SQLM_RELEASE_KEY tanımlı değil; sqlmaster.app'e yükleme atlandı."
  exit 0
fi
# Teşhis için yalnızca uzunluk yazılır (değer asla yazılmaz)
echo "Yükleme anahtarı: ${#SQLM_RELEASE_KEY} karakter"

post() { # post <url> <curl -F argümanları...>  → HTTP kodu; gövde response.json'a
  local url="$1"; shift
  curl -sS -o response.json -w '%{http_code}' -X POST "$url" -H "X-Release-Key: $SQLM_RELEASE_KEY" "$@"
}

# Dosyayı ≤ PART_BYTES parçalar halinde sırayla gönderir; son HTTP kodunu yazdırır
post_parts() { # post_parts <url> <dosya> <dosya adı> [ek -F argümanları...]
  local url="$1" file="$2" name="$3"; shift 3
  # Göreli geçici klasör: Windows'taki curl, Git Bash'in /tmp yollarını okuyamaz
  local dir; dir=$(mktemp -d ./.sqlm-parts.XXXXXX)
  split -b "$PART_BYTES" -d -a 3 "$file" "$dir/part."
  local parts=( "$dir"/part.* ) total=${#parts[@]} i=0 code=""
  for p in "${parts[@]}"; do
    code=$(post "$url" -F "file=@$p;filename=$name" -F "part=$i" -F "parts=$total" -F "filename=$name" "$@")
    echo "  parça $((i + 1))/$total → HTTP $code $(cat response.json)" >&2
    case "$code" in 200|201) ;; *) break ;; esac
    i=$((i + 1))
  done
  rm -rf "$dir"
  echo "$code"
}

# Sunucunun bildirdiği sha256'yı yerel dosyayla karşılaştırır
verify() { # verify <dosya>
  local want got
  want=$(sha256sum "$1" | cut -d' ' -f1)
  got=$(sed -n 's/.*"sha256": *"\([0-9a-fA-F]*\)".*/\1/p' response.json | tr 'A-F' 'a-f')
  if [ -z "$got" ]; then echo "::warning::Sunucu yanıtında sha256 yok; doğrulanamadı."; return 0; fi
  if [ "$got" = "$want" ]; then echo "  sha256 doğrulandı: $want"; else echo "::error::sha256 uyuşmuyor (yerel $want, sunucu $got)"; return 1; fi
}

# --- Kurulum ------------------------------------------------------------------
echo "Kurulum: $SETUP ($(stat -c %s "$SETUP") bayt), sürüm $VERSION"
HTTP=$(post_parts "$API/$VERSION/setup" "$SETUP" "$(basename "$SETUP")" -F "notes=$NOTES")
case "$HTTP" in
  200|201) echo "sqlmaster.app: kurulum $VERSION yüklendi."; verify "$SETUP" ;;
  409) echo "::notice::sqlmaster.app'de $VERSION kurulumu zaten var (409); atlandı." ;;
  403) echo "::warning::sqlmaster.app yüklemesi yetkilendirilmedi (HTTP 403); GitHub Release yayınlandı, yükleme atlandı." ;;
  *) echo "::error::Kurulum yüklemesi başarısız (HTTP $HTTP)."; exit 1 ;;
esac

# --- Portable (isteğe bağlı) ----------------------------------------------------
if [ -n "$PORTABLE" ] && [ -f "$PORTABLE" ]; then
  echo "Portable: $PORTABLE ($(stat -c %s "$PORTABLE") bayt)"
  HTTP=$(post_parts "$API/$VERSION/portable" "$PORTABLE" "$(basename "$PORTABLE")") || HTTP=000
  case "$HTTP" in
    200|201) echo "sqlmaster.app: portable $VERSION yüklendi."; verify "$PORTABLE" || true ;;
    409) echo "::notice::sqlmaster.app'de $VERSION portable zaten var (409); atlandı." ;;
    *) echo "::warning::Portable yüklemesi başarısız (HTTP $HTTP); kurulum yüklendiği için yayın sürüyor." ;;
  esac
fi
