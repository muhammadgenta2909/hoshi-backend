import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateContactMessageDto {
  @ApiPropertyOptional() @IsOptional() @IsString()
  listingId?: string;

  @ApiProperty() @IsString()
  listingName!: string;

  @ApiProperty() @IsString() @MinLength(1)
  senderName!: string;

  @ApiProperty() @IsEmail()
  senderEmail!: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  phone?: string;

  @ApiProperty() @IsString() @MinLength(1)
  text!: string;
}

export class QueryAdminMessagesDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter: read | unread' })
  @IsOptional() @IsString()
  status?: string;
}

export class MarkMessageReadDto {
  @ApiProperty({ default: true })
  @IsBoolean()
  isRead!: boolean;
}
