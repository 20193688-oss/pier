import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { p2pCall } from '@/chain/market-codec';
import { assetOf, nativeTokenOf, tokenOf } from '@/chain/networks';
import { sacTransferOperation } from '@/chain/tx-builder.service';
import { checkSubmission, type SubmitContext } from '@/p2p/domain/submit-policy';

const USER = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const SPONSOR = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 5));
const USDC = tokenOf('testnet', 'USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const XLM = nativeTokenOf('testnet');
const NOW = 1_800_000_000;

const ctx = (overrides: Partial<SubmitContext> = {}): SubmitContext => ({
  contract: CONTRACT,
  tokens: [USDC],
  sponsor: SPONSOR,
  now: NOW,
  maxFeeStroops: 2_000_000,
  maxTtlSeconds: 360,
  ...overrides,
});

function tx(
  ops: xdr.Operation[],
  options: { source?: string; maxTime?: number; fee?: string } = {},
): Transaction {
  const builder = new TransactionBuilder(new Account(options.source ?? USER, '10'), {
    fee: options.fee ?? '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: options.maxTime ?? NOW + 300 },
  });
  for (const op of ops) builder.addOperation(op);
  // Parsed back, as the API reads what a wallet signed.
  return TransactionBuilder.fromXDR(builder.build().toXDR(), Networks.TESTNET) as Transaction;
}

const payment = (asset = assetOf(USDC)) =>
  Operation.payment({ destination: OTHER, asset, amount: '1' });

describe('the gasless submission policy', () => {
  it('takes a market call, a token transfer and a classic payment of a listed token', () => {
    const deposit = checkSubmission(
      tx([p2pCall.deposit(CONTRACT, USER, USDC.contract, 5n)]),
      ctx(),
    );
    expect(deposit).toMatchObject({ ok: true, kind: 'invoke', account: USER, reserveStroops: 0n });
    expect(
      checkSubmission(tx([sacTransferOperation(USDC, USER, CONTRACT, 5n)]), ctx()),
    ).toMatchObject({
      ok: true,
      kind: 'sac_transfer',
    });
    expect(checkSubmission(tx([payment()]), ctx())).toMatchObject({ ok: true, kind: 'payment' });
  });

  it('refuses two operations, owner functions, other contracts and unlisted assets', () => {
    const refused = (t: Transaction, c = ctx()) => checkSubmission(t, c).ok;
    expect(refused(tx([payment(), payment()]))).toBe(false);
    expect(refused(tx([p2pCall.setToken(CONTRACT, USDC.contract, true)]))).toBe(false);
    const other = StrKey.encodeContract(Buffer.alloc(32, 6));
    expect(refused(tx([p2pCall.deposit(other, USER, USDC.contract, 5n)]))).toBe(false);
    expect(refused(tx([payment(Asset.native())]))).toBe(false);
    expect(refused(tx([payment(new Asset('USDC', OTHER))]))).toBe(false);
    expect(refused(tx([Operation.setOptions({ homeDomain: 'x.example' })]))).toBe(false);
  });

  it('refuses a token transfer from someone else, and any operation acting for another account', () => {
    expect(checkSubmission(tx([sacTransferOperation(USDC, OTHER, USER, 5n)]), ctx()).ok).toBe(
      false,
    );
    const forOther = Operation.payment({
      destination: USER,
      asset: assetOf(USDC),
      amount: '1',
      source: OTHER,
    });
    expect(checkSubmission(tx([forOther]), ctx()).ok).toBe(false);
  });

  it('refuses a transfer call that is not `transfer` on a token', () => {
    const op = Operation.invokeContractFunction({
      contract: USDC.contract,
      function: 'approve',
      args: [nativeToScVal(USER, { type: 'address' })],
    });
    expect(checkSubmission(tx([op]), ctx()).ok).toBe(false);
  });

  it('checks the time bounds and the fee cap', () => {
    const op = p2pCall.deposit(CONTRACT, USER, USDC.contract, 5n);
    expect(checkSubmission(tx([op], { maxTime: NOW - 1 }), ctx())).toMatchObject({ ok: false });
    expect(checkSubmission(tx([op], { maxTime: NOW + 3600 }), ctx())).toMatchObject({ ok: false });
    expect(checkSubmission(tx([op], { fee: '3000000' }), ctx())).toMatchObject({ ok: false });
  });

  describe('the sponsored activation', () => {
    const trust = (source = USER) => Operation.changeTrust({ asset: assetOf(USDC), source });
    const begin = (source = SPONSOR) =>
      Operation.beginSponsoringFutureReserves({ sponsoredId: USER, source });
    const end = (source = USER) => Operation.endSponsoringFutureReserves({ source });
    const create = (startingBalance = '0') =>
      Operation.createAccount({ destination: USER, startingBalance, source: SPONSOR });

    it('takes the trustline-only shape from the account, and the create shape from the sponsor', () => {
      expect(checkSubmission(tx([begin(), trust(), end()]), ctx())).toMatchObject({
        ok: true,
        kind: 'activation',
        account: USER,
        reserveStroops: 5_000_000n,
      });
      expect(
        checkSubmission(tx([begin(), create(), trust(), end()], { source: SPONSOR }), ctx()),
      ).toMatchObject({ ok: true, kind: 'activation', account: USER, reserveStroops: 15_000_000n });
    });

    it('refuses it without gasless, with lumens, from another sponsor, or for another asset', () => {
      expect(checkSubmission(tx([begin(), trust(), end()]), ctx({ sponsor: null })).ok).toBe(false);
      expect(
        checkSubmission(tx([begin(), create('1'), trust(), end()], { source: SPONSOR }), ctx()).ok,
      ).toBe(false);
      expect(checkSubmission(tx([begin(OTHER), trust(), end()]), ctx()).ok).toBe(false);
      const otherAsset = Operation.changeTrust({ asset: new Asset('EURC', OTHER), source: USER });
      expect(checkSubmission(tx([begin(), otherAsset, end()]), ctx()).ok).toBe(false);
      expect(checkSubmission(tx([begin(), trust(OTHER), end()]), ctx()).ok).toBe(false);
      // Creating the account needs the sponsor as the transaction's source.
      expect(checkSubmission(tx([begin(), create(), trust(), end()]), ctx()).ok).toBe(false);
    });

    it('creates a missing account with no trustline only when the native lumen is listed', () => {
      const createOnly = tx([begin(), create(), end()], { source: SPONSOR });
      expect(checkSubmission(createOnly, ctx()).ok).toBe(false);
      expect(checkSubmission(createOnly, ctx({ tokens: [USDC, XLM] }))).toMatchObject({
        ok: true,
        kind: 'activation',
        account: USER,
        reserveStroops: 10_000_000n,
      });
      // Still from the sponsor, with no lumens, for the sponsored account.
      expect(checkSubmission(tx([begin(), create(), end()]), ctx({ tokens: [USDC, XLM] })).ok).toBe(
        false,
      );
      expect(
        checkSubmission(
          tx([begin(), create('1'), end()], { source: SPONSOR }),
          ctx({ tokens: [USDC, XLM] }),
        ).ok,
      ).toBe(false);
    });

    it('never opens a trustline for the lumen', () => {
      const lumenLine = Operation.changeTrust({ asset: Asset.native(), source: USER });
      expect(
        checkSubmission(tx([begin(), lumenLine, end()]), ctx({ tokens: [USDC, XLM] })).ok,
      ).toBe(false);
    });
  });

  describe('the native lumen', () => {
    const XLM_CTX = ctx({ tokens: [USDC, XLM] });

    it('takes a lumen payment and a native SAC transfer only when XLM is listed', () => {
      expect(checkSubmission(tx([payment(Asset.native())]), XLM_CTX)).toMatchObject({
        ok: true,
        kind: 'payment',
      });
      expect(checkSubmission(tx([payment(Asset.native())]), ctx()).ok).toBe(false);
      expect(
        checkSubmission(tx([sacTransferOperation(XLM, USER, OTHER, 5n)]), XLM_CTX),
      ).toMatchObject({ ok: true, kind: 'sac_transfer' });
      expect(checkSubmission(tx([sacTransferOperation(XLM, USER, OTHER, 5n)]), ctx()).ok).toBe(
        false,
      );
    });

    it('still refuses a classic asset that only shares the lumen’s code', () => {
      expect(checkSubmission(tx([payment(new Asset('XLM', OTHER))]), XLM_CTX).ok).toBe(false);
    });
  });
});
