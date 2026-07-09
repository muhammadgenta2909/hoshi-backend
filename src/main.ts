import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // Semua route diawali /api → GET /api/health, POST /api/auth/login, dst.
  app.setGlobalPrefix('api');

  // CORS untuk frontend (boleh banyak origin, dipisah koma).
  const origins = (
    config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  // Validasi + sanitasi semua DTO secara global.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Serve uploaded files statically
  app.useStaticAssets(join(__dirname, '..', 'uploads'), { prefix: '/uploads' });

  // Map error Prisma (P2002/P2003/P2025) ke HTTP status yang benar (bukan 500).
  app.useGlobalFilters(new PrismaExceptionFilter());

  // Tutup koneksi Prisma dengan rapi saat SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // Swagger / OpenAPI di /docs — biar frontend gampang lihat kontrak API.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Hoshi Backend API')
    .setDescription(
      'Phase 3 — Backend Foundation (NestJS + Prisma + Solana devnet)',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = config.get<number>('PORT') ?? 3001;
  // Bind 0.0.0.0 so cloud hosts (Railway/Render) can route to the container.
  await app.listen(port, '0.0.0.0');
  console.log(
    `🚀 Hoshi backend running on http://localhost:${port} (docs: /docs)`,
  );
}
void bootstrap();
