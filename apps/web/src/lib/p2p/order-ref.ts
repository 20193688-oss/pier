/* order-ref.ts: the `ref` an order carries on-chain, derived here from the order's own id (the
   uuid the person sees) exactly as the API derives it: keccak-256 of the uuid's 16 bytes. The
   signing check pins a sale's `openWithDeposit` to this, not to a `ref` field an answer states.
   Pure; tests/unit/tx-verify.test.ts. */
import { keccak256, type Hex } from 'viem';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (id: string) => UUID.test(id);

/** The order's on-chain ref, or null when its id is not a uuid. */
export function orderRef(id: string): Hex | null {
  return isUuid(id) ? keccak256(`0x${id.replace(/-/g, '').toLowerCase()}` as Hex) : null;
}
