/* Payouts: pay many people in local money from one CSV file. The file is read and checked in the
   browser (src/lib/p2p/csv.ts), each row's problems next to it, and only valid rows are sent as a
   batch on one of the organization's wallets. A merchant buys each payout's USDC, transfers to
   the beneficiary and marks it paid; the organization then releases it, signed by the paying
   wallet after the release is checked against the order on screen. */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { fmt, useI18n } from '@/i18n';
import { accounts as accountsApi, clientOrders, payouts as payoutsApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { decimalsFrom } from '@/lib/p2p/normalize';
import {
  parsePayoutCsv,
  payoutItems,
  payoutTemplate,
  PAYOUT_MAX_ITEMS,
  type PayoutFile,
} from '@/lib/p2p/csv';
import { dateTime, money, shortAddress } from '@/lib/format';
import type { P2pAccount, P2pPayoutBatch, P2pPayoutItem } from '@/lib/p2p/types';
import { Notice, SelectField, Spinner } from '@/components/ui/controls';
import { Dialog } from '@/components/ui/Dialog';
import { Empty, Pill, StatusPill } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { errorText, fieldKind, railName } from '@/components/p2p/parts';
import { useDash } from '@/features/dashboard/context';
import {
  Figures,
  LoadState,
  PageHead,
  ReadOnly,
  SignDialog,
  useLoad,
} from '@/features/dashboard/ui';
import { batchProgress, payoutFigures } from '@/features/dashboard/views/admin-model';
import { useGuard } from '@/lib/use-action';

const BATCH_TONE = { processing: 'pend', completed: 'ok', partial: 'ref', failed: 'fail' } as const;
const MAX_FILE_BYTES = 1_000_000;

export function PayoutsView() {
  const { t } = useI18n();
  const p = t.p2p.payouts;
  const a = t.admin.payouts;
  const { scope, market, canWrite } = useDash();
  const load = useLoad(
    () => payoutsApi.list(scope, decimalsFrom(market)),
    [scope.org, scope.tier, market],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (selected)
    return (
      <BatchDetail
        id={selected}
        onBack={() => {
          setSelected(null);
          load.reload();
        }}
      />
    );

  const figures = load.data ? payoutFigures(load.data) : null;
  return (
    <>
      <PageHead
        title={p.title}
        lede={a.lede}
        actions={
          canWrite && (
            <button type="button" className="btn btn-ink" onClick={() => setCreating(true)}>
              <Icon name="upload" size={18} />
              {p.create}
            </button>
          )
        }
      />
      {!canWrite && <ReadOnly />}
      {figures && (
        <Figures
          label={p.figuresLabel}
          items={[
            { label: p.figures.batches, value: figures.batches },
            { label: p.figures.items, value: figures.items },
            { label: p.figures.completed, value: figures.completed },
            { label: p.figures.toRelease, value: figures.toRelease, sub: p.figures.toReleaseSub },
          ]}
        />
      )}
      <LoadState load={load} empty={<Empty title={a.empty} body={a.emptyBody} />}>
        {(batches) => (
          <ul className="flex flex-col gap-3" role="list" aria-label={p.title}>
            {batches.map((b) => (
              <li key={b.id}>
                <BatchRow batch={b} onOpen={() => setSelected(b.id)} />
              </li>
            ))}
          </ul>
        )}
      </LoadState>
      {creating && (
        <CreatePayouts
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
    </>
  );
}

function BatchRow({ batch, onOpen }: { batch: P2pPayoutBatch; onOpen: () => void }) {
  const { t, lang } = useI18n();
  const p = t.p2p.payouts;
  const a = t.admin.payouts;
  const { market } = useDash();
  const prog = batchProgress(batch);
  const network = market?.networks.find((n) => n.id === batch.network)?.name ?? batch.network;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="sheet flex w-full flex-wrap items-center gap-x-6 gap-y-2 p-4 text-left transition-colors hover:border-ink"
    >
      <span className="min-w-0 flex-1 basis-56">
        <b className="block font-semibold">
          {fmt(a.batchLabel, { id: batch.id.slice(-8), network })}
        </b>
        <span className="mt-1 flex flex-wrap gap-x-3 text-[0.875rem] text-ink-3">
          <span>{fmt(p.doneOf, { done: prog.done, total: prog.total })}</span>
          {prog.toRelease > 0 && (
            <span className="font-semibold text-warn">{fmt(p.paidN, { n: prog.toRelease })}</span>
          )}
          <span>{dateTime(lang, batch.createdAt)}</span>
        </span>
      </span>
      <Pill tone={BATCH_TONE[batch.status]}>{p.state[batch.status]}</Pill>
      <Icon name="chevronRight" size={18} />
    </button>
  );
}

function BatchDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, lang } = useI18n();
  const p = t.p2p.payouts;
  const a = t.admin.payouts;
  const toast = useToast();
  const { scope, market, canWrite } = useDash();
  const load = useLoad(
    () => payoutsApi.get(scope, id, decimalsFrom(market)),
    [id, scope.org, scope.tier, market],
  );
  const wallets = useLoad<P2pAccount[]>(() => accountsApi.list(scope), [scope.org, scope.tier]);
  const [releasing, setReleasing] = useState<P2pPayoutItem | null>(null);

  const batch = load.data;
  // Read the batch again while payouts are on their way (a merchant accepting, paying, marking
  // paid), never while a release is being signed.
  const moving = !!batch?.items.some((i) =>
    ['pending', 'awaiting_acceptance', 'awaiting_payment'].includes(i.status),
  );
  const { reload } = load;
  useEffect(() => {
    if (!moving || releasing) return;
    const id = setTimeout(reload, 5000);
    return () => clearTimeout(id);
  }, [batch, moving, releasing, reload]);
  const network = batch ? (market?.networks.find((n) => n.id === batch.network) ?? null) : null;
  const payer = batch ? (wallets.data?.find((w) => w.id === batch.accountId) ?? null) : null;

  return (
    <>
      <button type="button" className="btn btn-quiet btn-sm -ml-2 mb-3 px-2" onClick={onBack}>
        <Icon name="back" size={18} />
        {a.back}
      </button>
      <LoadState load={load}>
        {(b) => {
          const prog = batchProgress(b);
          return (
            <>
              <PageHead
                title={fmt(a.batchTitle, { id: b.id.slice(-8) })}
                lede={`${fmt(p.doneOf, { done: prog.done, total: prog.total })}. ${p.form.howBody}`}
              />
              <div className="mb-6 flex flex-wrap items-center gap-3">
                <Pill tone={BATCH_TONE[b.status]}>{p.state[b.status]}</Pill>
                <span className="text-[0.875rem] text-ink-3">
                  {p.head.from}:{' '}
                  {payer
                    ? (payer.label ?? shortAddress(payer.address))
                    : shortAddress(b.items.find((i) => i.seller)?.seller ?? '')}
                </span>
                <span className="text-[0.875rem] text-ink-3">{network?.name ?? b.network}</span>
              </div>
              <ul className="flex flex-col gap-3" role="list" aria-label={a.itemsLabel}>
                {b.items.map((item) => (
                  <li
                    key={`${item.index}-${item.orderId ?? 'x'}`}
                    className="sheet flex flex-wrap items-center gap-x-6 gap-y-2 p-4"
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="font-semibold">{item.beneficiaryName}</p>
                      <p className="mt-1 flex flex-wrap gap-x-3 text-[0.875rem] text-ink-3">
                        <span>{railName(t.p2p, item.rail)}</span>
                        {item.externalReference && (
                          <span>
                            {p.items.reference}: {item.externalReference}
                          </span>
                        )}
                        {item.status === 'rejected' && item.error && (
                          <span className="text-bad">
                            {fmt(a.rejectedReason, { reason: item.error })}
                          </span>
                        )}
                        {['awaiting_acceptance', 'awaiting_payment'].includes(item.status) && (
                          <span>{p.items.notPaid}</span>
                        )}
                      </p>
                    </div>
                    <p className="figure text-[1.1rem]">
                      {item.fiatAmount ? money(lang, item.fiatAmount, item.currency) : ''}
                    </p>
                    <StatusPill status={item.status === 'rejected' ? 'failed' : item.status}>
                      {(t.p2p.status as Record<string, string>)[item.status] ?? item.status}
                    </StatusPill>
                    {canWrite && item.status === 'paid' && network && (
                      <button
                        type="button"
                        className="btn btn-ink btn-sm"
                        onClick={() => setReleasing(item)}
                      >
                        {p.release}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          );
        }}
      </LoadState>
      {releasing && batch && network && (
        <SignDialog
          title={a.releaseTitle}
          intro={p.releaseBody}
          network={network}
          signer={releasing.seller ?? payer?.address ?? ''}
          steps={[
            {
              label: fmt(a.releaseStep, {
                name: releasing.beneficiaryName,
                amount: money(lang, releasing.fiatAmount, releasing.currency),
              }),
              build: () =>
                clientOrders.transaction(scope, {
                  network: batch.network,
                  from: batch.accountId,
                  action: 'release',
                  args: { orderId: releasing.orderId },
                }),
              // The order on screen: an item whose on-chain id is unknown is never signed for.
              expect: { action: 'release', orderId: releasing.onchainId ?? null },
            },
          ]}
          onDone={() => {
            setReleasing(null);
            toast(a.released);
            load.reload();
          }}
          onClose={() => setReleasing(null)}
        />
      )}
    </>
  );
}

function CreatePayouts({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (batchId: string) => void;
}) {
  const { t, lang } = useI18n();
  const p = t.p2p.payouts;
  const a = t.admin.payouts;
  const toast = useToast();
  const { scope, market } = useDash();
  const wallets = useLoad<P2pAccount[]>(() => accountsApi.list(scope), [scope.org, scope.tier]);
  const pairs = useMemo(
    () =>
      (market?.networks ?? []).flatMap((n) =>
        n.tokens.map((tk) => ({
          value: `${n.id}:${tk.symbol}`,
          label: fmt(t.trade.summary.onNetwork, { token: tk.symbol, network: n.name }),
        })),
      ),
    [market, t],
  );
  const [account, setAccount] = useState('');
  const [pair, setPair] = useState('');
  const [file, setFile] = useState<{ name: string; parsed: PayoutFile } | null>(null);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const list = wallets.data ?? [];
  const from = account || list[0]?.id || '';
  const pick = pair || pairs[0]?.value || '';
  const max = market?.maxPayoutItems ?? PAYOUT_MAX_ITEMS;
  const valid = file ? file.parsed.rows.filter((r) => Object.keys(r.errors).length === 0) : [];
  const invalid = file ? file.parsed.rows.length - valid.length : 0;
  const canSend =
    !!file &&
    !file.parsed.missing.length &&
    !file.parsed.tooMany &&
    valid.length > 0 &&
    !!from &&
    !!pick;

  const read = async (f: File | undefined) => {
    setFileError('');
    setFile(null);
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return setFileError(p.form.tooBig);
    try {
      const text = await f.text();
      setFile({
        name: f.name,
        parsed: parsePayoutCsv(
          text,
          market?.currencies.map((c) => c.code),
        ),
      });
    } catch {
      setFileError(p.form.unreadable);
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(
      new Blob([payoutTemplate()], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pier-payouts.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const guard = useGuard();
  const send = () =>
    guard(async () => {
      if (!canSend || !file) return;
      const [network, token] = pick.split(':');
      setBusy(true);
      setError('');
      try {
        const batch = await payoutsApi.create(
          scope,
          { accountId: from, network, token, items: payoutItems(file.parsed.rows) },
          decimalsFrom(market),
        );
        toast(p.created);
        onCreated(batch.id);
      } catch (e) {
        setError(errorMessage(t.common, e, p.createFailed));
      } finally {
        setBusy(false);
      }
    });

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void read(e.dataTransfer.files?.[0]);
  };

  const columnLabel = (key: string, rail: string) => {
    const columns = p.columns as Record<string, string>;
    const fields = t.p2p.fields as Record<string, string>;
    return columns[key] ?? fields[fieldKind(rail, key)] ?? fields[key] ?? key;
  };

  return (
    <Dialog
      title={a.createTitle}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-line" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button
            type="button"
            className="btn btn-ink"
            disabled={busy || !canSend}
            onClick={() => void send()}
          >
            {busy && <Spinner />}
            {busy
              ? a.sending
              : valid.length === 1
                ? p.form.sendOne
                : fmt(p.form.send, { n: valid.length })}
          </button>
        </>
      }
    >
      {!market ? (
        <Notice tone="warn">{t.dash.state.noMarket}</Notice>
      ) : wallets.data === undefined ? (
        <p className="flex items-center gap-2 text-ink-3" role="status">
          <Spinner />
          {t.dash.state.loading}
        </p>
      ) : !list.length ? (
        <Notice tone="warn">{a.needWallet}</Notice>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={a.payFrom}
              value={from}
              onChange={(e) => setAccount(e.target.value)}
              options={list.map((w) => ({
                value: w.id,
                label: w.label
                  ? `${w.label} (${shortAddress(w.address)})`
                  : shortAddress(w.address),
              }))}
            />
            <SelectField
              label={a.network}
              value={pick}
              onChange={(e) => setPair(e.target.value)}
              options={pairs}
            />
          </div>
          <div className="rounded-[16px] bg-well p-4 text-[0.9375rem]">
            <b>{p.form.howTitle}</b>
            <p className="mt-1 text-ink-2">{p.form.howBody}</p>
            <p className="mt-2 text-ink-2">{p.form.authoriseBody}</p>
          </div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-start gap-3 rounded-[16px] border-2 border-dashed p-5 transition-colors ${dragging ? 'border-ink bg-well' : 'border-line-2'}`}
          >
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label={a.fileLabel}
              onChange={(e) => void read(e.target.files?.[0])}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-line" onClick={() => input.current?.click()}>
                <Icon name="upload" size={18} />
                {file ? p.form.replace : p.form.choose}
              </button>
              <span className="text-[0.875rem] text-ink-3">
                {dragging ? a.dropHere : p.form.drop}
              </span>
            </div>
            {file && <p className="text-[0.875rem] font-semibold">{file.name}</p>}
            <p className="text-[0.8125rem] text-ink-3">{fmt(p.form.columns, { max })}</p>
            <button
              type="button"
              className="text-[0.875rem] font-semibold underline underline-offset-4"
              onClick={downloadTemplate}
            >
              <Icon name="download" size={16} className="mr-1 inline" />
              {p.form.template}
            </button>
          </div>
          {fileError && <Notice tone="error">{fileError}</Notice>}
          {file && file.parsed.missing.length > 0 && (
            <Notice tone="error" stay>
              {fmt(p.form.missing, { columns: file.parsed.missing.join(', ') })}
            </Notice>
          )}
          {file && file.parsed.tooMany && (
            <Notice tone="error" stay>{fmt(p.form.tooMany, { max })}</Notice>
          )}
          {file && !file.parsed.missing.length && (
            <>
              <p className="font-semibold" role="status">
                {fmt(p.form.summary, { valid: valid.length, invalid })}
              </p>
              {!valid.length && <Notice tone="warn">{a.noValid}</Notice>}
              <div className="max-h-80 overflow-auto rounded-[14px] border border-line">
                <table className="table min-w-[36rem]">
                  <thead>
                    <tr>
                      <th scope="col">{p.form.line}</th>
                      <th scope="col">{p.columns.holderName}</th>
                      <th scope="col">{p.columns.amount}</th>
                      <th scope="col">{p.columns.rail}</th>
                      <th scope="col">{p.columns.reference}</th>
                      <th scope="col">{p.form.check}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {file.parsed.rows.map((r) => {
                      const problems = Object.entries(r.errors);
                      return (
                        <tr key={r.line} className={problems.length ? 'bg-bad-soft/40' : ''}>
                          <td className="num">{r.line}</td>
                          <td>{r.holderName || '-'}</td>
                          <td className="num whitespace-nowrap">
                            {r.fiatAmount && r.currency
                              ? money(lang, r.fiatAmount, r.currency)
                              : r.fiatAmount || '-'}
                          </td>
                          <td>{r.rail ? railName(t.p2p, r.rail) : '-'}</td>
                          <td>{r.externalReference || '-'}</td>
                          <td>
                            {problems.length ? (
                              <ul className="flex flex-col gap-0.5 text-[0.8125rem] text-bad">
                                {problems.map(([key, err]) => (
                                  <li key={key}>
                                    {columnLabel(key, r.rail)}:{' '}
                                    {errorText(t.p2p, fieldKind(r.rail, key), err)}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-ok">
                                <Icon name="check" size={16} />
                                {p.form.ok}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
      {error && (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}
