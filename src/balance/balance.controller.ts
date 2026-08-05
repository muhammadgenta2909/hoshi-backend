import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { BalanceService } from './balance.service';
import { WithdrawalService } from './withdrawal.service';
import { RequestWithdrawalDto } from './dto/request-withdrawal.dto';

@ApiTags('balance')
@Controller('balance')
export class BalanceController {
  constructor(
    private readonly balance: BalanceService,
    private readonly withdrawal: WithdrawalService,
  ) {}

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Saldo in-app (Rupiah) user login + 50 mutasi terakhir',
  })
  myBalance(@CurrentUser() user: AuthUser) {
    return this.balance.getBalance(user.id);
  }

  @Post('withdraw')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Minta tarik saldo ke bank/e-wallet. Saldo langsung di-hold; admin transfer manual.',
  })
  requestWithdraw(
    @CurrentUser() user: AuthUser,
    @Body() dto: RequestWithdrawalDto,
  ) {
    return this.withdrawal.request(user.id, dto);
  }

  @Get('withdrawals')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Riwayat penarikan saldo user login' })
  myWithdrawals(@CurrentUser() user: AuthUser) {
    return this.withdrawal.listMine(user.id);
  }
}
