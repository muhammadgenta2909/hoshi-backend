#!/usr/bin/env bash
# ==============================================================================
#  SIAP JUALAN? — memeriksa apa yang masih menghalangi transaksi NYATA.
#
#  Jalankan DI DROPLET:  bash siap-jualan.sh
#
#  READ-ONLY sepenuhnya. Tidak mengubah env, tidak menyentuh kontainer, tidak
#  memicu pembayaran apa pun.
#
#  NILAI RAHASIA TIDAK PERNAH DICETAK. Yang ditampilkan hanya TERISI / KOSONG
#  beserta panjangnya — cukup untuk tahu ada-tidaknya, tanpa menaruh kunci di
#  layar yang mungkin di-screenshot atau di-share saat presentasi.
# ==============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/hoshi}"
API_URL="${API_URL:-https://api.hoshimarket.xyz}"
WEB_URL="${WEB_URL:-https://hoshimarket.xyz}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

cd "$APP_DIR" 2>/dev/null || { bad "Direktori $APP_DIR tidak ada."; exit 1; }

API_SVC="$(docker compose ps --services 2>/dev/null | grep -iE '^(api|app|backend|web)' | head -1)"
[ -n "$API_SVC" ] || { bad "Tidak menemukan service API di docker compose."; exit 1; }

# Baca env DARI DALAM KONTAINER YANG JALAN — bukan dari berkas .env di disk.
# Bedanya penting: berkas bisa sudah diedit tapi kontainernya belum di-recreate,
# dan yang menentukan perilaku adalah yang ADA DI DALAM PROSES.
envval() { docker compose exec -T "$API_SVC" printenv "$1" 2>/dev/null | tr -d '\r'; }

cek_env() { # nama, penjelasan, wajib(1)/opsional(0)
  local v; v="$(envval "$1")"
  if [ -n "$v" ]; then ok "$1 terisi (${#v} karakter) — $2"
  elif [ "$3" = "1" ]; then bad "$1 KOSONG — $2"
  else warn "$1 kosong — $2"; fi
}

head_ "1. JALUR UANG (tanpa ini tidak ada yang bisa dibeli)"
cek_env IDRX_API_KEY              "kredensial penerbit tagihan" 1
cek_env IDRX_NETWORK_CHAIN_ID     "jaringan mint IDRX" 1
cek_env HOSHI_PAYMENT_RETURN_URL  "halaman tujuan setelah pembeli bayar" 1
cek_env HOSHI_TREASURY_ADDRESS    "alamat treasury penerima" 1

head_ "2. FOTO (tanpa ini intake titipan macet di lapangan)"
CLOUD="$(envval CLOUDINARY_URL)"
if [ -n "$CLOUD" ]; then
  ok "CLOUDINARY_URL terisi (${#CLOUD} karakter) — foto disimpan di CDN"
else
  warn "CLOUDINARY_URL kosong — unggahan jatuh ke DATA URL base64 (maks 2MB/foto)."
  echo "     Jalan, TAPI tiap foto jadi ~2,8 juta karakter DI DALAM BARIS DATABASE."
  echo "     Untuk demo: aman. Untuk produksi: isi, sebelum barisnya membengkak."
fi

head_ "3. ONGKIR"
BK="$(envval BITESHIP_API_KEY)"
if [ -n "$BK" ]; then
  ok "BITESHIP_API_KEY terisi (${#BK} karakter) — tarif kurir NYATA aktif"
  cek_env BITESHIP_ORIGIN_POSTAL_CODE "kode pos gudang (asal kiriman)" 1
  cek_env BITESHIP_COURIERS           "daftar kurir (kosong = jne,sicepat,jnt)" 0
else
  warn "BITESHIP_API_KEY kosong — lapis tarif kurir DIAM, ongkir memakai tabel tier."
  echo "     Ini bukan kerusakan: sistem memang dirancang jalan tanpanya."
fi

head_ "4. TABEL TARIF ONGKIR (jaring kalau API kurir mati)"
DB_SVC="$(docker compose ps --services 2>/dev/null | grep -iE '^(db|postgres|pg)' | head -1)"
if [ -n "$DB_SVC" ]; then
  DB_USER="$(docker compose exec -T "$DB_SVC" printenv POSTGRES_USER 2>/dev/null | tr -d '\r')"
  DB_NAME="$(docker compose exec -T "$DB_SVC" printenv POSTGRES_DB 2>/dev/null | tr -d '\r')"
  : "${DB_USER:=postgres}"; : "${DB_NAME:=$DB_USER}"
  q() { docker compose exec -T "$DB_SVC" psql -U "$DB_USER" -d "$DB_NAME" -tAX -c "$1" 2>/dev/null; }

  TARIF="$(q 'SELECT count(*) FROM "domestic_shipping_rates";')"
  if [ "${TARIF:-0}" -gt 0 ] 2>/dev/null; then
    ok "$TARIF baris tarif tersimpan:"
    q 'SELECT '"'"'     '"'"' || scope || '"'"' = Rp '"'"' || "priceIdr" FROM "domestic_shipping_rates" ORDER BY scope;'
  else
    warn "tabel KOSONG — ongkir memakai penampung di kode (Jawa 25.000 / luar Jawa 50.000),"
    echo "     angka yang tidak pernah diputuskan siapa pun. Isi di $WEB_URL/admin/ongkir"
  fi

  head_ "5. ISI TOKO — apa yang benar-benar bisa dibeli hari ini"
  q "SELECT '     titipan tercatat      : ' || count(*) FROM \"consignments\";"
  q "SELECT '     titipan DIPAJANG      : ' || count(*) FROM \"listings\" WHERE \"consignmentId\" IS NOT NULL AND status='ACTIVE';"
  q "SELECT '     stok Hoshi bisa dibeli: ' || count(*) FROM \"listings\" WHERE status='ACTIVE' AND \"sellable\"=true;"
  q "SELECT '     katalog CC (tak dijual): ' || count(*) FROM \"listings\" WHERE status='ACTIVE' AND \"sellerId\" IS NULL AND \"sellable\"=false;"
  q "SELECT '     akun admin            : ' || count(*) FROM \"users\" WHERE \"passwordHash\" IS NOT NULL;"

  head_ "6. UTANG YANG BELUM SELESAI"
  q "SELECT '     order REFUND_DUE      : ' || count(*) FROM \"payment_orders\" WHERE status='REFUND_DUE';"
  q "SELECT '     order nyangkut        : ' || count(*) FROM \"payment_orders\" WHERE status IN ('FULFILLING','PAID');"
  q "SELECT '     kiriman aktif         : ' || count(*) FROM \"card_redemptions\" WHERE status NOT IN ('CANCELED','DELIVERED','REFUND_DUE');"
else
  bad "Tidak menemukan service database — bagian 4-6 dilewati."
fi

head_ "7. YANG HIDUP DI LUAR"
for p in api/health api/admin/consignments api/admin/shipping/domestic-rates; do
  printf '     %-38s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API_URL/$p")"
done
for p in titipan titipan/klaim admin/ongkir; do
  printf '     %-38s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$WEB_URL/$p")"
done
echo
echo "     api/health 200 · sisanya 401 (dijaga login) atau 200 = sehat."

head_ "CATATAN"
echo "  Flag frontend TIDAK bisa diperiksa dari sini — ia di-inline saat BUILD di Vercel."
echo "  Cek manual: Vercel > Settings > Environment Variables, pastikan"
echo "  NEXT_PUBLIC_PAYMENTS_ENABLED bernilai PERSIS \"1\" (bukan \"true\" — itu mematikan"
echo "  semua tombol beli tanpa error apa pun), lalu redeploy kalau baru diubah."
echo
