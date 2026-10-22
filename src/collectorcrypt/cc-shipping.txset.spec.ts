import {
  burnTxSetIdentity,
  transactionMessageBytes,
} from './cc-shipping.txset';

/**
 * FIXTURE NYATA — dihasilkan dengan @solana/web3.js (Transaction legacy + VersionedTransaction v0),
 * dua-duanya transfer SystemProgram sederhana, diserialisasi SEBELUM dan SESUDAH ditandatangani.
 * Inti yang diuji: byte PESAN-nya identik walau base64-nya berbeda — itulah yang membuat identitas
 * set transaksi STABIL lintas langkah tanda tangan wallet.
 */
const LEGACY_UNSIGNED =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAA' +
  'ED8u5lPq4RYmFW4/MVn92fSnD1X6WLiRStYiyN5HrS2nkOSc5CZUj5tO6HNMGoDIWfVTEZhsKU8DMNhYMtW7l8NQAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAgIAAQ' +
  'wCAAAAAQAAAAAAAAA=';
const LEGACY_SIGNED =
  'ATI/rw6zzk7JGxD/3exHVlpPgk9xgX99VT5d06n++AKBEHhKJFn42vhJRJzUH/w4QdhnW4pGhbd0asPbpBXyqgoBAA' +
  'ED8u5lPq4RYmFW4/MVn92fSnD1X6WLiRStYiyN5HrS2nkOSc5CZUj5tO6HNMGoDIWfVTEZhsKU8DMNhYMtW7l8NQAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAgIAAQ' +
  'wCAAAAAQAAAAAAAAA=';
const V0_UNSIGNED =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQ' +
  'ABA/LuZT6uEWJhVuPzFZ/dn0pw9V+li4kUrWIsjeR60tp5DknOQmVI+bTuhzTBqAyFn1UxGYbClPAzDYWDLVu5fDUA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQICAA' +
  'EMAgAAAAEAAAAAAAAAAA==';
const V0_SIGNED =
  'AX1aJe516eWNs740MgWfiGSEvDvZwQuJeIdAe5UKw04qmwnajRo/Gda7Cwwj/gIXtP7pfHLL7oA276cseNsrXwOAAQ' +
  'ABA/LuZT6uEWJhVuPzFZ/dn0pw9V+li4kUrWIsjeR60tp5DknOQmVI+bTuhzTBqAyFn1UxGYbClPAzDYWDLVu5fDUA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQICAA' +
  'EMAgAAAAEAAAAAAAAAAA==';

/**
 * Base64 dari JSON — SENGAJA bukan wire-format Solana, untuk menguji jalur FAIL-OPEN
 * ("tidak terverifikasi", bukan "tidak cocok").
 *
 * CATATAN SEJARAH, supaya namanya tidak menyesatkan: bentuk inilah yang DULU dikembalikan mock CC
 * sebagai `transactions`, dan itu berarti penjaga batch-basi selalu dilewati saat dry-run. Mock-nya
 * sekarang menerbitkan transaksi Solana ASLI (cc-shipping-mock.tx.ts) justru supaya penjaga itu
 * benar-benar teruji — lihat cc-shipping-mock.spec.ts. Di sini ia tinggal sebagai fixture "bukan
 * transaksi": entri sembarangan dari klien yang rusak harus membuat identitas null, bukan mismatch.
 */
const MOCK_BLOB = Buffer.from(
  JSON.stringify({
    m: 'cc-mock-tx',
    s: 'ship-1',
    b: 'batch-1',
    k: 'burn',
    i: 0,
  }),
  'utf8',
).toString('base64');

describe('burn transaction-set identity (B2)', () => {
  describe('transactionMessageBytes', () => {
    it('gives the SAME message bytes for the unsigned and the signed copy (legacy + v0)', () => {
      const legacyUnsigned = transactionMessageBytes(LEGACY_UNSIGNED);
      const legacySigned = transactionMessageBytes(LEGACY_SIGNED);
      expect(legacyUnsigned).not.toBeNull();
      expect(LEGACY_UNSIGNED).not.toEqual(LEGACY_SIGNED); // base64-nya memang beda
      expect(legacySigned!.equals(legacyUnsigned!)).toBe(true);

      const v0Unsigned = transactionMessageBytes(V0_UNSIGNED);
      const v0Signed = transactionMessageBytes(V0_SIGNED);
      expect(v0Unsigned).not.toBeNull();
      expect(V0_UNSIGNED).not.toEqual(V0_SIGNED);
      expect(v0Signed!.equals(v0Unsigned!)).toBe(true);
    });

    it('separates two DIFFERENT transactions', () => {
      expect(
        transactionMessageBytes(LEGACY_SIGNED)!.equals(
          transactionMessageBytes(V0_SIGNED)!,
        ),
      ).toBe(false);
    });

    it('returns null (unverifiable, NOT "mismatch") for anything that is not a Solana transaction', () => {
      for (const input of [
        MOCK_BLOB,
        'UNSIGNED_BURN_TX',
        '',
        'AAAA',
        Buffer.alloc(200, 0).toString('base64'), // 0 tanda tangan → ditolak
      ]) {
        expect(transactionMessageBytes(input)).toBeNull();
      }
    });
  });

  describe('burnTxSetIdentity', () => {
    const shipment = 'ship-1';

    it('is STABLE across signing: the prepared set and the signed set hash the same', () => {
      const prepared = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [LEGACY_UNSIGNED],
        delistTransactions: [V0_UNSIGNED],
      });
      const submitted = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [LEGACY_SIGNED],
        delistTransactions: [V0_SIGNED],
      });
      expect(prepared).not.toBeNull();
      expect(submitted).toBe(prepared);
    });

    it('ignores ORDER inside a group (a frontend may sign/send in a different order)', () => {
      const a = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [LEGACY_SIGNED, V0_SIGNED],
        delistTransactions: [],
      });
      const b = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [V0_SIGNED, LEGACY_SIGNED],
        delistTransactions: [],
      });
      expect(a).toBe(b);
    });

    it('DOES change when the transactions change (a re-prepared, fresher batch)', () => {
      const older = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [LEGACY_SIGNED],
        delistTransactions: [],
      });
      const newer = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [V0_SIGNED],
        delistTransactions: [],
      });
      expect(older).not.toBe(newer);
    });

    it('DOES change when the shipment id changes, and when a group gains/loses a leg', () => {
      const base = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [LEGACY_SIGNED],
        delistTransactions: [],
      });
      expect(
        burnTxSetIdentity({
          outboundShipmentId: 'ship-2',
          transactions: [LEGACY_SIGNED],
          delistTransactions: [],
        }),
      ).not.toBe(base);
      expect(
        burnTxSetIdentity({
          outboundShipmentId: shipment,
          transactions: [LEGACY_SIGNED],
          delistTransactions: [V0_SIGNED],
        }),
      ).not.toBe(base);
    });

    it('keeps the two GROUPS apart: moving a leg between them is not the same set', () => {
      const split = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [LEGACY_SIGNED],
        delistTransactions: [V0_SIGNED],
      });
      const merged = burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: [LEGACY_SIGNED, V0_SIGNED],
        delistTransactions: [],
      });
      expect(split).not.toBe(merged);
    });

    it('returns null when ANY entry is unverifiable, when there is no shipment id, and when there are no burn legs', () => {
      expect(
        burnTxSetIdentity({
          outboundShipmentId: shipment,
          transactions: [LEGACY_SIGNED, MOCK_BLOB],
          delistTransactions: [],
        }),
      ).toBeNull();
      expect(
        burnTxSetIdentity({
          outboundShipmentId: shipment,
          transactions: [LEGACY_SIGNED],
          delistTransactions: [MOCK_BLOB],
        }),
      ).toBeNull();
      expect(
        burnTxSetIdentity({
          outboundShipmentId: '',
          transactions: [LEGACY_SIGNED],
          delistTransactions: [],
        }),
      ).toBeNull();
      expect(
        burnTxSetIdentity({
          outboundShipmentId: shipment,
          transactions: [],
          delistTransactions: [],
        }),
      ).toBeNull();
    });
  });
});
