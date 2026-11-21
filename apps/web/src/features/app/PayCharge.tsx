/* Pay a business's charge: who charges, the amount in local money and what it costs in USDC from
   the balance (priced for a minute), paid with one signature; or in local money through the
   hosted checkout (/pay/<id>). The signed transfer must pay exactly the amount shown to the
   charge's receiving account the API names for this payment. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Skeleton } from '@/components/ui/controls';
import { useNow } from '@/components/ui/misc';
import { SignFlow } from '@/components/wallet/SignFlow';
import { app, appSubmitter } from '@/lib/api/app';
import { ApiError } from '@/lib/api/client';
import { isNotFound } from '@/lib/api/messages';
import { money, shortAddress } from '@/lib/format';
import { countdown, msLeft } from '@/lib/p2p/orders';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { Facts, useUsd, WalletSummary } from '@/features/app/parts';
import { balancePrice, chargeExpectation } from '@/lib/app/charge';
import type { ChargePayment, PayerCharge } from '@/lib/app/types';

export default function PayCharge() {
  const { t, lang } = useI18n();
  const c = t.app.charge;
  const { id = '' } = useParams();
  const { session } = useSession();
  const { market, network, token, balance, refresh } = useAppData();
  const fmtUsd = useUsd();
  const [charge, setCharge] = useState<PayerCharge | null | undefined>(undefined);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState('');
  const payment = useRef<ChargePayment | null>(null);
  const now = useNow(!!charge?.payWithBalance);

  const load = useCallback(() => {
    payment.current = null;
    app
      .charge(id)
      .then(setCharge)
      .catch((e) => setCharge(isNotFound(e) ? null : null));
  }, [id]);
  useEffect(load, [load]);

  // The price only in the token the app pays with; any other asset is no price at all.
  const price = charge ? balancePrice(charge, token) : null;
  const expired = !!price && Date.parse(price.expiresAt) <= now;
  useEffect(() => {
    if (expired && !paid) load();
  }, [expired, paid, load]);

  if (charge === undefined || !network || !token || !market || !session)
    return (
      <Screen back title={c.title} aside={<WalletSummary />}>
        <Skeleton className="h-64" />
      </Screen>
    );
  if (charge === null)
    return (
      <Screen back title={c.title} aside={<WalletSummary />}>
        <Notice tone="warn">{c.notFound}</Notice>
      </Screen>
    );

  const merchant = charge.merchantName ?? '-';
  const local = money(lang, charge.fiatAmount, charge.currency);
  if (paid && price)
    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 pt-10 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-ok-soft text-ok" aria-hidden="true">
            <Icon name="check" size={34} strokeWidth={2.4} />
          </span>
          <h1 className="text-[1.75rem]">{c.paidTitle}</h1>
          <p className="text-ink-2">{fmt(c.paidBody, { amount: local, merchant })}</p>
        </div>
        <Link to="/app" className="btn btn-ink btn-lg mb-4">
          {t.app.send.done}
        </Link>
      </Screen>
    );

  const short = !!price && BigInt(price.amount) > BigInt(balance || '0');
  return (
    <Screen back title={c.title} aside={<WalletSummary />}>
      <div className="flex flex-col gap-4 pb-4">
        <div className="rounded-[20px] bg-well px-4 py-5 text-center">
          <p className="text-ink-3">{c.from}</p>
          <p className="mt-0.5 text-[1.2rem] font-bold">{merchant}</p>
          {charge.description && <p className="mt-1 text-ink-2">{charge.description}</p>}
          <p className="figure mt-3 text-[2.3rem]">
            <span className="marker">{local}</span>
          </p>
        </div>
        {charge.status !== 'open' && <Notice tone="warn">{c.closed}</Notice>}
        {charge.status === 'open' && !price && <Notice tone="warn">{c.unavailable}</Notice>}
        {charge.status === 'open' && price && (
          <>
            <Facts
              rows={[
                [c.inUsd, fmtUsd(price.amount)],
                [c.to, shortAddress(price.recipient)],
                [t.app.send.fee, market.sponsor.enabled ? t.app.send.free : '-'],
              ]}
            />
            <p className="num text-center text-[0.8125rem] text-ink-3">
              {fmt(c.validFor, { time: countdown(msLeft(price.expiresAt, now)) })}
            </p>
            {short ? (
              <Notice tone="warn">{c.insufficient}</Notice>
            ) : (
              <SignFlow
                network={network}
                signer={session.address}
                via={appSubmitter}
                sponsored={market.sponsor.enabled}
                startLabel={fmt(c.payWithBalance, { amount: fmtUsd(price.amount) })}
                steps={[
                  {
                    label: fmt(c.step, { amount: fmtUsd(price.amount), merchant }),
                    build: async () => {
                      setError('');
                      const r = await app.payCharge(charge.id, {
                        network: network.id,
                        token: token.symbol,
                      });
                      payment.current = r.payment;
                      return r.transaction;
                    },
                    expect: null,
                    // The token the app pays with, to the account and for the amount shown here.
                    expectFor: () => chargeExpectation(charge, price, token, payment.current),
                  },
                ]}
                onError={(e) => {
                  if (e instanceof ApiError && e.code === 'insufficient_balance') setError(c.insufficient);
                  else if (e instanceof ApiError && e.status === 409) load();
                }}
                onDone={() => {
                  setPaid(true);
                  refresh();
                }}
              />
            )}
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {charge.status === 'open' && (
          <Link to={`/pay/${encodeURIComponent(charge.id)}`} className="btn btn-line btn-lg">
            {fmt(c.payInPesos, { currency: charge.currency })}
          </Link>
        )}
      </div>
    </Screen>
  );
}
