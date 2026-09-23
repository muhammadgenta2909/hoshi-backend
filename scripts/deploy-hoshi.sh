#!/usr/bin/env bash
# ==============================================================================
#  DEPLOY HOSHI BACKEND — dua langkah, dan langkah pertama TIDAK MENGUBAH APA PUN.
#
#  Jalankan DI DROPLET (bukan di laptop):
#      bash deploy-hoshi.sh cek     # read-only. Menjawab: aman deploy atau tidak.
#      bash deploy-hoshi.sh jalan   # backup -> pull -> rebuild -> verifikasi
#
#  KENAPA DIPISAH DUA: di droplet ini migrasi dirantai SEBELUM server dalam satu
#  perintah (`prisma migrate deploy && node dist/main`). Satu migrasi gagal bukan
#  berarti "rilisnya batal" — kontainernya tidak pernah menyala, dan seluruh
#  api.hoshimarket.xyz ikut mati. Build di produksi saat ini lebih tua daripada
#  jalur kirim domestik, jadi deploy berikutnya menjalankan tunggakan dua bulan
#  sekaligus. Makanya dilihat dulu, baru dilompati.
# ==============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hoshi}"
API_URL="${API_URL:-https://api.hoshimarket.xyz}"

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_bad()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_head() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

cd "$APP_DIR" 2>/dev/null || { c_bad "Direktori $APP_DIR tidak ada. Set APP_DIR=... lalu ulangi."; exit 1; }

# ── Temukan checkout git backend-nya. Layoutnya berbeda-beda antar droplet, jadi DICARI,
#    bukan ditebak. Hanya dibutuhkan oleh `jalan`; `cek` tidak menyentuh repo sama sekali. ──
find_repo() {
  for d in "$APP_DIR" "$APP_DIR/backend" "$APP_DIR/hoshi-backend" "$APP_DIR/app"; do
    [ -d "$d/.git" ] && { REPO_DIR="$d"; return 0; }
  done
  c_bad "Tidak menemukan checkout git backend di bawah $APP_DIR."
  echo "   Cari dengan:  find $APP_DIR -maxdepth 3 -name .git -type d"
  echo "   Lalu ulangi:  REPO_DIR=/path/ke/repo bash deploy-hoshi.sh jalan"
  exit 1
}

# ── Temukan service database & kredensialnya dari kontainer, bukan dari tebakan ──
detect_db() {
  DB_SVC="$(docker compose ps --services 2>/dev/null | grep -iE '^(db|postgres|pg)' | head -1 || true)"
  [ -n "$DB_SVC" ] || { c_bad "Tidak menemukan service database di docker compose. Jalankan 'docker compose ps --services' dan set DB_SVC=... manual."; exit 1; }
  DB_USER="$(docker compose exec -T "$DB_SVC" printenv POSTGRES_USER 2>/dev/null | tr -d '\r' || true)"
  DB_NAME="$(docker compose exec -T "$DB_SVC" printenv POSTGRES_DB   2>/dev/null | tr -d '\r' || true)"
  : "${DB_USER:=postgres}"
  : "${DB_NAME:=$DB_USER}"
  echo "database: service=$DB_SVC user=$DB_USER db=$DB_NAME"
}

psql_q() { docker compose exec -T "$DB_SVC" psql -U "$DB_USER" -d "$DB_NAME" -tAX -c "$1"; }

# ==============================================================================
cmd_cek() {
  detect_db
  local gagal=0

  c_head "CEK 0a — migrasi terakhir yang sukses"
  psql_q "SELECT migration_name || '  ' || finished_at FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 5;"

  c_head "CEK 0b — migrasi GAGAL / menggantung (harus kosong)"
  local menggantung
  menggantung="$(psql_q "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;")"
  if [ "$menggantung" != "0" ]; then
    c_bad "ADA $menggantung migrasi gagal/menggantung. Deploy akan DITOLAK dan server tidak menyala."
    psql_q "SELECT migration_name || ' | started=' || started_at || ' | rolled_back=' || COALESCE(rolled_back_at::text,'-') FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;"
    echo "   Bereskan dengan: npx prisma migrate resolve --rolled-back <nama>  (di dalam kontainer api)"
    gagal=1
  else
    c_ok "nol — bersih."
  fi

  c_head "CEK 0c — jumlah migrasi tercatat (repo saat ini: 52 folder)"
  psql_q "SELECT count(*) FROM \"_prisma_migrations\";"

  c_head "CEK 1 — kartu dengan >1 permintaan kirim hidup (paling mungkin menggagalkan deploy)"
  local dobel
  dobel="$(psql_q "SELECT count(*) FROM (SELECT \"nftAddress\" FROM \"card_redemptions\" WHERE status IN ('REQUESTED','PACKING','SHIPPED','AWAITING_PAYMENT','READY_TO_FUND','FUNDING','FUNDED','BURN_SUBMITTED','IN_TRANSIT','RECLAIM_DUE','SHIP_FAILED_POST_BURN') GROUP BY \"nftAddress\" HAVING count(*) > 1) x;")"
  if [ "$dobel" != "0" ]; then
    c_bad "ADA $dobel kartu bermasalah. Index anti-dobel-kirim akan DITOLAK -> migrasi gagal -> backend mati."
    psql_q "SELECT \"nftAddress\" || ' | ' || string_agg(id || '(' || status || ')', ', ') FROM \"card_redemptions\" WHERE status IN ('REQUESTED','PACKING','SHIPPED','AWAITING_PAYMENT','READY_TO_FUND','FUNDING','FUNDED','BURN_SUBMITTED','IN_TRANSIT','RECLAIM_DUE','SHIP_FAILED_POST_BURN') GROUP BY \"nftAddress\" HAVING count(*) > 1;"
    echo "   JANGAN bulk UPDATE. Selesaikan satu per satu."
    echo "   BAHAYA: baris FUNDING/FUNDED/BURN_SUBMITTED berarti USDC treasury sudah/mungkin sudah keluar —"
    echo "   jangan di-CANCELED begitu saja, itu menghapus jejak uang yang sudah bergerak."
    gagal=1
  else
    c_ok "nol — aman."
  fi

  c_head "CEK 2 — listing dengan >1 permintaan kirim hidup"
  local dobel2
  dobel2="$(psql_q "SELECT count(*) FROM (SELECT \"listingId\" FROM \"card_redemptions\" WHERE \"listingId\" IS NOT NULL AND status IN ('REQUESTED','PACKING','SHIPPED','AWAITING_PAYMENT','READY_TO_FUND','FUNDING','FUNDED','BURN_SUBMITTED','IN_TRANSIT','RECLAIM_DUE','SHIP_FAILED_POST_BURN') GROUP BY \"listingId\" HAVING count(*) > 1) x;" 2>/dev/null || echo 0)"
  if [ "$dobel2" != "0" ]; then
    c_bad "ADA $dobel2 listing bermasalah — bereskan dulu."
    gagal=1
  else
    c_ok "nol — aman. (Kolom listingId mungkin belum ada di build lama; itu normal.)"
  fi

  c_head "CEK 3 — potret sebelum deploy (catat angkanya)"
  psql_q "
    SELECT 'order menunggu refund      : ' || count(*) FROM \"payment_orders\" WHERE status='REFUND_DUE'
    UNION ALL SELECT 'order nyangkut FULFILLING  : ' || count(*) FROM \"payment_orders\" WHERE status='FULFILLING'
    UNION ALL SELECT 'permintaan kirim aktif     : ' || count(*) FROM \"card_redemptions\" WHERE status NOT IN ('CANCELED','DELIVERED','REFUND_DUE')
    UNION ALL SELECT 'listing ACTIVE             : ' || count(*) FROM \"listings\" WHERE status='ACTIVE'
    UNION ALL SELECT 'listing ACTIVE bisa dibeli : ' || count(*) FROM \"listings\" WHERE status='ACTIVE' AND \"sellable\"=true
    UNION ALL SELECT 'listing punya penjual user : ' || count(*) FROM \"listings\" WHERE \"sellerId\" IS NOT NULL;"

  c_head "VERDIKT"
  if [ "$gagal" -eq 0 ]; then
    c_ok "AMAN — lanjut:  bash deploy-hoshi.sh jalan"
  else
    c_bad "JANGAN DEPLOY. Bereskan temuan di atas dulu."
    exit 1
  fi
}

# ==============================================================================
cmd_jalan() {
  detect_db
  local stamp; stamp="$(date +%F-%H%M)"

  c_head "1/5 — CADANGAN DATABASE (satu-satunya langkah yang tidak bisa diulang kalau terlambat)"
  docker compose exec -T "$DB_SVC" pg_dump -U "$DB_USER" "$DB_NAME" > "backup-$stamp.sql"
  ls -lh "backup-$stamp.sql"
  [ -s "backup-$stamp.sql" ] || { c_bad "Cadangan KOSONG. Berhenti."; exit 1; }
  c_ok "cadangan tersimpan: $APP_DIR/backup-$stamp.sql"

  c_head "2/5 — TARIK KODE TERBARU (branch production)"
  : "${REPO_DIR:=}"
  [ -n "$REPO_DIR" ] || find_repo
  echo "repo: $REPO_DIR"
  git -C "$REPO_DIR" fetch origin production
  git -C "$REPO_DIR" checkout production
  git -C "$REPO_DIR" pull --ff-only origin production
  git -C "$REPO_DIR" log --oneline -1

  c_head "3/5 — BUILD ULANG + MIGRASI (migrasi jalan otomatis saat kontainer start)"
  docker compose up -d --build api

  c_head "4/5 — TUNGGU /api/health"
  local ok=0
  for i in $(seq 1 40); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL/api/health")" = "200" ]; then ok=1; break; fi
    sleep 5; printf '.'
  done
  echo
  if [ "$ok" -ne 1 ]; then
    c_bad "health TIDAK 200 setelah ~3 menit. Migrasi kemungkinan GAGAL dan server tidak pernah naik."
    echo "Lihat sebabnya:  docker compose logs --tail=120 api"
    exit 1
  fi
  c_ok "health 200 — server naik."

  c_head "5/5 — VERIFIKASI RUTE BARU (401 = ada & dijaga login, 404 = belum naik)"
  for p in health admin/stats admin/consignments admin/shipping/domestic-rates; do
    printf '%-36s -> %s\n' "/api/$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API_URL/api/$p")"
  done
  echo
  echo "Dua yang terakhir HARUS 401 sekarang. Kalau masih 404, build-nya belum berganti —"
  echo "periksa: git -C $APP_DIR/backend log --oneline -1"
  echo
  c_ok "Selesai. Langkah berikutnya: isi tarif ongkir di /admin/ongkir."
}

case "${1:-}" in
  cek)   cmd_cek ;;
  jalan) cmd_jalan ;;
  *) echo "Pakai: bash deploy-hoshi.sh cek   |   bash deploy-hoshi.sh jalan"; exit 1 ;;
esac
