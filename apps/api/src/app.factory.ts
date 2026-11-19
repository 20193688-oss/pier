import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ValidationError } from 'class-validator';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from '@/app.module';
import { ApiError } from '@/common/api-error';
import type { AppConfig } from '@/config/env';

/** Every field problem of a validation, as `path: message` lines. */
export function flattenValidation(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((m) =>
      m.startsWith(e.property) ? (prefix ? `${prefix}.${m}` : m) : `${path}: ${m}`,
    );
    return [...own, ...flattenValidation(e.children ?? [], path)];
  });
}

/** The HTTP app with everything a request goes through, in every environment and test. */
export async function createApp(
  config: AppConfig,
  options: { logger?: false } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger: options.logger === false ? false : ['log', 'warn', 'error'],
    bodyParser: true,
  });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '256kb' });
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.webOrigins,
    credentials: true,
    allowedHeaders: [
      'content-type',
      'authorization',
      'pedospe-organization',
      'pedospe-tier',
      'x-payer-token',
    ],
    exposedHeaders: ['retry-after'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => ApiError.validation(flattenValidation(errors)),
    }),
  );
  app.enableShutdownHooks();
  return app;
}
