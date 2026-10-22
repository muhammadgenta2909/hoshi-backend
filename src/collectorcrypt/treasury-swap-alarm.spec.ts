import { TreasurySwapScheduler } from './treasury-swap.scheduler';
import { TREASURY_MAX_PACK_PRICE_USDC } from './gacha.service';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   ALARM SALDO TREASURY TIDAK BOLEH IKUT MATI BERSAMA AUTO-SWAP.

   Dua pekerjaan berbagi satu timer di scheduler ini — menukar IDRX→USDC, dan berteriak kalau
   saldo treasury menipis. Dulu `onModuleInit` langsung `return` ketika
   TREASURY_SWAP_SCHEDULER_ENABLED bukan '1', sehingga MATIKAN SWAP = MATIKAN MONITORING.

   Itu salah justru di keadaan yang paling membutuhkannya: float yang dikelola MANUAL adalah
   float yang bisa habis tanpa ada satu pun proses yang memperhatikan. Yang memberi tahu bahwa
   treasury kering kembali menjadi USER, lewat pesan gagal saat ia mencoba membayar — itu bukan
   monitoring, itu kehilangan penjualan.

   Test di berkas ini yang menahan penggabungan itu kembali.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

type Balances = { usdcBaseUnits: number; idrxBaseUnits: number | null } | null;

/** Saldo yang JELAS di bawah ambang alarm (ambangnya = 3 pack × harga pack maksimum). */
const USDC_KERING = 1_000_000; // $1
/** Saldo yang jelas AMAN, supaya test "tidak ada alarm" tidak lulus karena kebetulan. */
const USDC_AMAN = TREASURY_MAX_PACK_PRICE_USDC * 100;

function buat(opts: { swapEnabled: boolean; balances: Balances }) {
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const swap = { sweep: jest.fn() };
  const gacha = {
    treasuryBalances: jest.fn().mockResolvedValue(opts.balances),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'TREASURY_SWAP_SCHEDULER_ENABLED'
        ? opts.swapEnabled
          ? '1'
          : '0'
        : undefined,
    ),
  };

  const s = new TreasurySwapScheduler(
    swap as never,
    gacha as never,
    config as never,
  );
  // Logger-nya privat & readonly; test ini memang memeriksa APA YANG DITERIAKKAN, jadi ia
  // disuntik apa adanya alih-alih memata-matai console global yang dipakai suite lain.
  (s as unknown as { logger: typeof logger }).logger = logger;

  return { s, swap, gacha, config, logger };
}

const panggilan = (m: jest.Mock): unknown[][] => m.mock.calls as unknown[][];

/** Semua yang diteriakkan, digabung — alarm boleh lewat warn maupun error. */
const teriakan = (logger: {
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
}): string =>
  [
    ...panggilan(logger.warn),
    ...panggilan(logger.error),
    ...panggilan(logger.log),
  ]
    .map((c) => String(c[0]))
    .join('\n');

/**
 * Jalankan satu putaran LEWAT TIMER-nya, bukan dengan memanggil `sweep()` langsung.
 *
 * Perbedaannya bukan gaya. Bug yang dijaga berkas ini hidup di `onModuleInit` — ia `return`
 * sebelum timer sempat dipasang. Test yang memanggil `sweep()` sendiri MELEWATI persis bagian
 * yang rusak itu dan tetap hijau walau bug-nya dikembalikan. (Versi pertama test ini begitu, dan
 * mutasinya yang menunjukkannya.) Menempuh timer berarti: tidak ada timer → tidak ada putaran →
 * tidak ada alarm → merah, sebagaimana mestinya.
 */
async function satuPutaran(s: TreasurySwapScheduler) {
  // Tidak ada timer = tidak akan pernah ada putaran, dan setiap pemeriksaan sesudahnya akan
  // "lulus karena tidak terjadi apa-apa". Digagalkan di sini, dengan sebab yang jelas.
  expect(
    (s as unknown as { timer: NodeJS.Timeout | null }).timer,
  ).not.toBeNull();
  jest.advanceTimersByTime(DEFAULT_INTERVAL_MS);
  // `sweep` async: lepaskan microtask-nya (bacaan saldo + alarm) sebelum diperiksa.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Sama dengan DEFAULT_INTERVAL_MS di scheduler-nya (konstanta privat di sana). */
const DEFAULT_INTERVAL_MS = 300_000;

describe('scheduler treasury: alarm saldo terpisah dari auto-swap', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('auto-swap DORMAN', () => {
    it('timer TETAP dipasang — scheduler tidak lagi pulang lebih awal', () => {
      const { s } = buat({
        swapEnabled: false,
        balances: { usdcBaseUnits: USDC_AMAN, idrxBaseUnits: 0 },
      });
      s.onModuleInit();
      expect(
        (s as unknown as { timer: NodeJS.Timeout | null }).timer,
      ).not.toBeNull();
      s.onModuleDestroy();
    });

    it('log pembukanya menyatakan alarm TETAP jalan — kalau tidak, orang mengira monitoringnya ikut mati', () => {
      const { s, logger } = buat({
        swapEnabled: false,
        balances: { usdcBaseUnits: USDC_AMAN, idrxBaseUnits: 0 },
      });
      s.onModuleInit();
      expect(teriakan(logger)).toMatch(/ALARM SALDO TETAP JALAN/i);
      s.onModuleDestroy();
    });

    /* ── INI TEST INTINYA ──────────────────────────────────────────────────────────────────
       Saldo kering + auto-swap mati = persis keadaan "float dikelola manual" yang dulu
       tidak menghasilkan satu pun peringatan. */
    it('saldo USDC menipis TETAP berteriak walau swap dimatikan', async () => {
      const { s, logger } = buat({
        swapEnabled: false,
        balances: { usdcBaseUnits: USDC_KERING, idrxBaseUnits: 0 },
      });
      s.onModuleInit();
      await satuPutaran(s);
      expect(teriakan(logger)).toMatch(/ALARM USDC/);
      s.onModuleDestroy();
    });

    it('TIDAK memanggil swap.sweep() — melewatinya bukan optimasi, sweep menulis kunci dan bisa mengirim transaksi', async () => {
      const { s, swap } = buat({
        swapEnabled: false,
        balances: { usdcBaseUnits: USDC_KERING, idrxBaseUnits: 0 },
      });
      s.onModuleInit();
      await satuPutaran(s);
      expect(swap.sweep).not.toHaveBeenCalled();
      s.onModuleDestroy();
    });

    it('IDRX yang menumpuk selama swap mati ikut dilaporkan', async () => {
      const { s, logger } = buat({
        swapEnabled: false,
        // 50 juta rupiah dalam base unit IDRX (2 desimal).
        balances: { usdcBaseUnits: USDC_AMAN, idrxBaseUnits: 50_000_000 * 100 },
      });
      s.onModuleInit();
      await satuPutaran(s);
      expect(teriakan(logger)).toMatch(/ALARM IDRX/);
      s.onModuleDestroy();
    });
  });

  describe('auto-swap AKTIF', () => {
    it('swap dijalankan DAN saldo tetap diperiksa', async () => {
      const { s, swap, gacha } = buat({
        swapEnabled: true,
        balances: { usdcBaseUnits: USDC_AMAN, idrxBaseUnits: 0 },
      });
      swap.sweep.mockResolvedValue({ outcome: 'NOTHING_TO_DO' });
      s.onModuleInit();
      await satuPutaran(s);
      expect(swap.sweep).toHaveBeenCalledTimes(1);
      expect(gacha.treasuryBalances).toHaveBeenCalledTimes(1);
      s.onModuleDestroy();
    });
  });

  /* Saldo yang TIDAK DIKETAHUI bukan saldo nol. Mengarang alarm dari kegagalan baca akan
     melatih orang mengabaikan alarm — dan alarm yang diabaikan sama dengan tidak ada. */
  it('saldo tidak terbaca → TIDAK mengarang alarm', async () => {
    const { s, logger } = buat({ swapEnabled: false, balances: null });
    s.onModuleInit();
    await satuPutaran(s);
    expect(teriakan(logger)).not.toMatch(/ALARM USDC|ALARM IDRX/);
    s.onModuleDestroy();
  });
});
