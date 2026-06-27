import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Guard untuk route yang butuh JWT valid (Authorization: Bearer <token>). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
