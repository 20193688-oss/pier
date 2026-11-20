import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local infrastructure for development and the e2e tests: Postgres (embedded,
 * from `embedded-postgres`) and, when a Docker daemon already answers, the
 * local Stellar network (`stellar container start local`). Every process
 * started here is a single PID the caller stops; nothing is ever killed by name.
 */

const require = createRequire(import.meta.url);

/** This package's root (`apps/api`), from `src/dev` or `dist/dev`. */
export const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A free TCP port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Whether a Docker daemon answers (never starts one). */
export function dockerAnswers(): boolean {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 8_000,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  return result.status === 0;
}

export interface RunningLocalStellar {
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  stop(): void;
}

/** The quickstart network's passphrase. */
export const LOCAL_PASSPHRASE = 'Standalone Network ; February 2017';

/**
 * Starts the local Stellar network (`stellar container start local`, the
 * stellar/quickstart image) and waits until its RPC answers the standalone
 * passphrase and friendbot funds. Only when a Docker daemon already answers:
 * Docker itself is never started from here.
 */
export async function startLocalStellar(port = 8000): Promise<RunningLocalStellar> {
  if (!dockerAnswers()) throw new Error('no Docker daemon answers: the local network needs one');
  const run = (args: string[]) =>
    spawnSync('stellar', args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
  const started = run(['container', 'start', 'local', '--ports-mapping', `${port}:8000`]);
  if (started.status !== 0) throw new Error('stellar container start local failed');
  const base = `http://localhost:${port}`;
  const rpcUrl = `${base}/rpc`;
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
      });
      const body = (await res.json()) as { result?: { passphrase?: string } };
      if (body.result?.passphrase === LOCAL_PASSPHRASE) {
        const friendbot = await fetch(`${base}/friendbot`);
        if (friendbot.status < 500) break;
      }
    } catch {
      // not up yet
    }
    if (i === 299) throw new Error('the local Stellar network did not come up in 5 minutes');
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return {
    rpcUrl,
    horizonUrl: base,
    friendbotUrl: `${base}/friendbot`,
    stop: () => void run(['container', 'stop', 'local']),
  };
}

/** Stops one child process (its own PID only) and waits for it to exit. */
export function stopProcess(child: ChildProcess, graceMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export interface RunningPostgres {
  databaseUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts an embedded Postgres in `dataDir` (initialising it when empty) and
 * creates `database`. The cluster's data stays in `dataDir` when `persistent`.
 */
export async function startEmbeddedPostgres(options: {
  dataDir: string;
  port: number;
  database: string;
  persistent: boolean;
}): Promise<RunningPostgres> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const user = 'pedospe';
  const password = 'pedospe';
  const fresh = !existsSync(join(options.dataDir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: options.dataDir,
    port: options.port,
    user,
    password,
    persistent: options.persistent,
    onLog: () => undefined,
    onError: () => undefined,
  });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) {
    await pg.createDatabase(options.database);
  } else {
    await pg.createDatabase(options.database).catch(() => undefined);
  }
  return {
    databaseUrl: `postgresql://${user}:${password}@127.0.0.1:${options.port}/${options.database}`,
    stop: () => pg.stop(),
  };
}

/** Applies the committed migrations (`prisma migrate deploy`) to a database. */
export function migrate(databaseUrl: string): void {
  const cli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/** Drops every table of a dev database (`public` schema), before migrating it again. */
export async function resetDatabase(databaseUrl: string): Promise<void> {
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  } finally {
    await db.end();
  }
}
