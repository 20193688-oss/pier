import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  deployLocalMarket,
  freePort,
  migrate,
  startAnvil,
  startEmbeddedPostgres,
  type LocalDeployment,
} from '@/dev/index';

/**
 * Once per e2e run: a real Postgres (embedded, in a temp dir), a real EVM
 * node (anvil, chain 31337) with `P2PMarket` and the test dollar deployed,
 * and the migrations applied. Each test file boots the HTTP app against them
 * (`test/e2e/harness.ts`).
 */
export interface E2eInfra {
  databaseUrl: string;
  rpcUrl: string;
  deployment: LocalDeployment;
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
  const anvil = await startAnvil({ port: await freePort() });
  try {
    migrate(pg.databaseUrl);
    const deployment = await deployLocalMarket(anvil.rpcUrl);
    project.provide('infra', { databaseUrl: pg.databaseUrl, rpcUrl: anvil.rpcUrl, deployment });
  } catch (err) {
    await anvil.stop();
    await pg.stop();
    throw err;
  }
  return async () => {
    await anvil.stop();
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
