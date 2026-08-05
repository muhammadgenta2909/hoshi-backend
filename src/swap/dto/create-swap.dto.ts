import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body untuk POST /swaps — ajukan tukar kartu ke kolektor lain.
 *
 * Kartu yang ditawarkan (nftAddress) diverifikasi kepemilikannya di service. `recipientMethod`
 * dibatasi ke tiga cara kontak yang didukung UI. Tidak ada nominal/uang.
 */
export class CreateSwapDto {
  @ApiProperty({ description: 'Alamat NFT kartu (hasil pack) yang mau ditawarkan tukar' })
  @IsString()
  @IsNotEmpty()
  offeredNftAddress!: string;

  @ApiProperty({
    description: 'Cara menghubungi kolektor lawan',
    enum: ['wallet', 'email', 'sns'],
  })
  @IsIn(['wallet', 'email', 'sns'])
  recipientMethod!: 'wallet' | 'email' | 'sns';

  @ApiProperty({ description: 'Nilai tujuan (wallet address / email / SNS domain)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  recipientValue!: string;
}
