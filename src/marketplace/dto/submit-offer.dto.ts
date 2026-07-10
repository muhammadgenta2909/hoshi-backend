import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { IDRX_MAX } from '../marketplace.constants';

/**
 * Payload penawaran (POST /marketplace/:id/offer). Identitas pembuat offer
 * di-set server-side dari JWT — dulu client mengirim `user: "You"`, yang bikin
 * offer tidak bisa ditautkan ke siapa pun.
 */
export class SubmitOfferDto {
  @ApiProperty({ example: 2_450_000, description: 'Nominal penawaran (IDRX)' })
  @IsInt()
  @Min(1)
  @Max(IDRX_MAX) // Offer.amount = int4; tanpa batas ini jadi 500, bukan 400.
  amount!: number;
}
