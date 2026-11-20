/**
 * Builds the P2PMarket Soroban contract (contracts/p2p-market) and writes its
 * wasm, hash and interface spec to src/p2p-market.artifact.ts, which is
 * committed and reviewed like code.
 *
 *   npm run compile -w @pedospe/contracts
 *
 * Deployments are checked against MARKET_WASM_HASH, so a changed contract is a
 * new artifact and a new deployment; `test/artifact.test.ts` rebuilds the
 * contract with this same pipeline and fails if the two disagree. Never edit
 * the artifact by hand.
 *
 * The pipeline is `cargo build --release --locked --target wasm32v1-none`
 * under the toolchain pinned in rust-toolchain.toml, then spec shaking.
 * soroban-sdk 28+ leaves shaking to the build system (stellar-cli 25.2+ does
 * it in `stellar contract build`): the SDK writes a spec entry for every type
 * and event it compiles, plus a 14-byte marker ("SpEcV1" + 8 bytes of the
 * entry's SHA-256) in the data section for each one the contract really uses
 * at its boundary. This script is that build system: it sets the SDK's
 * `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2` flag and then applies
 * `soroban_spec::shaking::filter` (keep every function; keep any other entry
 * only when its marker is in a data segment) to the `contractspecv0` section,
 * rewriting that one custom section in place.
 *
 * This module only defines functions; it builds when run as a script.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdr } from '@stellar/stellar-sdk';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CRATE = 'p2p-market';
export const TARGET = 'wasm32v1-none';
/** Where cargo writes the unshaken wasm. */
export const CARGO_WASM = join(ROOT, 'target', TARGET, 'release', 'p2p_market.wasm');
/** Where the final (shaken) wasm is written, for `stellar contract deploy --wasm`. */
export const FINAL_WASM = join(ROOT, 'target', 'p2p-market.wasm');
export const ARTIFACT = join(ROOT, 'src', 'p2p-market.artifact.ts');

const SPEC_SECTION = 'contractspecv0';
const MARKER_MAGIC = Buffer.from('SpEcV1', 'latin1');
const MARKER_LEN = 14;

interface CargoMetadata {
  workspace_root: string;
  workspace_members: string[];
  packages: { id: string; name: string; version: string; manifest_path: string }[];
}

/** The crates compiled into the wasm: normal dependencies, minus proc macros and theirs. */
function linkedCrates(): Set<string> {
  const tree = execFileSync(
    'cargo',
    ['tree', '--locked', '-e', 'normal', '--target', TARGET, '--package', CRATE].concat([
      '--prefix',
      'depth',
      '--format',
      '{p}',
      '--no-dedupe',
    ]),
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const linked = new Set<string>();
  let skipBelow = -1;
  for (const line of tree.split(/\r?\n/)) {
    const m = /^(\d+)(\S+) v(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const depth = Number(m[1]);
    if (skipBelow >= 0 && depth > skipBelow) continue;
    skipBelow = -1;
    if (m[4].includes('(proc-macro)')) {
      skipBelow = depth;
      continue;
    }
    linked.add(`${m[2]}@${m[3]}`);
  }
  return linked;
}

/** `dir` and its subdirectories that hold Rust sources. */
function sourceDirs(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const out = entries.some((e) => e.isFile() && e.name.endsWith('.rs')) ? [dir] : [];
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'target' && !e.name.startsWith('.')) {
      out.push(...sourceDirs(join(dir, e.name)));
    }
  }
  return out;
}

/**
 * Panic locations (from `unwrap()` in soroban-sdk, for one) put source paths
 * into the wasm. So every source directory of every crate compiled into the
 * wasm is remapped to `<crate>-<version>/<dir>/` (a workspace member: its path
 * from the workspace root) with forward slashes, and the bytes depend neither
 * on where the checkout or the cargo home is nor on the host's path separator.
 * rustc applies the last matching rule, so deeper directories come later.
 */
export function remapFlags(): string[] {
  const linked = linkedCrates();
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--no-deps'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as CargoMetadata;
  const full = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }),
  ) as CargoMetadata;
  const flags: string[] = [];
  const packages = full.packages
    .filter((p) => linked.has(`${p.name}@${p.version}`))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  if (packages.length !== linked.size) throw new Error('cargo metadata: missing a linked crate');
  for (const pkg of packages) {
    const dir = dirname(pkg.manifest_path);
    const member = meta.workspace_members.includes(pkg.id);
    // cargo hands rustc a workspace member's sources relative to the workspace root
    const from = member ? relative(meta.workspace_root, dir) : dir;
    const name = member
      ? relative(meta.workspace_root, dir).split(sep).join('/')
      : `${pkg.name}-${pkg.version}`;
    for (const sub of sourceDirs(dir)) {
      const rel = relative(dir, sub);
      const to = [name, ...(rel ? rel.split(sep) : [])].join('/');
      flags.push(`--remap-path-prefix=${rel ? join(from, rel) : from}=${to}/`);
    }
  }
  return flags;
}

/** Runs cargo and returns the unshaken release wasm. */
export function cargoBuild(): Buffer {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2: '1',
    // Only these flags: any from the caller's environment would change the bytes.
    CARGO_ENCODED_RUSTFLAGS: remapFlags().join('\x1f'),
  };
  delete env.RUSTFLAGS;
  delete env.CARGO_BUILD_RUSTFLAGS;
  execFileSync(
    'cargo',
    ['build', '--release', '--locked', '--target', TARGET, '--package', CRATE],
    { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const wasm = readFileSync(CARGO_WASM);
  const leaked = hostPaths(wasm);
  if (leaked.length > 0) throw new Error(`wasm: host paths leaked: ${leaked.join(', ')}`);
  return wasm;
}

/** Source paths in the wasm that still carry a backslash, a drive or the cargo home. */
export function hostPaths(wasm: Uint8Array): string[] {
  const text = Buffer.from(wasm).toString('latin1');
  return [...text.matchAll(/[\x20-\x7e]*\.rs\b/g)]
    .map((m) => m[0])
    .filter(
      (p) => p.includes('\\') || /^[A-Za-z]:/.test(p) || p.includes('.cargo') || p.startsWith('/'),
    );
}

// --- wasm sections -------------------------------------------------------------

interface Section {
  id: number;
  /** Offset of the section's first byte (its id) and end of its payload. */
  start: number;
  end: number;
  payloadStart: number;
}

function readU32(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = offset;
  for (;;) {
    const byte = bytes[next++];
    if (byte === undefined) throw new Error('wasm: truncated LEB128');
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next };
    shift += 7;
    if (shift > 28) throw new Error('wasm: LEB128 too long');
  }
}

function writeU32(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return Buffer.from(out);
}

export function sections(wasm: Uint8Array): Section[] {
  const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  if (!Buffer.from(wasm.subarray(0, 8)).equals(header)) throw new Error('not a wasm module');
  const out: Section[] = [];
  let offset = 8;
  while (offset < wasm.length) {
    const start = offset;
    const id = wasm[offset];
    const size = readU32(wasm, offset + 1);
    out.push({ id, start, payloadStart: size.next, end: size.next + size.value });
    offset = size.next + size.value;
  }
  if (offset !== wasm.length) throw new Error('wasm: section overruns the module');
  return out;
}

function customName(wasm: Uint8Array, s: Section): { name: string; dataStart: number } {
  const len = readU32(wasm, s.payloadStart);
  return {
    name: Buffer.from(wasm.subarray(len.next, len.next + len.value)).toString('utf8'),
    dataStart: len.next + len.value,
  };
}

/** The payload of the one custom section called `name`. */
export function customSection(wasm: Uint8Array, name: string): Buffer {
  const found = sections(wasm)
    .filter((s) => s.id === 0)
    .map((s) => ({ s, ...customName(wasm, s) }))
    .filter((c) => c.name === name);
  if (found.length !== 1) throw new Error(`wasm: ${found.length} "${name}" sections`);
  const [{ s, dataStart }] = found;
  return Buffer.from(wasm.subarray(dataStart, s.end));
}

/** Every spec marker in the data segments (`soroban_spec::shaking::find_all`). */
export function markers(wasm: Uint8Array): Set<string> {
  const found = new Set<string>();
  for (const s of sections(wasm).filter((x) => x.id === 11)) {
    let offset = s.payloadStart;
    const count = readU32(wasm, offset);
    offset = count.next;
    for (let i = 0; i < count.value; i++) {
      const flags = readU32(wasm, offset);
      offset = flags.next;
      if (flags.value === 2) offset = readU32(wasm, offset).next; // memory index
      if (flags.value !== 1) {
        // the offset expression: i32.const / i64.const / global.get, then `end`
        const opcode = wasm[offset++];
        if (opcode !== 0x41 && opcode !== 0x42 && opcode !== 0x23) {
          throw new Error(`wasm: unexpected offset expression opcode ${opcode}`);
        }
        while ((wasm[offset] & 0x80) !== 0) offset++; // its LEB128 immediate
        offset++;
        if (wasm[offset++] !== 0x0b) throw new Error('wasm: offset expression without end');
      }
      const size = readU32(wasm, offset);
      const data = Buffer.from(wasm.subarray(size.next, size.next + size.value));
      offset = size.next + size.value;
      for (
        let at = data.indexOf(MARKER_MAGIC);
        at !== -1;
        at = data.indexOf(MARKER_MAGIC, at + 1)
      ) {
        if (at + MARKER_LEN <= data.length) {
          found.add(data.subarray(at, at + MARKER_LEN).toString('hex'));
        }
      }
    }
    if (offset !== s.end) throw new Error('wasm: data section did not parse to its end');
  }
  return found;
}

function markerOf(entryXdr: Uint8Array): string {
  const hash = createHash('sha256').update(entryXdr).digest();
  return Buffer.concat([MARKER_MAGIC, hash.subarray(0, 8)]).toString('hex');
}

/** Splits a spec section into its entries' XDR, checking it re-encodes byte for byte. */
export function specEntries(section: Uint8Array): Buffer[] {
  const entries = xdr.decodeStream(xdr.ScSpecEntry, section).map((e) => Buffer.from(e.toXdr()));
  if (!Buffer.concat(entries).equals(Buffer.from(section))) {
    throw new Error('spec: entries do not re-encode to the section');
  }
  return entries;
}

/**
 * Spec shaking: rewrites `contractspecv0` to keep every function and every
 * other entry whose marker survived in the data section.
 */
export function shake(wasm: Uint8Array): Buffer {
  const used = markers(wasm);
  const all = sections(wasm);
  const spec = all
    .filter((s) => s.id === 0)
    .map((s) => ({ s, ...customName(wasm, s) }))
    .filter((c) => c.name === SPEC_SECTION);
  if (spec.length !== 1) throw new Error(`wasm: ${spec.length} spec sections`);
  const [{ s, dataStart }] = spec;
  const kept = specEntries(wasm.subarray(dataStart, s.end)).filter(
    (entry) =>
      xdr.ScSpecEntry.fromXdr(entry).type === 'scSpecEntryFunctionV0' || used.has(markerOf(entry)),
  );
  const name = Buffer.from(SPEC_SECTION, 'utf8');
  const payload = Buffer.concat([writeU32(name.length), name, ...kept]);
  return Buffer.concat([
    Buffer.from(wasm.subarray(0, s.start)),
    Buffer.from([0]),
    writeU32(payload.length),
    payload,
    Buffer.from(wasm.subarray(s.end)),
  ]);
}

/** The final wasm: a release build, shaken. */
export function buildWasm(): Buffer {
  return shake(cargoBuild());
}

// --- the artifact ----------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The spec's entries as base64 XDR, as consumers pass them to `contract.Spec`. */
export function specBase64(wasm: Uint8Array): string[] {
  return specEntries(customSection(wasm, SPEC_SECTION)).map((e) => e.toString('base64'));
}

/** code -> name, from the spec's error enum. */
export function errorsOf(spec: readonly string[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const b64 of spec) {
    const entry = xdr.ScSpecEntry.fromXdr(b64, 'base64');
    if (entry.type !== 'scSpecEntryUdtErrorEnumV0') continue;
    for (const c of entry.udtErrorEnumV0.cases) out[c.value] = c.name.toString();
  }
  return out;
}

function toolchain(): string {
  const toml = readFileSync(join(ROOT, 'rust-toolchain.toml'), 'utf8');
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(toml);
  if (!channel) throw new Error('rust-toolchain.toml: no channel');
  return channel[1];
}

function sdkVersion(): string {
  const lock = readFileSync(join(ROOT, 'Cargo.lock'), 'utf8');
  const sdk = /name = "soroban-sdk"\r?\nversion = "([^"]+)"/.exec(lock);
  if (!sdk) throw new Error('Cargo.lock: no soroban-sdk');
  return sdk[1];
}

export function artifactSource(wasm: Uint8Array): string {
  const spec = specBase64(wasm);
  const errors = errorsOf(spec);
  const build = {
    crate: CRATE,
    sorobanSdk: sdkVersion(),
    rustc: toolchain(),
    target: TARGET,
    bytes: wasm.length,
  };
  return `/**
 * GENERATED by \`npm run compile\` (scripts/compile.ts) from contracts/${CRATE}.
 * Do not edit: deployments are checked against MARKET_WASM_HASH, and the
 * artifact test rebuilds the contract and compares.
 */

/** How the wasm was built. */
export const MARKET_BUILD = ${JSON.stringify(build)} as const;

/** Hex SHA-256 of the wasm: the hash it is installed under on-chain. */
export const MARKET_WASM_HASH = '${sha256Hex(wasm)}';

/** The release wasm, base64. */
export const MARKET_WASM_BASE64 = '${Buffer.from(wasm).toString('base64')}';

/**
 * The contract's interface (the wasm's \`contractspecv0\` section), one
 * base64 XDR \`ScSpecEntry\` per item: pass it to stellar-sdk's
 * \`new contract.Spec(MARKET_SPEC)\`.
 */
export const MARKET_SPEC: readonly string[] = ${JSON.stringify(spec)};

/** Contract error code -> name (a failed call reads \`Error(Contract, #code)\`). */
export const MARKET_ERRORS: Readonly<Record<number, string>> = ${JSON.stringify(errors)};
`;
}

function main(): void {
  const wasm = buildWasm();
  writeFileSync(FINAL_WASM, wasm);
  writeFileSync(ARTIFACT, artifactSource(wasm));
  const spec = specBase64(wasm);
  console.log(
    `${CRATE}: ${wasm.length} bytes, sha256 ${sha256Hex(wasm)}, ${spec.length} spec entries`,
  );
  console.log(`wasm written to ${FINAL_WASM}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
