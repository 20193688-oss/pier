import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local infrastructure for development and the e2e tests, from npm packages
 * only: an EVM node (anvil, from `@foundry-rs/anvil-<platform>`) and Postgres
 * (embedded, from `embedded-postgres`). Every process started here is a single
 * PID the caller stops; nothing is ever killed by name.
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

const ANVIL_PACKAGES: Record<string, string> = {
  'win32-x64': '@foundry-rs/anvil-win32-amd64',
  'linux-x64': '@foundry-rs/anvil-linux-amd64',
  'linux-arm64': '@foundry-rs/anvil-linux-arm64',
  'darwin-x64': '@foundry-rs/anvil-darwin-amd64',
  'darwin-arm64': '@foundry-rs/anvil-darwin-arm64',
};

/** The anvil binary of this platform's npm package. */
export function anvilBinary(): string {
  const pkg = ANVIL_PACKAGES[`${process.platform}-${process.arch}`];
  if (!pkg) throw new Error(`No anvil package for ${process.platform}-${process.arch}`);
  const root = dirname(require.resolve(`${pkg}/package.json`));
  return join(root, 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
}

export interface RunningAnvil {
  rpcUrl: string;
  process: ChildProcess;
  stop(): Promise<void>;
}

async function rpcAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts anvil (chain id 31337, the standard dev mnemonic) and waits until it answers. */
export async function startAnvil(options: {
  port: number;
  /** Load and keep chain state here (dev:stack); omitted: a fresh chain. */
  stateFile?: string;
  logFile?: string;
}): Promise<RunningAnvil> {
  const args = [
    '--port',
    String(options.port),
    '--host',
    '127.0.0.1',
    '--chain-id',
    '31337',
    '--accounts',
    '10',
    '--balance',
    '10000',
  ];
  if (options.stateFile) args.push('--state', options.stateFile, '--state-interval', '5');
  const child = spawn(anvilBinary(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (options.logFile) {
    mkdirSync(dirname(options.logFile), { recursive: true });
    const log = createWriteStream(options.logFile, { flags: 'a' });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
  } else {
    child.stdout?.resume();
    child.stderr?.resume();
  }
  const rpcUrl = `http://127.0.0.1:${options.port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`);
    if (await rpcAnswers(rpcUrl)) break;
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error('anvil did not answer in 10 s');
  }
  return {
    rpcUrl,
    process: child,
    stop: () => stopProcess(child),
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
