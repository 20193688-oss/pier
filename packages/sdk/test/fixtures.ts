import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import type { MerchantOrder, TransferMatch } from '@/types';

export const MARKET = StrKey.encodeContract(Buffer.alloc(32, 1));
export const PASSPHRASE = Networks.TESTNET;
/** The merchant's (and its bot's) key: a fresh test key, never a real secret. */
export const MERCHANT = Keypair.random();
export const BUYER = Keypair.random().publicKey();

/** An unsigned `release(caller, id)` on `contract` from `source`, as the API builds it. */
export function releaseXdr(
  onchainId: string,
  options: { source?: string; caller?: string; contract?: string; fn?: string } = {},
): string {
  const source = options.source ?? MERCHANT.publicKey();
  return new TransactionBuilder(new Account(source, '41'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: options.contract ?? MARKET,
        function: options.fn ?? 'release',
        args: [
          nativeToScVal(options.caller ?? source, { type: 'address' }),
          nativeToScVal(BigInt(onchainId), { type: 'u64' }),
        ],
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
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
    buyerAddress: BUYER,
    contract: MARKET,
    createdAt: '2026-11-19T12:01:00.000Z',
    currency: 'ARS',
    endedAt: null,
    fiatAmount: '125050.00',
    id: `order-${onchainId}`,
    kind: 'BUY',
    merchantAccountId: 'acct-1',
    merchantSide: 'seller',
    netAmount: '995000000',
    network: 'testnet',
    onchainId,
    paidAt: null,
    paidReference: null,
    payer: { name: 'Juan Gómez', document: '20123456786' },
    paymentDeadline: '2026-11-19T12:31:00.000Z',
    price: '1250.5',
    qr: null,
    rail: 'ar_bank_transfer',
    sellerAddress: MERCHANT.publicKey(),
    settleDeadline: null,
    settlement: null,
    status: 'awaiting_payment',
    tier: 'test',
    token: StrKey.encodeContract(Buffer.alloc(32, 2)),
    tokenAmount: '1000000000',
    tokenDecimals: 7,
    tokenSymbol: 'USDC',
    txHashes: {
      accept: null,
      cancel: null,
      dispute: null,
      open: 'ab'.repeat(32),
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
      network: merchantOrder.network as 'testnet',
      action: 'release',
      description: `Release order ${onchainId}: pays its buyer 99.5 USDC`,
      xdr: releaseXdr(onchainId),
      hash: 'cd'.repeat(32),
      expiresAt: '2026-11-19T12:06:00.000Z',
    },
  };
}
