import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * Admin activate/deactivate a listing. Only ACTIVE (live on the marketplace) and
 * CANCELLED (hidden) are valid targets — SOLD is terminal and set by a purchase,
 * never toggled here, so it is intentionally NOT an allowed value.
 */
export class SetListingStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'CANCELLED'] })
  @IsIn(['ACTIVE', 'CANCELLED'], {
    message: 'status hanya boleh ACTIVE atau CANCELLED',
  })
  status!: 'ACTIVE' | 'CANCELLED';
}
