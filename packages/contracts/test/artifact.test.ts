import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P2P_MARKET_ARTIFACT } from '@/p2p-market.artifact';

const solc = createRequire(import.meta.url)('solc') as {
  version(): string;
  compile(input: string): string;
};

describe('P2PMarket artifact', () => {
  it('is the committed source, compiled with the recorded settings', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../contracts/P2PMarket.sol', import.meta.url)),
      'utf8',
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      P2P_MARKET_ARTIFACT.sourceSha256,
    );
    expect(solc.version()).toBe(P2P_MARKET_ARTIFACT.compiler);
    const out = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: 'Solidity',
          sources: { 'P2PMarket.sol': { content: source } },
          settings: P2P_MARKET_ARTIFACT.settings,
        }),
      ),
    );
    const compiled = out.contracts['P2PMarket.sol'].P2PMarket;
    expect(`0x${compiled.evm.bytecode.object}`).toBe(P2P_MARKET_ARTIFACT.bytecode);
    expect(compiled.abi).toEqual(P2P_MARKET_ARTIFACT.abi);
  });
});
