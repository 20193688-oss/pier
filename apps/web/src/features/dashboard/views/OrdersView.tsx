/* Orders: the ones this organization's merchant wallets must complete (release a purchase once the
   money arrived; accept, pay the beneficiary and mark paid on a sale or a payout) and the ones it
   opened as a client (report a transfer, cancel, dispute, release a payout), each with its
   running deadline. On-chain actions are signed by the order's own wallet of this organization,
   after the check in SignFlow; the reconciliation helper finds the orders a bank transfer settles. */
import { useEffect, useMemo, useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import {
  accounts as accountsApi,
  clientOrders,
  merchant as merchantApi,
} from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { decimalsFrom } from '@/lib/p2p/normalize';
import {
  activeDeadline,
  clientActions,
  countdown,
  isTerminal,
  merchantActions,
  merchantSells,
  msLeft,
  type ClientAction,
  type MerchantAction,
} from '@/lib/p2p/orders';
import { explorerTx } from '@/lib/p2p/tx-check';
import { matchConfidence } from '@/lib/p2p/normalize';
import { checkHolderName } from '@/lib/p2p/rails';
import { dateTime, money, percent, units } from '@/lib/format';
import { Field, Notice, SelectField, Spinner } from '@/components/ui/controls';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Address, Empty, StatusPill, useNow } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { accountRows, railName, TokenMark } from '@/components/p2p/parts';
import { useDash } from '@/features/dashboard/context';
import {
  Figures,
  LoadState,
  PageHead,
  ReadOnly,
  SignDialog,
  useLoad,
} from '@/features/dashboard/ui';
import { accountStep } from '@/features/dashboard/tx';
import type { TxStep } from '@/components/wallet/SignFlow';
import type { P2pAccount, P2pMarket, P2pOrder, P2pTransferMatch } from '@/lib/p2p/types';

type Tab = 'merchant' | 'client';
type Signing = {
  title: string;
  intro?: string;
  order: P2pOrder;
  account: P2pAccount;
  steps: TxStep[];
};

const DONE = ['completed', 'resolved'];

export function OrdersView() {
  const { t, lang } = useI18n();
  const o = t.p2p.orders;
  const toast = useToast();
  const { scope, market, canWrite } = useDash();
  const [tab, setTab] = useState<Tab>('merchant');
  const load = useLoad(async () => {
    if (!market) return null;
    const dec = decimalsFrom(market);
    const [mine, client, accounts] = await Promise.all([
      merchantApi.orders(scope, dec),
      clientOrders.list(scope, dec),
      accountsApi.list(scope),
    ]);
    return { mine, client, accounts };
  }, [scope.org, scope.tier, market]);
  const now = useNow(true);
  // Orders move as the indexer reads the chain: read them again every few seconds while any is
  // live and the page is in view.
  const hasLive =
    !!load.data && [...load.data.mine, ...load.data.client].some((x) => !isTerminal(x.status));
  const { reload } = load;
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => {
      if (!document.hidden) reload();
    }, 5000);
    return () => clearInterval(id);
  }, [hasLive, reload]);
  const [signing, setSigning] = useState<Signing | null>(null);
  const [confirm, setConfirm] = useState<{
    order: P2pOrder;
    action: 'paid' | 'cancel' | 'dispute';
  } | null>(null);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const data = load.data;
  const accounts = data?.accounts ?? [];
  const list = (tab === 'merchant' ? data?.mine : data?.client) ?? [];
  const figures = useMemo(() => {
    const mine = data?.mine ?? [];
    const month = Date.now() - 30 * 86400_000;
    return {
      toAct: mine.filter((x) => merchantActions(x).some((a) => a !== 'cancel')).length,
      live: [...mine, ...(data?.client ?? [])].filter((x) => !isTerminal(x.status)).length,
      filled: mine.filter(
        (x) => DONE.includes(x.status) && Date.parse(x.updatedAt ?? x.createdAt) > month,
      ).length,
      disputed: mine.filter((x) => x.status === 'disputed').length,
    };
  }, [data]);

  const accountOf = (address: string | null) =>
    accounts.find((a) => address && a.address.toLowerCase() === address.toLowerCase()) ?? null;
  const net = (id: string) => market?.networks.find((n) => n.id === id);

  /* A merchant's action: its wallet on this order is the seller of a purchase, the buyer of a
     sale or payout. */
  const merchantAct = (order: P2pOrder, action: MerchantAction) => {
    const account = accountOf(merchantSells(order.kind) ? order.seller : order.buyer);
    if (!account) return setError(o.noWallet);
    const label = o.actions[action];
    setSigning({
      title: label,
      intro:
        action === 'release'
          ? fmt(o.checkPayer, {
              amount: money(lang, order.fiatAmount, order.currency),
              name: order.payer?.name ?? '-',
            })
          : action === 'dispute'
            ? o.disputeBody
            : undefined,
      order,
      account,
      steps: [
        accountStep(
          scope,
          { network: order.network, accountId: account.id, action, args: { orderId: order.id } },
          label,
          { action, orderId: order.onchainId ?? null },
        ),
      ],
    });
  };

  /* A client's action: through the API on a purchase (the matcher acts for the buyer), signed by
     the paying wallet on a payout. */
  const clientAct = (order: P2pOrder, action: ClientAction) => {
    if (merchantSells(order.kind)) {
      if (action === 'release') return;
      setReference('');
      setConfirm({ order, action });
      return;
    }
    const account = accountOf(order.seller);
    if (!account) return setError(o.noWallet);
    const label = o.actions[action];
    const onchain = action === 'paid' ? 'markPaid' : action;
    setSigning({
      title: label,
      intro:
        action === 'release' ? o.releaseBody : action === 'dispute' ? o.disputeBody : undefined,
      order,
      account,
      steps: [
        accountStep(
          scope,
          {
            network: order.network,
            accountId: account.id,
            action: onchain,
            args: { orderId: order.id },
          },
          label,
          { action: onchain, orderId: order.onchainId ?? null },
        ),
      ],
    });
  };

  const runConfirm = async () => {
    if (!confirm || !market) return;
    setBusy(true);
    setError('');
    try {
      await clientOrders.act(
        scope,
        confirm.order.id,
        confirm.action,
        confirm.action === 'paid' && reference.trim() ? { reference: reference.trim() } : {},
        decimalsFrom(market),
      );
      toast(o.done[confirm.action]);
      setConfirm(null);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e, o.failed));
    } finally {
      setBusy(false);
    }
  };

  const groups = [
    { key: 'live' as const, items: list.filter((x) => !isTerminal(x.status)) },
    { key: 'done' as const, items: list.filter((x) => DONE.includes(x.status)) },
    {
      key: 'failed' as const,
      items: list.filter((x) => isTerminal(x.status) && !DONE.includes(x.status)),
    },
  ].filter((g) => g.items.length);

  return (
    <>
      <PageHead title={o.title} />
      {!canWrite && <ReadOnly />}
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      {data && (
        <Figures
          label={o.figuresLabel}
          items={[
            { label: o.figures.toAct, value: figures.toAct, sub: o.figures.toActSub },
            { label: o.figures.live, value: figures.live },
            { label: o.figures.filled, value: figures.filled, sub: o.figures.filledSub },
            { label: o.figures.disputed, value: figures.disputed, sub: o.figures.disputedSub },
          ]}
        />
      )}
      <div className="seg mb-6 max-w-md" role="tablist" aria-label={o.title}>
        {(['merchant', 'client'] as const).map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            onClick={() => setTab(x)}
          >
            {o.tabs[x]}
          </button>
        ))}
      </div>
      {tab === 'merchant' && canWrite && market && data && (
        <TransferMatches market={market} accounts={accounts} onRelease={(s) => setSigning(s)} />
      )}
      <LoadState
        load={load}
        isEmpty={(d) => !d || (tab === 'merchant' ? d.mine : d.client).length === 0}
        empty={<Empty title={o.title} body={o.nothingToDo} />}
      >
        {() => (
          <div className="flex flex-col gap-8">
            {groups.map((g) => (
              <section key={g.key} aria-label={o.groups[g.key]}>
                <h2 className="mb-3 text-[1.15rem]">{o.groups[g.key]}</h2>
                <ul className="flex flex-col gap-3" role="list">
                  {g.items.map((order) => {
                    const deadline = activeDeadline(order);
                    const actions =
                      tab === 'merchant' ? merchantActions(order, now) : clientActions(order, now);
                    const sells = merchantSells(order.kind);
                    const network = net(order.network);
                    const txLink = explorerTx(
                      network,
                      order.txs?.release ?? order.txs?.open ?? null,
                    );
                    return (
                      <li key={order.id} className="sheet p-4">
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <TokenMark symbol={order.token} network={network?.name} size={34} />
                            <div className="min-w-0">
                              <p className="num font-semibold">
                                {(t.p2p.kinds as Record<string, string>)[order.kind]}:{' '}
                                {money(lang, order.fiatAmount, order.currency)}
                              </p>
                              <p className="num text-[0.875rem] text-ink-3">
                                {units(lang, order.tokenAmount, order.token)},{' '}
                                {railName(t.p2p, order.rail)}, {dateTime(lang, order.createdAt)}
                              </p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {deadline && (
                              <span
                                className="num inline-flex items-center gap-1.5 rounded-full bg-well px-2.5 py-1 text-[0.8125rem] font-semibold"
                                role="timer"
                              >
                                <Icon name="clock" size={14} />
                                {countdown(msLeft(deadline.at, now))}
                              </span>
                            )}
                            <StatusPill status={order.status}>
                              {(t.p2p.status as Record<string, string>)[order.status] ??
                                order.status}
                            </StatusPill>
                          </div>
                        </div>
                        {canWrite && actions.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {tab === 'merchant'
                              ? (actions as MerchantAction[]).map((a) => (
                                  <button
                                    key={a}
                                    type="button"
                                    className={`btn btn-sm ${a === 'release' || a === 'accept' || a === 'markPaid' ? 'btn-ink' : 'btn-line'}`}
                                    onClick={() => merchantAct(order, a)}
                                  >
                                    {o.actions[a]}
                                  </button>
                                ))
                              : (actions as ClientAction[]).map((a) => (
                                  <button
                                    key={a}
                                    type="button"
                                    className={`btn btn-sm ${a === 'release' || a === 'paid' ? 'btn-ink' : 'btn-line'}`}
                                    onClick={() => clientAct(order, a)}
                                  >
                                    {o.actions[a]}
                                  </button>
                                ))}
                          </div>
                        )}
                        <details className="mt-3">
                          <summary className="cursor-pointer text-[0.875rem] font-semibold text-ink-2">
                            {fmt(t.trade.order.eyebrow, { id: order.id.slice(-8) })}
                          </summary>
                          <dl className="mt-2 grid gap-x-6 gap-y-1 text-[0.9375rem] sm:grid-cols-2">
                            <div className="flex justify-between gap-3">
                              <dt className="text-ink-3">{o.fields.price}</dt>
                              <dd className="num">
                                {order.price} {order.currency}
                              </dd>
                            </div>
                            {order.merchant?.displayName && (
                              <div className="flex justify-between gap-3">
                                <dt className="text-ink-3">{o.fields.merchant}</dt>
                                <dd>{order.merchant.displayName}</dd>
                              </div>
                            )}
                            {order.payer && (
                              <div className="flex justify-between gap-3">
                                <dt className="text-ink-3">{o.fields.payer}</dt>
                                <dd className="text-right">
                                  {order.payer.name}, {order.payer.document}
                                </dd>
                              </div>
                            )}
                            {order.buyer && (
                              <div className="flex justify-between gap-3">
                                <dt className="text-ink-3">{o.fields.buyer}</dt>
                                <dd>
                                  <Address value={order.buyer} />
                                </dd>
                              </div>
                            )}
                            {order.seller && (
                              <div className="flex justify-between gap-3">
                                <dt className="text-ink-3">{o.fields.seller}</dt>
                                <dd>
                                  <Address value={order.seller} />
                                </dd>
                              </div>
                            )}
                            {order.bond && (
                              <div className="flex justify-between gap-3">
                                <dt className="text-ink-3">{o.fields.bond}</dt>
                                <dd className="num">{units(lang, order.bond, order.token)}</dd>
                              </div>
                            )}
                            {order.paidReference && (
                              <div className="flex justify-between gap-3">
                                <dt className="text-ink-3">{o.fields.reference}</dt>
                                <dd className="num">{order.paidReference}</dd>
                              </div>
                            )}
                            {order.externalReference && (
                              <div className="flex justify-between gap-3">
                                <dt className="text-ink-3">{o.fields.externalReference}</dt>
                                <dd className="num">{order.externalReference}</dd>
                              </div>
                            )}
                          </dl>
                          {/* The merchant pays the beneficiary of a sale or payout: its account. */}
                          {tab === 'merchant' && !sells && order.paymentDetails && (
                            <div className="mt-3 rounded-[14px] bg-well p-3">
                              <p className="text-[0.875rem] font-semibold">{o.payToTitle}</p>
                              <dl className="mt-1 grid gap-x-6 gap-y-1 text-[0.9375rem] sm:grid-cols-2">
                                {accountRows(t.p2p, order.paymentDetails).map(([k, v]) => (
                                  <div key={k} className="flex justify-between gap-3">
                                    <dt className="text-ink-3">{k}</dt>
                                    <dd className="num break-all text-right">{v}</dd>
                                  </div>
                                ))}
                              </dl>
                            </div>
                          )}
                          {txLink && (
                            <a
                              className="mt-2 inline-flex items-center gap-1.5 text-[0.875rem] font-semibold underline underline-offset-4"
                              href={txLink}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {o.explorer}
                              <Icon name="external" size={14} />
                            </a>
                          )}
                        </details>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </LoadState>

      {signing && net(signing.order.network) && (
        <SignDialog
          title={signing.title}
          intro={signing.intro}
          network={net(signing.order.network)!}
          signer={signing.account.address}
          steps={signing.steps}
          onClose={() => setSigning(null)}
          onDone={() => {
            setSigning(null);
            toast(t.dash.liq.sent);
            load.reload();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'paid' ? o.actions.paid : o.confirm[confirm.action].title}
          body={
            confirm.action === 'paid' ? (
              <Field
                label={o.referenceLabel}
                hint={o.referenceHint}
                placeholder={o.referencePlaceholder}
                value={reference}
                maxLength={60}
                onChange={(e) => setReference(e.target.value)}
              />
            ) : (
              o.confirm[confirm.action].body
            )
          }
          confirmLabel={o.actions[confirm.action]}
          danger={confirm.action === 'cancel'}
          busy={busy}
          onConfirm={() => void runConfirm()}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}

/** A bank transfer the merchant received: which of its live purchases it most likely settles,
    each with its release ready to sign. */
function TransferMatches({
  market,
  accounts,
  onRelease,
}: {
  market: P2pMarket;
  accounts: P2pAccount[];
  onRelease: (s: Signing) => void;
}) {
  const { t, lang } = useI18n();
  const m = t.p2p.bots.matches;
  const { scope } = useDash();
  const [form, setForm] = useState({
    currency: market.currencies[0]?.code ?? 'ARS',
    amount: '',
    payerName: '',
    payerDocument: '',
    reference: '',
  });
  const [matches, setMatches] = useState<P2pTransferMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const find = async () => {
    if (!form.amount.trim()) return;
    setBusy(true);
    setError('');
    try {
      setMatches(
        await merchantApi.transferMatches(scope, {
          currency: form.currency,
          amount: form.amount.trim().replace(',', '.'),
          ...(form.payerName.trim() && !checkHolderName(form.payerName)
            ? { payerName: form.payerName.trim() }
            : {}),
          ...(form.payerDocument.trim() ? { payerDocument: form.payerDocument.trim() } : {}),
          ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
        }),
      );
    } catch (e) {
      setError(errorMessage(t.common, e, m.failed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="sheet mb-6 p-4">
      <summary className="cursor-pointer font-semibold">{m.title}</summary>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <SelectField
          label={t.p2p.offers.currency}
          value={form.currency}
          onChange={(e) => setForm({ ...form, currency: e.target.value })}
          options={market.currencies.map((c) => ({ value: c.code, label: c.code }))}
        />
        <Field
          label={m.amount}
          inputMode="decimal"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />
        <Field
          label={m.payerName}
          value={form.payerName}
          onChange={(e) => setForm({ ...form, payerName: e.target.value })}
        />
        <Field
          label={m.payerDocument}
          value={form.payerDocument}
          onChange={(e) => setForm({ ...form, payerDocument: e.target.value })}
        />
        <Field
          label={m.reference}
          value={form.reference}
          onChange={(e) => setForm({ ...form, reference: e.target.value })}
        />
        <div className="flex items-end">
          <button
            type="submit"
            className="btn btn-ink w-full"
            disabled={busy || !form.amount.trim()}
          >
            {busy && <Spinner />}
            {busy ? m.finding : m.find}
          </button>
        </div>
      </form>
      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
      {matches && !matches.length && <p className="mt-3 text-ink-3">{m.none}</p>}
      {matches && matches.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" role="list">
          {matches.map((x) => {
            const account = accounts.find(
              (a) => x.order.seller && a.address.toLowerCase() === x.order.seller.toLowerCase(),
            );
            return (
              <li
                key={x.order.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-well p-3"
              >
                <span className="num">
                  {money(lang, x.order.fiatAmount, x.order.currency)}, {x.order.payer?.name ?? '-'}{' '}
                  ({m.score}: {percent(lang, matchConfidence(x.score))})
                </span>
                {account && (
                  <button
                    type="button"
                    className="btn btn-ink btn-sm"
                    onClick={() =>
                      onRelease({
                        title: t.p2p.orders.actions.release,
                        intro: fmt(t.p2p.orders.checkPayer, {
                          amount: money(lang, x.order.fiatAmount, x.order.currency),
                          name: x.order.payer?.name ?? '-',
                        }),
                        order: x.order,
                        account,
                        steps: [
                          {
                            label: t.p2p.orders.actions.release,
                            build: async () => x.transaction,
                            expect: { action: 'release', orderId: x.order.onchainId ?? null },
                          },
                        ],
                      })
                    }
                  >
                    {t.p2p.orders.actions.release}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
