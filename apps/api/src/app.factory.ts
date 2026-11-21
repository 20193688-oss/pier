import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ValidationError } from 'class-validator';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule, type AppOverrides } from '@/app.module';
import { ApiError } from '@/common/api-error';
import type { AppConfig } from '@/config/env';
import { ORDER_CHAT_BODY_LIMIT, isOrderMessagePost } from '@/p2p/domain/order-chat';

/** Every JSON body but an order message's: 256 kB. */
export const JSON_BODY_LIMIT = '256kb';

/** A JSON body, as body-parser's default `application/json` type reads it. */
function isJson(req: IncomingMessage): boolean {
  const type = req.headers['content-type'] ?? '';
  return type.split(';')[0].trim().toLowerCase() === 'application/json';
}

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
  options: { logger?: false; overrides?: AppOverrides } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, options.overrides),
    {
      logger: options.logger === false ? false : ['log', 'warn', 'error'],
      bodyParser: true,
    },
  );
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  // Two JSON parsers, each for its own requests: order messages up to ORDER_CHAT_BODY_LIMIT,
  // everything else up to JSON_BODY_LIMIT (a larger body is a 413).
  app.useBodyParser('json', {
    limit: ORDER_CHAT_BODY_LIMIT,
    type: (req: IncomingMessage) => isJson(req) && isOrderMessagePost(req),
  });
  app.useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
    type: (req: IncomingMessage) => isJson(req) && !isOrderMessagePost(req),
  });
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.webOrigins,
    credentials: true,
    allowedHeaders: [
      'content-type',
      'authorization',
      'midpoint-organization',
      'midpoint-tier',
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
