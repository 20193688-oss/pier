/* The dashboard's transaction steps: the API builds each unsigned transaction for one of the
   organization's accounts (`from`: its id), and the step carries the exact expectation the
   signing check compares it with (what the person typed, ticked or is looking at). */
import { clientOrders, type Scope } from '@/lib/api/endpoints';
import type { TxStep } from '@/components/wallet/SignFlow';
import type { TxExpectation } from '@/lib/p2p/tx-verify';

export function accountStep(
  scope: Scope,
  input: { network: string; accountId: string; action: string; args: Record<string, unknown> },
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
