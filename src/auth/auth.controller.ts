import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthUser } from './jwt.strategy';
import { LoginDto } from './dto/login.dto';
import { NonceRequestDto } from './dto/nonce.dto';

@ApiTags('auth')
// Lebih ketat dari default global: 10 request / menit / IP untuk endpoint auth.
@Throttle({ default: { ttl: 60000, limit: 10 } })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('nonce')
  @ApiOperation({
    summary: 'Step 1: request nonce + message for wallet signing',
  })
  requestNonce(@Body() dto: NonceRequestDto) {
    return this.auth.requestNonce(dto.walletAddress);
  }

  @Post('login')
  @ApiOperation({ summary: 'Step 2: submit signature → get JWT' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.walletAddress, dto.signature);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Profil user dari JWT' })
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
