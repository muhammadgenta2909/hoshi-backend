import { appendBoundedNote, NOTE_MAX } from './append-note';

/**
 * B2 — catatan baris redemption adalah SATU-SATUNYA bukti durabel kenapa sebuah baris nyangkut.
 * Aksi pemulihan admin dulu MENIMPA-nya, jadi string yang membedakan "submitBurn LEG GAGAL" /
 * "submitBurn INDETERMINATE" / "submitBurn DITOLAK CC tanpa membakar apa pun" hilang untuk
 * selamanya (log droplet dirotasi). Helper ini yang memastikan tulisan berikutnya MENAMBAH.
 */
describe('appendBoundedNote (B2)', () => {
  it('returns the new note as-is when there is nothing to preserve', () => {
    expect(appendBoundedNote(null, 'baru')).toBe('baru');
    expect(appendBoundedNote(undefined, 'baru')).toBe('baru');
    expect(appendBoundedNote('   ', 'baru')).toBe('baru');
  });

  it('PRESERVES the prior note and puts the newest one last', () => {
    const prior = 'submitBurn LEG GAGAL: leg 2 tidak mendarat';
    const next = '[ADMIN RECOVER ...] operator menyatakan sudah verifikasi ke CC';

    const out = appendBoundedNote(prior, next);

    expect(out).toContain(prior);
    expect(out).toContain(next);
    expect(out.endsWith(next)).toBe(true);
    expect(out.indexOf(prior)).toBeLessThan(out.indexOf(next));
  });

  it('never exceeds the cap, and truncates the OLDEST part — never the newest reason', () => {
    const prior = 'A'.repeat(480) + 'PALING_TUA_HILANG_DULU';
    const next = 'submitBurn INDETERMINATE: jaringan putus saat burn';

    const out = appendBoundedNote(prior, next, NOTE_MAX);

    expect(out.length).toBeLessThanOrEqual(NOTE_MAX);
    // Yang TERBARU utuh...
    expect(out).toContain(next);
    expect(out.endsWith(next)).toBe(true);
    // ...sisa catatan lama yang masih muat adalah EKORNYA (bagian termuda), dengan penanda.
    expect(out.startsWith('…')).toBe(true);
    expect(out).toContain('PALING_TUA_HILANG_DULU');
  });

  it('a newest note that alone exceeds the cap keeps its HEAD (the failure classification)', () => {
    const next = 'submitBurn LEG GAGAL: ' + 'x'.repeat(NOTE_MAX);

    const out = appendBoundedNote('catatan lama apa pun', next, NOTE_MAX);

    expect(out.length).toBe(NOTE_MAX);
    expect(out.startsWith('submitBurn LEG GAGAL:')).toBe(true);
  });

  it('drops the old note entirely rather than mangling the new one when there is no room', () => {
    const next = 'y'.repeat(NOTE_MAX - 1);

    const out = appendBoundedNote('catatan lama', next, NOTE_MAX);

    expect(out).toBe(next);
    expect(out.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  it('appending repeatedly stays bounded and always ends with the most recent fact', () => {
    let note: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      note = appendBoundedNote(note, `kejadian ke-${i} dengan keterangan panjang sekali`);
      expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    }
    expect(note).toContain('kejadian ke-19');
    expect((note as string).endsWith('kejadian ke-19 dengan keterangan panjang sekali')).toBe(true);
  });
});
