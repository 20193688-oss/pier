import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ChainCallReverted } from '@/chain/chain-client.service';
import type { Deployment } from '@/chain/deployments.service';
import type { P2pChainStatus } from '@/chain/market-codec';
import type { MarketReader } from '@/chain/market-reader.service';
import { ApiError } from '@/common/api-error';
import { orderRef } from '@/p2p/domain/order-ref';
import { alreadyDone, onchainOutcome } from '@/p2p/order-outcome';
import { OrdersService } from '@/p2p/orders.service';
import { TransactionsService } from '@/p2p/transactions.service';
import type { P2pOrderRow } from '@/p2p/views';

/**
 * The second press after the first went through on-chain but before the
 * indexer moved the stored order: the contract refuses the call, and the
 * order read on-chain decides between "already done" and the refusal.
 */

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
const MATCHER = Keypair.random();
const OPENER = Keypair.random().publicKey();
const ID = '0b6c9a3e-2f1d-4c5b-8a7e-6d5c4b3a2f10';
const D = { tier: 'test', network: 'testnet', contract: CONTRACT } as unknown as Deployment;
const REVERTED = new ChainCallReverted('InvalidStatus', 'HostError: Error(Contract, #7)');

function reader(status: P2pChainStatus | null, opts: { idOf?: bigint; fails?: boolean } = {}) {
  return {
    requireLive: vi.fn(async () => D),
    getOrder: vi.fn(async () => {
      if (opts.fails) throw new Error('rpc down');
      return status === null ? null : { status };
    }),
    orderIdOf: vi.fn(async () => opts.idOf ?? 0n),
  };
}
const asReader = (r: ReturnType<typeof reader>) => r as unknown as MarketReader;

const row = (overrides: Partial<P2pOrderRow> = {}) =>
  ({
    id: ID,
    kind: 'BUY',
    status: 'awaiting_payment',
    onchainId: '7',
    openerAddress: OPENER,
    tier: 'test',
    network: 'testnet',
    ...overrides,
  }) as unknown as P2pOrderRow;

describe('an order read on-chain after a refusal', () => {
  it('answers the status the contract shows when it already shows the action', async () => {
    const r = reader('Paid');
    expect(await onchainOutcome(asReader(r), D, row(), 'markPaid')).toBe('paid');
    expect(r.getOrder).toHaveBeenCalledWith(D, 7n);
    expect(await onchainOutcome(asReader(reader('Active')), D, row(), 'markPaid')).toBeNull();
    expect(await onchainOutcome(asReader(reader(null)), D, row(), 'markPaid')).toBeNull();
  });

  it('finds a sale that is not indexed yet by its opening reference', async () => {
    const pending = row({ kind: 'SELL', status: 'pending', onchainId: null });
    const none = reader('Offered');
    expect(await onchainOutcome(asReader(none), D, pending, 'open')).toBeNull();
    expect(none.orderIdOf).toHaveBeenCalledWith(D, OPENER, orderRef(ID));
    expect(none.getOrder).not.toHaveBeenCalled();
    const opened = reader('Offered', { idOf: 9n });
    expect(await onchainOutcome(asReader(opened), D, pending, 'open')).toBe('awaiting_acceptance');
    expect(opened.getOrder).toHaveBeenCalledWith(D, 9n);
  });

  it('keeps the caller’s refusal when the chain cannot be read', async () => {
    const r = reader('Paid', { fails: true });
    expect(await onchainOutcome(asReader(r), D, row(), 'markPaid')).toBeNull();
  });

  it('is a 409 already_done naming the status', () => {
    const err = alreadyDone('completed');
    expect(err.status).toBe(409);
    expect(err.body()).toEqual({
      error: {
        code: 'already_done',
        message: 'This order already shows that action: it is completed.',
        details: ['status: completed'],
      },
    });
  });
});

describe('a buyer act the contract refuses', () => {
  function service(chain: P2pChainStatus) {
    const r = reader(chain);
    const fresh = row({ status: 'paid' });
    const prisma = {
      p2pOrder: { findUnique: vi.fn(async () => fresh), updateMany: vi.fn() },
    };
    const matcher = {
      send: vi.fn(async () => {
        throw REVERTED;
      }),
    };
    const deployments = { matcherKey: () => MATCHER };
    const orders = new OrdersService(
      prisma as never,
      deployments as never,
      asReader(r),
      {} as never,
      {} as never,
      matcher as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { orders, matcher, reader: r, fresh };
  }

  it('answers the order when the contract already shows it', async () => {
    const s = service('Paid');
    await expect(s.orders.sendBuyerAct(row(), 'paid')).resolves.toBe(s.fresh);
    expect(s.matcher.send).toHaveBeenCalledTimes(1);
  });

  it('stays a 400 invalid_state when it does not', async () => {
    const s = service('Active');
    const err = await s.orders.sendBuyerAct(row(), 'paid').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe('invalid_state');
  });

  it('sends nothing when the stored order already shows it', async () => {
    const s = service('Paid');
    const done = row({ status: 'completed' });
    await expect(s.orders.sendBuyerAct(done, 'paid')).resolves.toBe(done);
    expect(s.reader.requireLive).not.toHaveBeenCalled();
    expect(s.matcher.send).not.toHaveBeenCalled();
  });
});

describe('an order transaction the contract would refuse', () => {
  function service(chain: P2pChainStatus, error: unknown = REVERTED) {
    const r = reader(chain);
    const builder = {
      invoke: vi.fn(async () => {
        throw error;
      }),
    };
    const transactions = new TransactionsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      asReader(r),
      builder as never,
    );
    const call = { fn: 'release', operation: {} as never, description: 'Release order 7' };
    return {
      build: () =>
        transactions
          .preparedOrderAction(D, OPENER, call, row({ status: 'paid' }), 'release')
          .catch((e: unknown) => e),
    };
  }

  it('is a 409 already_done when the contract already shows it', async () => {
    const err = await service('Released').build();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('already_done');
    expect((err as ApiError).details).toEqual(['status: completed']);
  });

  it('stays the contract’s 400 when it does not', async () => {
    const err = await service('Paid').build();
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe('invalid_state');
  });

  it('passes any other failure through untouched', async () => {
    const down = ApiError.unavailable('The network cannot be reached right now.');
    expect(await service('Released', down).build()).toBe(down);
  });
});
