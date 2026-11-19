/**
 * `npm run dev:stack`: a whole local market with one command.
 *
 *   1. Postgres: docker compose when the Docker daemon answers, else an
 *      embedded Postgres from npm (never starts Docker itself).
 *   2. A local EVM node (anvil from npm), chain id 31337, funded dev wallets.
 *   3. P2PMarket and a mintable test dollar deployed (first run, or --reset).
 *   4. The API (matcher, indexer, expiry and webhook jobs on), seeded through
 *      its own routes: a merchant with liquidity, offers and payment methods,
 *      a business with a test API key and a charge.
 *   5. The web app, when apps/web exists and has a `dev` script.
 *
 * Chain state and the database persist in .dev-stack/ between runs (a
 * restart resumes); `--reset` starts over. Stop with Ctrl+C, or from another
 * terminal with `npm run dev:stack -- --stop`. Only the processes started here
 * are stopped, each by its own PID.
 *
 * Flags: --reset, --stop, --no-web, --no-build.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalDeployment, SeedResult } from '@pedospe/api/dev';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(ROOT, '.dev-stack');
const STOP_FILE = join(STATE_DIR, 'stop');
const STACK_FILE = join(STATE_DIR, 'stack.json');
const API_PORT = 4000;
const RPC_PORT = 8545;
const PG_PORT = 54329;
const WEB_ORIGIN = 'http://localhost:3000';

const flags = new Set(process.argv.slice(2));

interface StackState {
  deployment: LocalDeployment;
  dataEncryptionKey: string;
  seed: SeedResult;
}

function log(message: string): void {
  console.log(`[dev-stack] ${message}`);
}

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 8_000,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

async function portFree(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitFor(url: string, seconds: number): Promise<void> {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not answer in ${seconds}s`);
}

/** Pipes a child's output to the console with a prefix and to a log file. */
function pipeOutput(child: ChildProcess, name: string): void {
  const file = createWriteStream(join(STATE_DIR, `${name}.log`), { flags: 'a' });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      file.write(chunk);
      for (const line of chunk.toString().split(/\r?\n/))
        if (line.trim()) console.log(`[${name}] ${line}`);
    });
  }
}

/** Stops a child we started: its own PID (and, on Windows, the tree under that PID). */
function stopChild(child: ChildProcess | undefined, tree: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid)
      return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    if (tree && process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  });
}

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  if (flags.has('--stop')) {
    writeFileSync(STOP_FILE, String(Date.now()));
    log('asked the running stack to stop');
    return;
  }
  rmSync(STOP_FILE, { force: true });

  if (!flags.has('--no-build')) {
    log('building contracts and API');
    run('npm', ['run', 'build', '-w', '@pedospe/contracts', '-w', '@pedospe/api']);
  }
  const dev = await import('@pedospe/api/dev');

  for (const [port, what] of [
    [API_PORT, 'the API'],
    [RPC_PORT, 'the EVM node'],
  ] as const) {
    if (!(await portFree(port)))
      throw new Error(`port ${port} (${what}) is in use: stop whatever holds it first`);
  }

  const reset = flags.has('--reset');
  if (reset) {
    log('--reset: starting over');
    rmSync(join(STATE_DIR, 'anvil-state.json'), { force: true });
    rmSync(STACK_FILE, { force: true });
  }

  // --- Postgres ---------------------------------------------------------------
  let databaseUrl: string;
  let stopPostgres: () => Promise<void>;
  if (dockerAvailable()) {
    log('Postgres: docker compose (the Docker daemon answered)');
    run('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d', '--wait', 'postgres']);
    databaseUrl = `postgresql://pedospe:pedospe@127.0.0.1:${PG_PORT}/pedospe`;
    stopPostgres = async () =>
      run('docker', ['compose', '-f', 'docker-compose.dev.yml', 'stop', 'postgres']);
  } else {
    log('Postgres: embedded (no Docker daemon answered; Docker is never started from here)');
    if (!(await portFree(PG_PORT))) throw new Error(`port ${PG_PORT} (Postgres) is in use`);
    const pg = await dev.startEmbeddedPostgres({
      dataDir: join(STATE_DIR, 'pg'),
      port: PG_PORT,
      database: 'pedospe',
      persistent: true,
    });
    databaseUrl = pg.databaseUrl;
    stopPostgres = pg.stop;
  }

  // --- the chain ------------------------------------------------------------------
  log(`EVM node: anvil on ${RPC_PORT} (chain id 31337)`);
  const anvil = await dev.startAnvil({
    port: RPC_PORT,
    stateFile: join(STATE_DIR, 'anvil-state.json'),
    logFile: join(STATE_DIR, 'anvil.log'),
  });
  const rpcUrl = anvil.rpcUrl;

  let api: ChildProcess | undefined;
  let web: ChildProcess | undefined;
  let stopping = false;
  let watcher: NodeJS.Timeout | undefined;
  const shutdown = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${reason})`);
    await stopChild(web, true);
    await stopChild(api, false);
    await anvil.stop();
    await stopPostgres().catch((err: unknown) => log(`Postgres stop: ${String(err)}`));
    rmSync(STOP_FILE, { force: true });
    if (watcher) clearInterval(watcher);
    log('stopped');
    // Everything started here is stopped: let the event loop drain.
    process.exitCode = code;
  };
  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    let state: StackState | null = existsSync(STACK_FILE)
      ? (JSON.parse(readFileSync(STACK_FILE, 'utf8')) as StackState)
      : null;
    const client = await dev.devPublicClient(rpcUrl);
    if (state && (await client.getCode({ address: state.deployment.market })) === undefined) {
      log('the saved chain state has no market (state file lost): starting over');
      state = null;
    }
    const fresh = state === null;
    if (fresh) {
      log('resetting the database');
      await dev.resetDatabase(databaseUrl);
    }
    dev.migrate(databaseUrl);

    const deployment = state?.deployment ?? (await dev.deployLocalMarket(rpcUrl));
    if (fresh)
      log(
        `deployed P2PMarket ${deployment.market} and ${deployment.tokenSymbol} ${deployment.token}`,
      );
    const dataEncryptionKey = state?.dataEncryptionKey ?? randomBytes(32).toString('hex');
    const env = dev.localApiEnv({
      port: API_PORT,
      databaseUrl,
      rpcUrl,
      deployment,
      dataEncryptionKey,
      webOrigin: WEB_ORIGIN,
    });
    writeFileSync(
      join(STATE_DIR, 'api.env'),
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );

    log(`API on http://localhost:${API_PORT}`);
    api = spawn(process.execPath, [join(ROOT, 'apps', 'api', 'dist', 'main.js')], {
      cwd: join(ROOT, 'apps', 'api'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    pipeOutput(api, 'api');
    await waitFor(`http://localhost:${API_PORT}/health`, 60);

    let seed: SeedResult;
    if (fresh || !state) {
      log('seeding through the API');
      seed = await dev.seedDevMarket({
        apiUrl: `http://localhost:${API_PORT}`,
        rpcUrl,
        siweDomain: new URL(WEB_ORIGIN).host,
        webOrigin: WEB_ORIGIN,
        checkoutUrl: `${WEB_ORIGIN}/pay`,
        deployment,
      });
      state = { deployment, dataEncryptionKey, seed };
      writeFileSync(STACK_FILE, JSON.stringify(state, null, 2));
    } else {
      seed = state.seed;
      const n = await dev.refreshDevPrices(
        `http://localhost:${API_PORT}`,
        WEB_ORIGIN,
        seed.merchant.apiKey,
      );
      log(`resumed; refreshed ${n} offer prices`);
    }

    const webPackage = join(ROOT, 'apps', 'web', 'package.json');
    const webDev =
      existsSync(webPackage) &&
      Boolean(
        (JSON.parse(readFileSync(webPackage, 'utf8')) as { scripts?: Record<string, string> })
          .scripts?.dev,
      );
    if (flags.has('--no-web')) {
      log('web app: skipped (--no-web)');
    } else if (!webDev) {
      log('web app: skipped (apps/web has no dev script here)');
    } else {
      log(`web app on ${WEB_ORIGIN}`);
      const apiUrl = `http://localhost:${API_PORT}`;
      web = spawn('npm', ['run', 'dev'], {
        cwd: join(ROOT, 'apps', 'web'),
        env: {
          ...process.env,
          PORT: '3000',
          API_URL: apiUrl,
          PUBLIC_API_URL: apiUrl,
          PUBLIC_PEDOSPE_API_URL: apiUrl,
          NEXT_PUBLIC_API_URL: apiUrl,
          VITE_API_URL: apiUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      pipeOutput(web, 'web');
    }

    const wallets = dev.devWallets();
    const lines = [
      '',
      '================ pedospe dev stack ================',
      `API            http://localhost:${API_PORT}   (OpenAPI: /v1/openapi.json)`,
      `Market         http://localhost:${API_PORT}/v1/market?tier=test`,
      `Web app        ${webDev && !flags.has('--no-web') ? WEB_ORIGIN : '(not started)'}`,
      `Charge page    ${seed.charge.url}`,
      `EVM node       ${rpcUrl}   chain id 31337`,
      `P2PMarket      ${deployment.market}`,
      `Test dollar    ${deployment.token} (${deployment.tokenSymbol}, ${deployment.tokenDecimals} decimals)`,
      '',
      'API keys (test tier):',
      `  merchant  ${seed.merchant.apiKey}`,
      `  business  ${seed.business.apiKey}`,
      '',
      'Dev wallets (DEV CHAIN ONLY: these keys are public, never use them elsewhere):',
      ...wallets.map((w) => `  ${w.role.padEnd(9)} ${w.address}  ${w.privateKey}`),
      '',
      'Browser wallet: add a network with RPC http://127.0.0.1:8545 and chain id 31337,',
      'then import the "user" private key above (it holds test dollars and ETH).',
      '',
      'Simulate a bank transfer for an order:',
      '  npm run dev:simulate -- <orderId>',
      '',
      'Stop: Ctrl+C here, or `npm run dev:stack -- --stop` from another terminal.',
      '===================================================',
      '',
    ];
    console.log(lines.join('\n'));

    watcher = setInterval(() => {
      if (existsSync(STOP_FILE)) void shutdown('stop requested');
      if (api && api.exitCode !== null) void shutdown(`the API exited with ${api.exitCode}`, 1);
    }, 1_000);
  } catch (err) {
    console.error(err);
    await shutdown('error', 1);
  }
}

void main();
