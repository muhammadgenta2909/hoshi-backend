import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// Global → semua module bisa inject PrismaService tanpa import ulang.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
