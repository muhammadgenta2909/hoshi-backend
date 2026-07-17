import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Profil lengkap user yang login' })
  me(@CurrentUser() user: AuthUser) {
    return this.users.getProfile(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Ubah profil sendiri (semua field opsional)' })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  /* --- Alamat pengiriman (redeem kartu fisik) ---
     Rute statis 'me/addresses' SENGAJA dideklarasikan sebelum rute parametrik
     apa pun yang mungkin ditambah kelak — jangan sisipkan ':param' di atasnya. */

  @Get('me/addresses')
  @ApiOperation({ summary: 'Daftar alamat pengiriman sendiri (default dulu)' })
  myAddresses(@CurrentUser() user: AuthUser) {
    return this.users.listAddresses(user.id);
  }

  @Post('me/addresses')
  @ApiOperation({ summary: 'Tambah alamat pengiriman (maks 5)' })
  createAddress(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    return this.users.createAddress(user.id, dto);
  }

  @Delete('me/addresses/:id')
  @ApiOperation({ summary: 'Hapus alamat pengiriman milik sendiri' })
  deleteAddress(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.deleteAddress(user.id, id);
  }
}
