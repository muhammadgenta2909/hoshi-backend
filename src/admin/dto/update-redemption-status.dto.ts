import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { RedemptionStatus } from '@prisma/client';

/** Body PATCH /admin/redemptions/:id/status — majukan status kirim kartu fisik. */
export class UpdateRedemptionStatusDto {
  @ApiProperty({ enum: RedemptionStatus })
  @IsEnum(RedemptionStatus)
  status!: RedemptionStatus;
}
