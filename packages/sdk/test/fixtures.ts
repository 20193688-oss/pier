import { encodeFunctionData } from 'viem';
import type { MerchantOrder, TransferMatch } from '@/types';

export const MARKET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const CHAIN_ID = 84532;

const RELEASE_ABI = [
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
] as const;

export function releaseData(onchainId: string): `0x${string}` {
  return encodeFunctionData({
    abi: RELEASE_ABI,
    functionName: 'release',
    args: [BigInt(onchainId)],
  });
}

/** A transfer match as the API answers it, for an order with on-chain id `onchainId`. */
export function transferMatch(
  onchainId: string,
  score: number,
  order: Partial<MerchantOrder> = {},
): TransferMatch {
  const merchantOrder: MerchantOrder = {
    acceptDeadline: null,
    beneficiary: null,
    bond: '0',
    buyerAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    chainId: CHAIN_ID,
    contract: MARKET,
    createdAt: '2026-11-19T12:01:00.000Z',
    currency: 'ARS',
    endedAt: null,
    fiatAmount: '125050.00',
    id: `order-${onchainId}`,
    kind: 'BUY',
    merchantAccountId: 'acct-1',
    merchantSide: 'seller',
    netAmount: '99500000',
    network: 'base',
    onchainId,
    paidAt: null,
    paidReference: null,
    payer: { name: 'Juan Gómez', document: '20123456786' },
    paymentDeadline: '2026-11-19T12:31:00.000Z',
    price: '1250.5',
    rail: 'ar_bank_transfer',
    sellerAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    settleDeadline: null,
    settlement: null,
    status: 'awaiting_payment',
    tier: 'test',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenAmount: '100000000',
    tokenDecimals: 6,
    tokenSymbol: 'USDC',
    txHashes: {
      accept: null,
      cancel: null,
      dispute: null,
      open: '0x01',
      paid: null,
      release: null,
      resolve: null,
    },
    updatedAt: '2026-11-19T12:01:00.000Z',
    ...order,
  };
  return {
    order: merchantOrder,
    score,
    matchedOn: ['amount', 'name', 'document'].slice(0, score),
    transaction: {
      chainId: merchantOrder.chainId,
      to: merchantOrder.contract,
      data: releaseData(onchainId),
      value: '0',
      description: `Release order ${onchainId}: pays its buyer 99.5 USDC`,
    },
  };
}
