import { createHash } from 'node:crypto';
import { MARKET_ERRORS } from '@midpoint/contracts';
import { Keypair, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  MARKET,
  decodeMarketEvent,
  contractErrorOrigin,
  marketErrorName,
  p2pCall,
  refusalName,
  snakeCase,
  toChainOrder,
  type P2pOpenParams,
} from '@/chain/market-codec';
import { openParamsOf, orderRef } from '@/p2p/domain/order-ref';
import { call } from '@test/unit/helpers/ops';
import {
  MARKET_ID,
  TOKEN_ID,
  marketRefusal,
  tokenRefusal,
} from '@test/unit/helpers/simulation-refusals';

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 4));
const SELLER = Keypair.random().publicKey();
const BUYER = Keypair.random().publicKey();
const MATCHER = Keypair.random().publicKey();
const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addr = (a: string) => nativeToScVal(a, { type: 'address' });
const map = (entries: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(entries)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: entries[k] })),
  );

const params: P2pOpenParams = {
  refId: orderRef(ID),
  seller: SELLER,
  buyer: BUYER,
  token: TOKEN,
  amount: 1_000_000_000n,
  bond: 100_000_000n,
  acceptWindow: 300,
  paymentWindow: 1800,
  settleWindow: 21_600,
  integrator: null,
  integratorFeeBps: 0,
};

describe('order refs', () => {
  it('is SHA-256 of the uuid’s 16 bytes, hex', () => {
    const expected = createHash('sha256')
      .update(Buffer.from(ID.replace(/-/g, ''), 'hex'))
      .digest('hex');
    expect(orderRef(ID)).toBe(expected);
    expect(() => orderRef('not-a-uuid')).toThrow();
  });

  it('opens with no integrator unless both an address and a fee are set', () => {
    const terms = {
      id: ID,
      sellerAddress: SELLER,
      buyerAddress: BUYER,
      token: TOKEN,
      tokenAmount: '1000',
      bond: '0',
      acceptWindow: 0,
      paymentWindow: 1800,
      settleWindow: 0,
      integratorAddress: MATCHER,
      integratorFeeBps: 0,
    };
    expect(openParamsOf(terms)).toMatchObject({ integrator: null, integratorFeeBps: 0 });
    expect(openParamsOf({ ...terms, integratorFeeBps: 25 })).toMatchObject({
      integrator: MATCHER,
      integratorFeeBps: 25,
    });
  });
});

describe('the market codec (contract.Spec over MARKET_SPEC)', () => {
  it('encodes open_with_deposit with the OpenParams struct, ref_id as 32 bytes', () => {
    const c = call(p2pCall.openWithDeposit(CONTRACT, params));
    expect(c.contract).toBe(CONTRACT);
    expect(c.fn).toBe('open_with_deposit');
    const p = c.args[0] as Record<string, unknown>;
    expect(Buffer.from(p.ref_id as Uint8Array).toString('hex')).toBe(orderRef(ID));
    expect(p).toMatchObject({
      seller: SELLER,
      buyer: BUYER,
      token: TOKEN,
      amount: 1_000_000_000n,
      bond: 100_000_000n,
      accept_window: 300,
      payment_window: 1800,
      settle_window: 21_600,
      integrator_fee_bps: 0,
    });
  });

  it('encodes the matcher’s open with the matcher as caller, and order acts by id', () => {
    const open = call(p2pCall.open(CONTRACT, MATCHER, params));
    expect(open.fn).toBe('open');
    expect(open.args[0]).toBe(MATCHER);
    expect(call(p2pCall.orderAction(CONTRACT, 'mark_paid', MATCHER, 9n))).toMatchObject({
      fn: 'mark_paid',
      args: [MATCHER, 9n],
    });
    expect(call(p2pCall.resolve(CONTRACT, 9n, 5n, 1n))).toMatchObject({
      fn: 'resolve',
      args: [9n, 5n, 1n],
    });
  });

  it('refuses arguments the spec does not take', () => {
    expect(() => MARKET.funcArgsToScVals('deposit', { account: SELLER, token: TOKEN })).toThrow();
  });

  it('decodes order_opened with every field and the id topic', () => {
    const topics = [sym('order_opened'), u64(7n)];
    const data = map({
      seller: addr(SELLER),
      buyer: addr(BUYER),
      token: addr(TOKEN),
      opener: addr(SELLER),
      integrator: xdr.ScVal.scvVoid(),
      amount: i128(1_000_000_000n),
      bond: i128(100_000_000n),
      status: u32(1),
      from_balance: xdr.ScVal.scvBool(false),
      via_matcher: xdr.ScVal.scvBool(false),
      fee_bps: u32(50),
      integrator_fee_bps: u32(0),
      accept_deadline: u64(1_800_000_300n),
      payment_deadline: u64(0n),
      payment_window: u32(1800),
      settle_window: u32(21_600),
      ref_id: xdr.ScVal.scvBytes(Buffer.from(orderRef(ID), 'hex')),
    });
    const event = decodeMarketEvent(topics, data);
    expect(event).toMatchObject({
      name: 'order_opened',
      id: 7n,
      seller: SELLER,
      opener: SELLER,
      integrator: null,
      amount: 1_000_000_000n,
      status: 'Offered',
      fromBalance: false,
      viaMatcher: false,
      feeBps: 50,
      acceptDeadline: 1_800_000_300,
      refId: orderRef(ID),
    });
  });

  it('decodes order_released with an optional `by`, and ignores events it does not read', () => {
    const released = decodeMarketEvent(
      [sym('order_released'), u64(3n)],
      map({
        by: xdr.ScVal.scvVoid(),
        to_buyer: i128(995n),
        protocol_fee: i128(5n),
        integrator_fee: i128(0n),
      }),
    );
    expect(released).toEqual({
      name: 'order_released',
      id: 3n,
      by: null,
      toBuyer: 995n,
      protocolFee: 5n,
      integratorFee: 0n,
    });
    const deposited = decodeMarketEvent(
      [sym('deposited'), addr(SELLER), addr(TOKEN)],
      map({ amount: i128(1n) }),
    );
    expect(deposited).toBeNull();
    expect(decodeMarketEvent([sym('something_else')], xdr.ScVal.scvVoid())).toBeNull();
  });

  it('reads a get_order result', () => {
    const o = toChainOrder({
      seller: SELLER,
      buyer: BUYER,
      token: TOKEN,
      opener: MATCHER,
      integrator: undefined,
      amount: 10n,
      bond: 0n,
      status: 3,
      from_balance: true,
      via_matcher: true,
      fee_bps: 50,
      integrator_fee_bps: 0,
      accept_deadline: 0n,
      payment_deadline: 100n,
      paid_at: 50n,
      payment_window: 1800,
      settle_window: 0,
      ref_id: Buffer.from(orderRef(ID), 'hex'),
    });
    expect(o).toMatchObject({ status: 'Paid', integrator: null, paidAt: 50, refId: orderRef(ID) });
  });

  it('names contract errors by code, from the artifact', () => {
    expect(marketErrorName('HostError: Error(Contract, #14)')).toBe('InsufficientBalance');
    expect(marketErrorName('Error(Contract, #16)')).toBe(MARKET_ERRORS[16]);
    expect(marketErrorName('Error(Auth, InvalidAction)')).toBeNull();
    expect(marketErrorName('Error(Contract, #999)')).toBeNull();
  });

  it('snake-cases event struct names', () => {
    expect(snakeCase('OrderOpened')).toBe('order_opened');
    expect(snakeCase('order_paid')).toBe('order_paid');
    expect(snakeCase('OwnershipTransferStarted')).toBe('ownership_transfer_started');
  });
});

describe('refusal attribution', () => {
  const decode = (events: string[]) => events.map((e) => xdr.DiagnosticEvent.fromXDR(e, 'base64'));
  const isMarket = (id: string) => id === MARKET_ID;

  it('names a token refusal inside a market call as the token’s, not the market’s code', () => {
    const events = decode(tokenRefusal.events);
    expect(contractErrorOrigin(events)).toEqual({ contract: TOKEN_ID, code: 13 });
    expect(refusalName({ error: tokenRefusal.error, events }, isMarket)).toBe(
      'TokenTrustlineMissing',
    );
    // The old text-only reading took #13 for the market's EmptyRef.
    expect(marketErrorName(tokenRefusal.error)).toBe('EmptyRef');
  });

  it('names the market’s own refusal from its error table', () => {
    const events = decode(marketRefusal.events);
    expect(contractErrorOrigin(events)).toEqual({ contract: MARKET_ID, code: 16 });
    expect(refusalName({ error: marketRefusal.error, events }, isMarket)).toBe('UnknownOrder');
  });

  it('falls back to the market table only when there are no events to tell', () => {
    expect(refusalName({ error: marketRefusal.error, events: [] }, isMarket)).toBe('UnknownOrder');
    expect(refusalName({ error: 'HostError: Error(Auth, InvalidAction)' }, isMarket)).toBeNull();
    expect(contractErrorOrigin([{}, { event: { body: { v0: { topics: [] } } } }])).toBeNull();
  });
});
