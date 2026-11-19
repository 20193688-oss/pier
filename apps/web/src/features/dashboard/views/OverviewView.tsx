/* Overview: the organization's market at a glance: what is live, what completed this month, its
   liquidity, and the market's own rules on this tier (networks, currencies, fee, deadlines, bond). */
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import {
  accounts as accountsApi,
  clientOrders,
  merchant as merchantApi,
  offers as offersApi,
} from '@/lib/api/endpoints';
import { bpsLabel, fromBaseUnits } from '@/lib/p2p/amounts';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { isTerminal, merchantActions } from '@/lib/p2p/orders';
import { duration, money, units } from '@/lib/format';
import { Notice } from '@/components/ui/controls';
import { StatusPill } from '@/components/ui/misc';
import { useDash } from '@/features/dashboard/context';
import { Figures, LoadState, PageHead, useLoad } from '@/features/dashboard/ui';
import { isStale } from '@/features/dashboard/views/OffersView';

export function OverviewView() {
  const { t, lang } = useI18n();
  const v = t.p2p.overview;
  const { scope, market, org } = useDash();
  const load = useLoad(async () => {
    if (!market) return null;
    const dec = decimalsFrom(market);
    const [mine, client, offers, list] = await Promise.all([
      merchantApi.orders(scope, dec),
      clientOrders.list(scope, dec),
      offersApi.list(scope),
      accountsApi.list(scope),
    ]);
    const accounts = await Promise.all(
      list.map((a) => accountsApi.get(scope, a.id).catch(() => a)),
    );
    return { mine, client, offers, accounts };
  }, [scope.org, scope.tier, market]);

  return (
    <>
      <PageHead title={`${v.title}: ${org.name}`} />
      {market === null && (
        <Notice tone="warn" className="mb-6">
          {t.dash.state.error}
        </Notice>
      )}
      {market && !market.networks.length && (
        <Notice className="mb-6">{t.dash.state.noMarket}</Notice>
      )}
      <LoadState load={load} isEmpty={(d) => d === null}>
        {(d) => {
          if (!d || !market) return null;
          const live = [...d.mine, ...d.client].filter((x) => !isTerminal(x.status));
          const month = Date.now() - 30 * 86400_000;
          const filled = d.mine.filter(
            (x) =>
              (x.status === 'completed' || x.status === 'resolved') &&
              Date.parse(x.updatedAt ?? x.createdAt) > month,
          );
          const filledUsd = filled.reduce((s, x) => s + Number(x.tokenAmount), 0);
          const activeOffers = d.offers.filter((x) => x.active && !isStale(x)).length;
          let free = 0n;
          let authorised = 0;
          for (const a of d.accounts)
            for (const c of a.chains ?? []) {
              if (c.matcher) authorised += 1;
              for (const b of c.balances) if (b.decimals === 6) free += BigInt(b.freeUnits || '0');
            }
          const toAct = d.mine.filter((x) => merchantActions(x).some((a) => a !== 'cancel'));
          return (
            <>
              <Figures
                label={v.figuresLabel}
                items={[
                  { label: v.figures.live, value: live.length, sub: v.figures.liveSub },
                  {
                    label: v.figures.filled,
                    value: filled.length,
                    sub: fmt(v.figures.filledSub, { amount: units(lang, filledUsd, 'USD') }),
                  },
                  {
                    label: v.figures.offers,
                    value: activeOffers,
                    sub: fmt(v.figures.offersSub, { n: d.offers.length }),
                  },
                  { label: v.figures.wallets, value: d.accounts.length },
                ]}
              />
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="sheet p-5" aria-labelledby="ov-orders">
                  <div className="flex items-center justify-between gap-3">
                    <h2 id="ov-orders" className="text-[1.15rem]">
                      {v.orders.title}
                    </h2>
                    <Link
                      to="/dashboard/orders"
                      className="text-[0.875rem] font-semibold underline underline-offset-4"
                    >
                      {v.orders.all}
                    </Link>
                  </div>
                  {toAct.length ? (
                    <ul className="mt-3 flex flex-col divide-y divide-line" role="list">
                      {toAct.slice(0, 5).map((x) => (
                        <li
                          key={x.id}
                          className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                        >
                          <span className="num">
                            {(t.p2p.kinds as Record<string, string>)[x.kind]}:{' '}
                            {money(lang, x.fiatAmount, x.currency)}
                          </span>
                          <StatusPill status={x.status}>
                            {(t.p2p.status as Record<string, string>)[x.status]}
                          </StatusPill>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-ink-3">{t.p2p.orders.nothingToDo}</p>
                  )}
                </section>
                <section className="sheet p-5" aria-labelledby="ov-liq">
                  <div className="flex items-center justify-between gap-3">
                    <h2 id="ov-liq" className="text-[1.15rem]">
                      {v.liquidity.title}
                    </h2>
                    <Link
                      to="/dashboard/liquidity"
                      className="text-[0.875rem] font-semibold underline underline-offset-4"
                    >
                      {v.liquidity.manage}
                    </Link>
                  </div>
                  <p className="figure mt-4 text-[1.9rem]">
                    {units(lang, fromBaseUnits(free.toString(), 6), 'USD')}
                  </p>
                  <p className="mt-1 text-ink-3">
                    {d.accounts.length === 1
                      ? v.liquidity.walletsOne
                      : fmt(v.liquidity.wallets, { n: d.accounts.length })}
                  </p>
                  <p className="mt-1 text-ink-3">
                    {v.liquidity.authorised}: {authorised}
                  </p>
                </section>
                <section className="sheet p-5 lg:col-span-2" aria-labelledby="ov-market">
                  <h2 id="ov-market" className="text-[1.15rem]">
                    {v.market.title}
                  </h2>
                  <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-[0.8125rem] font-semibold text-ink-3">
                        {v.market.networks}
                      </dt>
                      <dd className="mt-1">
                        {market.networks.map((n) => n.name).join(', ') || '-'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[0.8125rem] font-semibold text-ink-3">
                        {v.market.currencies}
                      </dt>
                      <dd className="mt-1">
                        {market.currencies.map((c) => c.code).join(', ') || '-'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[0.8125rem] font-semibold text-ink-3">{v.market.fee}</dt>
                      <dd className="mt-1">{bpsLabel(market.protocolFeeBps, lang)}</dd>
                      <dd className="text-[0.8125rem] text-ink-3">{v.market.feeSub}</dd>
                    </div>
                    <div>
                      <dt className="text-[0.8125rem] font-semibold text-ink-3">
                        {v.market.window}
                      </dt>
                      <dd className="mt-1">
                        {duration(market.windows.paymentSeconds, t.common.time)}
                      </dd>
                      <dd className="text-[0.8125rem] text-ink-3">
                        {fmt(v.market.bond, { rate: bpsLabel(market.sellBondBps, lang) })}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            </>
          );
        }}
      </LoadState>
    </>
  );
}
