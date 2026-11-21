import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '@/app.factory';
import { loadConfig } from '@/config/env';
import { buildOpenApi } from '@/openapi/document';

/**
 * Writes `apps/api/openapi.json` from the controllers' decorators. Needs no
 * database or chain: the app is created, never started.
 *
 *   npm run build -w @pier/api && npm run openapi -w @pier/api
 */
async function main(): Promise<void> {
  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
    DATA_ENCRYPTION_KEY: '00'.repeat(32),
    JOBS_ENABLED: 'false',
  });
  const app = await createApp(config, { logger: false });
  const document = buildOpenApi(app);
  const target = fileURLToPath(new URL('../../openapi.json', import.meta.url));
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  const operations = Object.values(document.paths).reduce(
    (n, item) => n + Object.keys(item as object).length,
    0,
  );
  console.log(
    `Wrote ${target}: ${Object.keys(document.paths).length} paths, ${operations} operations`,
  );
  await app.close();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
