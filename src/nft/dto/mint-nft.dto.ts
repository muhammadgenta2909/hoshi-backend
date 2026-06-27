import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class MintNftDto {
  @ApiProperty({ description: 'ID card yang akan di-mint jadi NFT' })
  @IsString()
  cardId!: string;
}
