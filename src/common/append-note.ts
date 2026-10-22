/**
 * B2 — CATATAN OPERASIONAL ITU BUKTI, BUKAN KOLOM SCRATCH.
 *
 * `CardRedemption.note` adalah SATU-SATUNYA string DURABEL yang membedakan
 * "submitBurn LEG GAGAL" / "submitBurn INDETERMINATE" / "submitBurn DITOLAK CC tanpa membakar apa
 * pun". Log droplet dirotasi; baris DB tidak. Karena itu tulisan berikutnya WAJIB MENAMBAH, bukan
 * MENIMPA — kalau tidak, aksi pemulihan admin menghapus satu-satunya jejak KENAPA barisnya nyangkut
 * (dan dengan begitu bisa menutupi kerugian nyata, lewat efek samping, bukan lewat desain).
 *
 * ATURAN PEMOTONGAN: kalau gabungannya melewati `max`, yang dibuang adalah bagian TERTUA (kepala),
 * tidak pernah yang TERBARU. Pemotongan ditandai `…` di depan supaya pembaca tahu ada yang hilang.
 * Kalau catatan BARU saja sudah melebihi `max`, ia dipotong dari EKORNYA — klasifikasi kegagalan
 * selalu ada di depan kalimat, jadi kepala kalimat adalah bagian yang paling tidak boleh hilang.
 */
export const NOTE_MAX = 500;

const ELLIPSIS = '…';
const SEPARATOR = '\n';

export function appendBoundedNote(
  prev: string | null | undefined,
  next: string,
  max: number = NOTE_MAX,
): string {
  // Yang TERBARU selalu diprioritaskan: ia dipotong hanya kalau ia sendiri melebihi plafon.
  const newest = (next ?? '').slice(0, max);
  const older = (prev ?? '').trim();
  if (older.length === 0) return newest;

  const budget = max - newest.length - SEPARATOR.length;
  // Tidak ada ruang tersisa sama sekali → catatan baru berdiri sendiri (perilaku lama).
  if (budget <= ELLIPSIS.length) return newest;
  if (older.length <= budget) return `${older}${SEPARATOR}${newest}`;

  // Buang KEPALA (paling tua), sisakan EKOR catatan lama + penanda pemotongan.
  const kept = older.slice(older.length - (budget - ELLIPSIS.length));
  return `${ELLIPSIS}${kept}${SEPARATOR}${newest}`;
}
