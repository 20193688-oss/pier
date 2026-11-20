import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { freePort, migrate, startEmbeddedPostgres } from '@/dev/index';

/**
 * Once per e2e run: a real Postgres (embedded, in a temp dir) with the
 * migrations applied from scratch. The wiring suites need no network: each
 * file boots the HTTP app with a fake chain (`test/e2e/harness.ts`).
 */
export interface E2eInfra {
  databaseUrl: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    infra: E2eInfra;
  }
}

export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'pedospe-e2e-'));
  const pg = await startEmbeddedPostgres({
    dataDir: join(dir, 'pg'),
    port: await freePort(),
    database: 'pedospe',
    persistent: false,
  });
  try {
    migrate(pg.databaseUrl);
    project.provide('infra', { databaseUrl: pg.databaseUrl });
  } catch (err) {
    await pg.stop();
    throw err;
  }
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
