import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class AdminGuard extends JwtAuthGuard {
  handleRequest<TUser extends { role?: string }>(
    err: Error | null,
    user: TUser | false,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    const u = super.handleRequest<TUser>(err, user, info, context);
    if (u && u.role === 'ADMIN') return u;
    throw new ForbiddenException('Akses ditolak: bukan admin.');
  }
}
