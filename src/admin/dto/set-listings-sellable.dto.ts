import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
} from 'class-validator';

/**
 * Body POST /admin/listings/sellable — naikkan/turunkan flag `sellable` pada baris yang SUDAH ADA.
 *
 * SENGAJA TIDAK ADA MODE "SEMUA BARIS". Seluruh guna flag ini adalah menahan baris seed/
 * placeholder, dan bentuk baris seed IDENTIK dengan bentuk stok sungguhan (`source=HOSHI` +
 * `sellerId=null` adalah bentuk DEFAULT setiap listing). Jadi tidak ada predikat otomatis yang
 * bisa membedakan "kartu fisik yang ada di rak" dari "chart filler" — sebuah sapuan massal akan
 * membuka kembali persis bahaya yang default `false` diciptakan untuk menutup.
 */
export class SetListingsSellableDto {
  @ApiProperty({
    description:
      'Id listing yang mau diubah — EKSPLISIT, maksimal 500 per panggilan. Lihat dulu ' +
      'GET /admin/listings/unsellable untuk tahu baris mana yang terdampak.',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  ids!: string[];

  @ApiProperty({
    description:
      'true = baris ini BISA DIBELI (stok fisik Hoshi yang nyata). false = tidak bisa dibeli ' +
      '(pembatalan kalau salah tandai). Reversibel dengan sengaja.',
  })
  @IsBoolean()
  sellable!: boolean;
}
