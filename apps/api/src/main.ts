import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from '@/app.factory';
import { ConfigError, loadConfig } from '@/config/env';
import { buildOpenApi } from '@/openapi/document';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const app = await createApp(config);
  // The contract, public: what the SDK is generated from.
  const document = buildOpenApi(app);
  app
    .getHttpAdapter()
    .get('/v1/openapi.json', (_req: unknown, res: { json(body: unknown): void }) =>
      res.json(document),
    );
  await app.listen(config.port, config.host);
  new Logger('pedospe').log(`API listening on ${config.publicApiUrl} (${config.nodeEnv})`);
}

void main();
