/* The dashboard's transaction steps: the API builds each unsigned transaction (Stellar XDR) for
   one of the organization's accounts (`from`: its id), the step carries the exact expectation the
   signing check compares it with (what the person typed, ticked or is looking at), and the signed
   envelope goes back through the organization's submit route, where the API pays the network fee
   from its sponsor when sponsorship is on. */
import { clientOrders, type Scope } from '@/lib/api/endpoints';
import type { TxStep } from '@/components/wallet/SignFlow';
import type { TxExpectation } from '@/lib/p2p/tx-verify';
import type { Submitter } from '@/lib/wallet/sign';

/** The contract function names the transaction builder takes. */
export type AccountAction =
  | 'deposit'
  | 'withdraw'
  | 'set_operator'
  | 'set_matcher'
  | 'accept'
  | 'mark_paid'
  | 'release'
  | 'cancel'
  | 'dispute';

export function accountStep(
  scope: Scope,
  input: {
    network: string;
    accountId: string;
    action: AccountAction;
    args: Record<string, unknown>;
  },
  label: string,
  expect: TxExpectation,
): TxStep {
  return {
    label,
    build: () =>
      clientOrders.transaction(scope, {
        network: input.network,
        from: input.accountId,
        action: input.action,
        args: input.args,
      }),
    expect,
  };
}

/** Where the dashboard's signed envelopes go: `POST /v1/p2p/submit`, followed through
    `GET /v1/p2p/submissions/{hash}`, scoped to the organization and tier. */
export function orgSubmitter(scope: Scope): Submitter {
  return {
    submit: (xdr) => clientOrders.submit(scope, xdr),
    poll: (hash) => clientOrders.submission(scope, hash),
  };
}
