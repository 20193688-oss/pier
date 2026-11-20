/* order-ref.ts: the `ref_id` an order carries on-chain, derived here from the order's own id (the
   uuid the person sees) exactly as the API derives it: SHA-256 of the uuid's 16 bytes, a
   `BytesN<32>` written as 64 hex digits. The signing check pins a sale's `open_with_deposit` to
   this, never to a ref an answer states. Pure; tests/unit/tx-verify.test.ts. */
import { hash } from '@stellar/stellar-sdk/base';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (id: string) => UUID.test(id);

export const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The order's on-chain ref (64 lower-case hex digits), or null when its id is not a uuid. */
export function orderRef(id: string): string | null {
  if (!isUuid(id)) return null;
  return toHex(hash(fromHex(id.replace(/-/g, '').toLowerCase())));
}
