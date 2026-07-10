/**
 * Batas atas nilai IDRX yang boleh masuk DTO. `priceIdrx`, `expectedValueIdrx`,
 * dan `buybackIdrx` bertipe Prisma `Int` = Postgres int4. Tanpa batas ini nilai
 * yang lebih besar lolos validasi lalu meledak di driver sebagai 500, bukan 400.
 */
export const IDRX_MAX = 2_147_483_647;
