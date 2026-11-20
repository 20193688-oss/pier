/* The mock API's payments-app routes (docs/STELLAR.md 5.2 and 5.6): SEP-10 sign-in and wallet
   proofs, profile and handles, balances and the sponsored activation, transfers, activity, paying
   a charge from the balance, QR payments, and submitting signed envelopes to the mock network. */
import { Account, Keypair, Operation, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk/base';
import { normalizeHandle, normalizeRecipient, parseEmv } from '@midpoint/payment-qr';
import type { ApiRequest } from '@/lib/api/client';
import { BRAND } from '@/lib/brand';
import { qrRail } from '@/lib/p2p/qr-pay';
import { isDestination } from '@/lib/stellar/network';
import {
  MERCHANTS,
  MERCHANT_WALLET,
  NETWORK,
  PRICES,
  RESERVED_HANDLES,
  RULES,
  SEP10_SIGNER,
  USDC,
} from '@/lib/mock/fixtures';
import { db, iso, makeOrder, now, rid, save, tick, type Wire } from '@/lib/mock/db';
import { activationTx, chainAccount, saleOpen, submitEnvelope, transferTx } from '@/lib/mock/chain';
import { fail, ok, session, type Handler } from '@/lib/mock/http';
import { myAppOrders, orderView } from '@/lib/mock/views';

const PASSPHRASE = NETWORK.networkPassphrase;
const homeDomain = () => location.host;

/* --- SEP-10 --- */

/** A standard SEP-10 challenge for `account` (with an organization binding for a wallet proof),
    signed by the mock SEP-10 key. */
export function sep10Challenge(account: string, org?: string) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48))));
  const t = Math.floor(now() / 1000);
  // Sequence -1: the challenge's own sequence is 0, so it can never be submitted.
  const builder = new TransactionBuilder(new Account(SEP10_SIGNER.publicKey(), '-1'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
    timebounds: { minTime: t, maxTime: t + 300 },
  })
    .addOperation(
      Operation.manageData({ name: `${homeDomain()} auth`, value: nonce, source: account }),
    )
    .addOperation(
      Operation.manageData({
        name: 'web_auth_domain',
        value: homeDomain(),
        source: SEP10_SIGNER.publicKey(),
      }),
    );
  if (org)
    builder.addOperation(
      Operation.manageData({ name: 'organization', value: org, source: SEP10_SIGNER.publicKey() }),
    );
  const tx = builder.build();
  tx.sign(SEP10_SIGNER);
  db().challenges10[nonce] = { account, org: org ?? null, expiresAt: iso((t + 300) * 1000) };
  save();
  return { transaction: tx.toXDR(), network_passphrase: PASSPHRASE };
}

const signedBy = (tx: Transaction, address: string) => {
  const kp = Keypair.fromPublicKey(address);
  return tx.signatures.some((s) => {
    try {
      return kp.verify(tx.hash(), s.signature.value);
    } catch {
      return false;
    }
  });
};

/** The account a signed challenge proves (null when it does not): the server's signature, the
    single-use nonce, the time bounds, the client's signature, the organization binding. */
export function sep10Verify(xdr: string, org?: string): string | null {
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE) as Transaction;
  } catch {
    return null;
  }
  if (tx.source !== SEP10_SIGNER.publicKey() || !signedBy(tx, SEP10_SIGNER.publicKey())) return null;
  const first = tx.operations[0];
  if (!first || first.type !== 'manageData' || !first.value || !first.source) return null;
  const nonce = new TextDecoder().decode(first.value);
  const ch = db().challenges10[nonce];
  if (!ch || ch.account !== first.source || (ch.org ?? undefined) !== org) return null;
  delete db().challenges10[nonce];
  save();
  if (Date.parse(ch.expiresAt) < now()) return null;
  return signedBy(tx, first.source) ? first.source : null;
}

/* --- QR payments --- */

export function qrQuote(body: Wire) {
  if (!session()) return fail(401, 'unauthenticated', 'Sign in first.');
  const r = parseEmv(String(body.qr ?? ''));
  if (!r.ok) return fail(422, 'invalid_qr', 'This QR cannot be read.');
  const rail = qrRail(r.qr);
  if (!rail || !r.qr.currency) return fail(422, 'unsupported_qr', 'This kind of QR is not taken.');
  const typed = body.fiatAmount ? Number(body.fiatAmount) : null;
  const own = r.qr.amount ? Number(r.qr.amount) : null;
  if (own !== null && typed !== null && typed !== own)
    return fail(422, 'amount_mismatch', 'The QR asks for another amount.');
  const fiat = own ?? typed;
  if (!fiat || !(fiat > 0)) return fail(422, 'amount_required', 'Type the amount.');
  const price = PRICES[r.qr.currency]?.sell;
  if (!price) return fail(422, 'no_match', 'No merchant takes this amount right now.');
  // The person pays the token amount that buys `fiat` at the merchant's price, rounded up.
  const tokenUnits = BigInt(Math.ceil((fiat / price) * 1e7));
  const usd = Number(tokenUnits) / 1e7;
  if (!(usd >= 1 && usd <= 2000)) return fail(422, 'no_match', 'No merchant takes this amount right now.');
  const fee = (tokenUnits * BigInt(RULES.protocolFeeBps)) / 10000n;
  const q = {
    id: rid('qt', 12),
    kind: 'QR_PAY',
    side: 'SELL',
    network: NETWORK.id,
    token: USDC.contract,
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    currency: r.qr.currency,
    rail,
    price: String(price),
    fiatAmount: fiat.toFixed(2),
    tokenAmount: tokenUnits.toString(),
    protocolFee: fee.toString(),
    integratorFee: '0',
    netAmount: (tokenUnits - fee).toString(),
    merchant: MERCHANTS[0],
    merchantAddress: MERCHANT_WALLET,
    bond: ((tokenUnits * BigInt(RULES.bondBps)) / 10000n).toString(),
    protocolFeeBps: RULES.protocolFeeBps,
    integratorFeeBps: 0,
    expiresAt: iso(now() + 60_000),
    _qr: r.qr.payload,
  };
  db().quotes[q.id] = q;
  save();
  const { _qr: _omit, ...pubQuote } = q;
  return ok(pubQuote, 201);
}

export function qrOrder(body: Wire) {
  const s = session();
  if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
  const q = db().quotes[String(body.quoteId)];
  if (!q || q.kind !== 'QR_PAY' || Date.parse(q.expiresAt) < now())
    return fail(409, 'quote_expired', 'Ask for a new quote.');
  if (String(body.qr ?? '') !== q._qr) return fail(422, 'qr_mismatch', 'Not the quoted QR.');
  const have = BigInt(chainAccount(s.address)?.trust.USDC ?? '0');
  if (have < BigInt(q.tokenAmount))
    return fail(422, 'insufficient_balance', 'Not enough USDC in this wallet.');
  delete db().quotes[q.id];
  const o = makeOrder({
    kind: 'QR_PAY',
    status: 'pending',
    owner: 'app',
    merchantOrg: 'org_nortecambios_auto',
    fiat: Number(q.fiatAmount),
    currency: q.currency,
    rail: q.rail,
    price: Number(q.price),
    buyer: q.merchantAddress,
    seller: s.address,
    merchant: q.merchant,
    extra: { _qr: q._qr, _qrAmount: q.fiatAmount },
  });
  o.tokenAmount = q.tokenAmount;
  o.bond = q.bond;
  db().orders.push(o);
  save();
  return ok({ ...orderView(o, 'client'), transactions: [saleOpen(o)] }, 201);
}

/* --- The app's own routes --- */

const unauth = () => fail(401, 'unauthenticated', 'Sign in first.');
const handleOf = (address: string) =>
  Object.entries(db().handles).find(([, a]) => a === address)?.[0] ?? null;

function profile(address: string) {
  return { address, handle: handleOf(address) };
}

function balances(address: string) {
  const a = chainAccount(address);
  const usdc = a?.trust.USDC;
  return {
    network: NETWORK.id,
    account: { exists: !!a?.exists },
    xlm: a?.xlm ?? '0',
    tokens: [
      {
        symbol: 'USDC',
        contract: USDC.contract,
        amount: usdc ?? '0',
        trustline: usdc !== null && usdc !== undefined,
        authorized: usdc !== null && usdc !== undefined,
      },
    ],
  };
}

function transferView(t: Wire, me: string) {
  const { _hash: _h, ...rest } = t;
  return { ...rest, direction: t.to === me || t._toBase === me ? 'in' : 'out' };
}

/** A charge as its payer sees it, with the price of paying it from the balance (60 s). */
function payerCharge(c: Wire) {
  if (c.status === 'open' && c.expiresAt && Date.parse(c.expiresAt) < now()) c.status = 'expired';
  const price = PRICES[c.currency]?.buy;
  const amount = price ? BigInt(Math.ceil((Number(c.fiatAmount) / price) * 1e7)).toString() : null;
  return {
    id: c.id,
    status: c.status,
    currency: c.currency,
    fiatAmount: c.fiatAmount,
    description: c.description,
    merchantName: c.payeeName,
    network: c.network,
    tokenSymbol: c.tokenSymbol,
    expiresAt: c.expiresAt,
    payWithBalance:
      c.status === 'open' && amount
        ? {
            token: 'USDC',
            tokenContract: USDC.contract,
            amount,
            expiresAt: iso(now() + 60_000),
            recipient: c.recipientAddress,
          }
        : null,
  };
}

const RESERVED = [...RESERVED_HANDLES, BRAND.name.toLowerCase()];

export const appRoutes: [ApiRequest['method'], string, Handler][] = [
  // This origin's stellar.toml: the SEP-10 signing key the web checks challenges against.
  [
    'GET',
    '/.well-known/stellar.toml',
    () =>
      ok(
        [
          `NETWORK_PASSPHRASE = "${PASSPHRASE}"`,
          `WEB_AUTH_ENDPOINT = "${location.origin}/v1/auth/challenge"`,
          `SIGNING_KEY = "${SEP10_SIGNER.publicKey()}"`,
          '',
        ].join(String.fromCharCode(10)),
      ),
  ],
  [
    'GET',
    '/v1/app/profile',
    () => {
      const s = session();
      return s ? ok(profile(s.address)) : unauth();
    },
  ],
  [
    'PUT',
    '/v1/app/profile',
    ({ body }) => {
      const s = session();
      if (!s) return unauth();
      const h = normalizeHandle(String(body.handle ?? ''));
      if (!h) return fail(422, 'invalid_handle', 'A handle has 3 to 20 of a-z, 0-9 and _.');
      if (RESERVED.includes(h)) return fail(422, 'handle_reserved', 'This handle is reserved.');
      const owner = db().handles[h];
      if (owner && owner !== s.address) return fail(409, 'handle_taken', 'Someone has this handle.');
      for (const [k, v] of Object.entries(db().handles)) if (v === s.address) delete db().handles[k];
      db().handles[h] = s.address;
      save();
      return ok(profile(s.address));
    },
  ],
  [
    'GET',
    '/v1/app/handles/:handle',
    ({ params }) => {
      if (!session()) return unauth();
      const h = normalizeHandle(params.handle);
      const address = h ? db().handles[h] : null;
      return address ? ok({ handle: h, address }) : fail(404, 'not_found', 'Nobody has this handle.');
    },
  ],
  [
    'GET',
    '/v1/app/balances',
    () => {
      const s = session();
      return s ? ok(balances(s.address)) : unauth();
    },
  ],
  [
    'POST',
    '/v1/app/activate',
    ({ body }) => {
      const s = session();
      if (!s) return unauth();
      if (body.token !== 'USDC' && body.token !== USDC.contract)
        return fail(422, 'unknown_token', 'Unknown token.');
      return ok({ transaction: activationTx(s.address) });
    },
  ],
  [
    'POST',
    '/v1/app/transfers',
    async ({ body }) => {
      const s = session();
      if (!s) return unauth();
      const recipient = normalizeRecipient(String(body.to ?? ''));
      if (!recipient) return fail(422, 'invalid_recipient', 'Not an address or @handle.');
      let to = recipient;
      let toHandle: string | null = null;
      if (recipient.startsWith('@')) {
        toHandle = recipient.slice(1);
        const a = db().handles[toHandle];
        if (!a) return fail(404, 'handle_not_found', 'Nobody has this handle.');
        to = a;
      }
      if (!isDestination(to)) return fail(422, 'invalid_recipient', 'Not an address.');
      const base = to.startsWith('M') ? null : to;
      if (to === s.address || base === s.address)
        return fail(422, 'self_transfer', 'That is your own wallet.');
      const amount = String(body.amount ?? '');
      if (!/^\d+$/.test(amount) || amount === '0') return fail(422, 'invalid_amount', 'Bad amount.');
      const note = body.note ? String(body.note) : null;
      if (note && new TextEncoder().encode(note).length > 28)
        return fail(422, 'invalid_note', 'A note holds at most 28 bytes.');
      const have = BigInt(chainAccount(s.address)?.trust.USDC ?? '0');
      if (have < BigInt(amount)) return fail(422, 'insufficient_balance', 'More than the balance.');
      if (to.startsWith('G')) {
        const dest = chainAccount(to);
        if (!dest?.exists || dest.trust.USDC === null || dest.trust.USDC === undefined)
          return fail(422, 'recipient_cannot_receive', 'This wallet cannot receive USDC yet.');
      }
      const tx = transferTx(s.address, to, amount, to.startsWith('C') ? null : note);
      const transfer = {
        id: crypto.randomUUID(),
        network: NETWORK.id,
        token: 'USDC',
        amount,
        from: s.address,
        fromHandle: handleOf(s.address),
        to,
        toHandle: toHandle ?? handleOf(to),
        note,
        status: 'PENDING',
        hash: null,
        createdAt: iso(now()),
        completedAt: null,
        _hash: tx.hash,
      };
      db().transfers.push(transfer);
      save();
      return ok({ transfer: transferView(transfer, s.address), transaction: tx }, 201);
    },
  ],
  [
    'GET',
    '/v1/app/transfers/:id',
    ({ params }) => {
      const s = session();
      if (!s) return unauth();
      const t = db().transfers.find(
        (x) => x.id === params.id && (x.from === s.address || x.to === s.address),
      );
      return t ? ok(transferView(t, s.address)) : fail(404, 'not_found', 'Transfer not found.');
    },
  ],
  [
    'GET',
    '/v1/app/activity',
    ({ req }) => {
      const s = session();
      if (!s) return unauth();
      const items = [
        ...db()
          .transfers.filter(
            (t) => (t.from === s.address || t.to === s.address) && t.status !== 'PENDING',
          )
          .map((t) => ({ type: 'transfer', at: t.createdAt, transfer: transferView(t, s.address) })),
        ...myAppOrders(s.address).map((o) => ({
          type: 'order',
          at: o.createdAt,
          order: orderView(tick(o), 'client'),
        })),
      ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const limit = Math.min(50, Number(req.query?.limit ?? 20) || 20);
      const start = Number(req.query?.cursor ?? 0) || 0;
      const page = items.slice(start, start + limit);
      return ok({ items: page, nextCursor: start + limit < items.length ? String(start + limit) : null });
    },
  ],
  [
    'GET',
    '/v1/app/charges/:id',
    ({ params }) => {
      if (!session()) return unauth();
      const c = db().charges.find((x) => x.id === params.id);
      return c ? ok(payerCharge(c)) : fail(404, 'not_found', 'Charge not found.');
    },
  ],
  [
    'POST',
    '/v1/app/charges/:id/payments',
    ({ params }) => {
      const s = session();
      if (!s) return unauth();
      const c = db().charges.find((x) => x.id === params.id);
      if (!c) return fail(404, 'not_found', 'Charge not found.');
      const view = payerCharge(c);
      if (!view.payWithBalance) return fail(409, 'charge_closed', 'This charge is not open.');
      const amount = view.payWithBalance.amount;
      const have = BigInt(chainAccount(s.address)?.trust.USDC ?? '0');
      if (have < BigInt(amount)) return fail(422, 'insufficient_balance', 'More than the balance.');
      const tx = transferTx(s.address, c.recipientAddress, amount, null);
      const payment = {
        id: rid('chp', 12),
        chargeId: c.id,
        network: NETWORK.id,
        token: 'USDC',
        amount,
        hash: tx.hash,
        status: 'PENDING',
        expiresAt: view.payWithBalance.expiresAt,
        _hash: tx.hash,
      };
      db().chargePayments[payment.id] = payment;
      save();
      const { _hash: _h, ...pubPayment } = payment;
      return ok({ payment: pubPayment, transaction: tx }, 201);
    },
  ],
  [
    'POST',
    '/v1/app/submit',
    ({ body }) => {
      const s = session();
      if (!s) return unauth();
      return ok(submitEnvelope(String(body.xdr ?? ''), [s.address]));
    },
  ],
  [
    'GET',
    '/v1/app/submissions/:hash',
    ({ params }) => {
      if (!session()) return unauth();
      const r = db().chain.submissions[params.hash];
      return r
        ? ok({ hash: params.hash, status: r.status, error: r.error })
        : fail(404, 'not_found', 'Submission not found.');
    },
  ],
];

