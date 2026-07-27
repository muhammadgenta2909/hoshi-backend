import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class MarketMessageDto {
  @ApiProperty({ description: 'Isi pesan' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}
