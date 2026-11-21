import {
  Account,
  Address,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import type { MerchantOrder, TransferMatch } from '@/types';

export const MARKET = StrKey.encodeContract(Buffer.alloc(32, 1));
export const PASSPHRASE = Networks.TESTNET;
/** The merchant's (and its bot's) key: a fresh test key, never a real secret. */
export const MERCHANT = Keypair.random();
export const BUYER = Keypair.random().publicKey();

export interface ReleaseOptions {
  source?: string;
  caller?: string;
  contract?: string;
  fn?: string;
  fee?: string;
  timeoutSeconds?: number;
  memo?: string;
  minSequence?: string;
  /** Auth entries: `self` = one source-account entry for the same call; `sub` = with a sub-invocation; `address` = address credentials. */
  auth?: 'self' | 'sub' | 'address' | 'two';
  extraOp?: boolean;
}

/** An unsigned `release(caller, id)` on `contract` from `source`, as the API builds it (or tampered). */
export function releaseXdr(onchainId: string, options: ReleaseOptions = {}): string {
  const source = options.source ?? MERCHANT.publicKey();
  const contract = options.contract ?? MARKET;
  const args = [
    nativeToScVal(options.caller ?? source, { type: 'address' }),
    nativeToScVal(BigInt(onchainId), { type: 'u64' }),
  ];
  const fn = options.fn ?? 'release';
  const invocation = (sub: xdr.SorobanAuthorizedInvocation[] = []) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
      subInvocations: sub,
    });
  const sourceEntry = (sub: xdr.SorobanAuthorizedInvocation[] = []) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: invocation(sub),
    });
  const auth =
    options.auth === 'self'
      ? [sourceEntry()]
      : options.auth === 'sub'
        ? [sourceEntry([invocation()])]
        : options.auth === 'two'
          ? [sourceEntry(), sourceEntry()]
          : options.auth === 'address'
            ? [
                new xdr.SorobanAuthorizationEntry({
                  credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
                    new xdr.SorobanAddressCredentials({
                      address: new Address(source).toScAddress(),
                      nonce: 1n,
                      signatureExpirationLedger: 10,
                      signature: xdr.ScVal.scvVoid(),
                    }),
                  ),
                  rootInvocation: invocation(),
                }),
              ]
            : [];
  const builder = new TransactionBuilder(new Account(source, '41'), {
    fee: options.fee ?? '100',
    networkPassphrase: PASSPHRASE,
    ...(options.minSequence ? { minAccountSequence: options.minSequence } : {}),
  })
    // A Soroban transaction cannot carry a memo: a memo comes on a classic operation.
    .addOperation(
      options.memo
        ? Operation.bumpSequence({ bumpTo: '100' })
        : Operation.invokeContractFunction({ contract, function: fn, args, auth }),
    )
    .setTimeout(options.timeoutSeconds ?? 300);
  if (options.extraOp) {
    builder.addOperation(Operation.bumpSequence({ bumpTo: '100' }));
  }
  if (options.memo) builder.addMemo(Memo.text(options.memo));
  return builder.build().toXDR();
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
    chat: { count: 0, lastAt: null, lastFrom: null },
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
