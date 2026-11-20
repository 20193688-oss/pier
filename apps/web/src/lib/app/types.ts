/* The payments app's own resources (docs/STELLAR.md 5.6), as the screens read them. Token amounts
   are base units (decimal integer strings) as the API sends them; screens format them with the
   token's decimals. */
import type { P2pOrder } from '@/lib/p2p/types';

export interface AppProfile {
  address: string;
  handle: string | null;
}

export interface AppTokenBalance {
  symbol: string;
  contract: string;
  /* Base units. */
  amount: string;
  /* Whether the account holds the trustline, and whether the issuer authorized it. */
  trustline: boolean;
  authorized: boolean;
}

export interface AppBalances {
  network: string;
  account: { exists: boolean };
  /* XLM, base units: the network's own coin, which the person never needs (fees are paid). */
  xlm: string;
  tokens: AppTokenBalance[];
}

export type TransferStatus = 'PENDING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED';

export interface AppTransfer {
  id: string;
  network: string;
  token: string;
  /* Base units. */
  amount: string;
  from: string;
  fromHandle: string | null;
  to: string;
  toHandle: string | null;
  note: string | null;
  direction: 'in' | 'out';
  status: TransferStatus;
  hash: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type ActivityItem =
  | { type: 'order'; at: string; order: P2pOrder }
  | { type: 'transfer'; at: string; transfer: AppTransfer };

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

export type SubmitStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface SubmitResult {
  hash: string;
  status: SubmitStatus;
  error: string | null;
}

/** A charge as its payer sees it in the app, with the price of paying it from the balance. */
export interface PayerCharge {
  id: string;
  status: 'open' | 'paid' | 'expired' | 'cancelled';
  currency: string;
  fiatAmount: string;
  description: string | null;
  merchantName: string | null;
  network: string;
  token: string;
  expiresAt: string | null;
  /* Null when the balance cannot pay it now (no quote, the charge is closed...). `recipient` is
     the charge's receiving account (G or C): what the payment must pay. */
  payWithBalance: { token: string; amount: string; expiresAt: string; recipient: string } | null;
}

/** A payment of a charge from the balance: a token transfer to the charge's receiving account
    (the `recipient` its payer was shown). */
export interface ChargePayment {
  id: string;
  chargeId: string;
  network: string;
  token: string;
  /* Base units. */
  amount: string;
  /* The transaction's hash. */
  hash: string | null;
  status: string;
  expiresAt: string | null;
}
