/* The demo wallet (mock mode only): an EIP-1193 provider announced through EIP-6963 like any
   browser wallet, so the real connect, sign-in and signing code paths run unchanged in mock mode
   and in browser tests. It holds no key: a "signature" is a hash of the message, which only the
   mock API accepts, and a sent transaction is applied to the mock state (src/lib/mock/chain.ts). */
import { keccak256, stringToHex, numberToHex, hexToString, type Hex } from 'viem';
import { BUSINESS_WALLET, DEMO_ADDRESS, NETWORKS } from '@/lib/mock/fixtures';
import { applyTransaction } from '@/lib/mock/chain';

/** A third address no organization registered yet, so the registration flow can run. */
export const FRESH_ADDRESS = '0xf4e5000000000000000000000000000000000001';
const ACCOUNTS = [DEMO_ADDRESS, BUSINESS_WALLET, FRESH_ADDRESS];

const ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#ffd23f"/><path d="M8 11h16v12H8z" fill="none" stroke="#10261f" stroke-width="2.4" stroke-linejoin="round"/><circle cx="20" cy="17" r="1.8" fill="#10261f"/></svg>',
)}`;

let chainId = NETWORKS[0].chainId;
let block = 1000;
const receipts = new Map<string, Record<string, unknown>>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });

async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
  const p = (Array.isArray(params) ? params : []) as unknown[];
  switch (method) {
    case 'eth_requestAccounts':
      await wait(250);
      return ACCOUNTS;
    case 'eth_accounts':
      return ACCOUNTS;
    case 'eth_chainId':
      return numberToHex(chainId);
    case 'net_version':
      return String(chainId);
    case 'wallet_switchEthereumChain': {
      const id = Number.parseInt(String((p[0] as { chainId?: string })?.chainId ?? '0x0'), 16);
      if (!NETWORKS.some((n) => n.chainId === id)) throw rpcError(4902, 'Unknown chain');
      await wait(200);
      chainId = id;
      return null;
    }
    case 'wallet_addEthereumChain':
      return null;
    case 'personal_sign': {
      await wait(450);
      const [message] = p as [Hex];
      const text = /^0x[0-9a-fA-F]*$/.test(message) ? hexToString(message) : String(message);
      const h = keccak256(stringToHex(text));
      return `${h}${keccak256(h).slice(2)}1b`;
    }
    case 'eth_sendTransaction': {
      await wait(650);
      const tx = p[0] as { from: string; to: string; data: Hex };
      const hash = applyTransaction(tx.from, chainId, tx.to, tx.data ?? '0x');
      block += 1;
      receipts.set(hash, {
        transactionHash: hash,
        transactionIndex: '0x0',
        blockHash: keccak256(stringToHex(`block-${block}`)),
        blockNumber: numberToHex(block),
        from: tx.from,
        to: tx.to,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'0'.repeat(512)}`,
        status: '0x1',
        type: '0x2',
      });
      return hash;
    }
    case 'eth_getTransactionReceipt':
      return receipts.get(String(p[0])) ?? null;
    case 'eth_blockNumber':
      return numberToHex(block);
    case 'eth_getBlockByNumber':
      return {
        number: numberToHex(block),
        hash: keccak256(stringToHex(`block-${block}`)),
        timestamp: numberToHex(Math.floor(Date.now() / 1000)),
        transactions: [],
        baseFeePerGas: '0x1',
      };
    case 'eth_estimateGas':
      return '0x5208';
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return '0x1';
    case 'eth_getTransactionCount':
      return '0x0';
    default:
      throw rpcError(4200, `Unsupported method ${method}`);
  }
}

export const demoProvider = { request };

/** Announce the demo wallet to the page (now and whenever the page asks again). */
export function announceDemoWallet() {
  const detail = Object.freeze({
    info: {
      uuid: '6f1f3a52-8c1e-4d8e-9c1a-9a4b8a1d0e11',
      name: 'pedospe demo',
      icon: ICON,
      rdns: 'com.pedospe.demo',
    },
    provider: demoProvider,
  });
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}
