/* Send: who (an @handle, an address, a recent contact or a scan), how much, an optional note, then
   a review that shows the address a handle resolves to; the person signs and the transfer is
   followed until the network settles it. A payment link (/app/send?to=...&amount=...&note=...)
   opens this screen filled in. The signed transaction must pay exactly the reviewed address, amount
   and note (src/lib/p2p/tx-verify.ts). */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { normalizeRecipient } from '@pedospe/payment-qr';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Field, Notice, Spinner } from '@/components/ui/controls';
import { SignFlow } from '@/components/wallet/SignFlow';
import { app, appSubmitter } from '@/lib/api/app';
import { ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/messages';
import { dollarsToUnits, unitsToDecimal } from '@/lib/app/money';
import { parseDecimal } from '@/lib/p2p/amounts';
import { shortAddress } from '@/lib/format';
import { isDestination } from '@/lib/stellar/network';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { Facts, useLocal, useUsd } from '@/features/app/parts';

interface Recipient {
  /* What the person typed or picked: `@handle` or an address. */
  input: string;
  handle: string | null;
  /* The address the payment goes to. */
  address: string;
}

const noteBytes = (s: string) => new TextEncoder().encode(s).length;

export default function Send() {
  const { t } = useI18n();
  const s = t.app.send;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { session } = useSession();
  const { market, network, token, balance, refresh } = useAppData();
  const fmtUsd = useUsd();
  const local = useLocal();
  const [step, setStep] = useState<'to' | 'amount' | 'review' | 'done'>('to');
  const [toText, setToText] = useState(params.get('to') ?? '');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [resolving, setResolving] = useState(false);
  const [toError, setToError] = useState('');
  const [amount, setAmount] = useState(() => {
    const a = params.get('amount');
    return a && parseDecimal(a, 2) ? a : '';
  });
  const [note, setNote] = useState(params.get('note') ?? '');
  const [recent, setRecent] = useState<{ handle: string | null; address: string }[]>([]);
  const [sendError, setSendError] = useState('');
  const sentUnits = useRef('');
  const me = session?.address ?? '';

  // Recent contacts: the latest people this wallet sent to.
  useEffect(() => {
    if (!network) return;
    let alive = true;
    app
      .activity(network.id, { limit: 30 })
      .then((p) => {
        if (!alive) return;
        const seen = new Set<string>();
        const list: { handle: string | null; address: string }[] = [];
        for (const it of p.items) {
          if (it.type !== 'transfer' || it.transfer.direction !== 'out') continue;
          const key = it.transfer.toHandle ?? it.transfer.to;
          if (seen.has(key)) continue;
          seen.add(key);
          list.push({ handle: it.transfer.toHandle, address: it.transfer.to });
        }
        setRecent(list.slice(0, 5));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [network]);

  const resolve = async (input: string) => {
    setToError('');
    const r = normalizeRecipient(input);
    if (!r) return setToError(s.invalidTo);
    let next: Recipient;
    if (r.startsWith('@')) {
      setResolving(true);
      try {
        const found = await app.resolveHandle(r);
        if (!found) return setToError(fmt(s.notFound, { handle: r.slice(1) }));
        next = { input: r, handle: found.handle, address: found.address };
      } catch (e) {
        return setToError(errorMessage(t.common, e));
      } finally {
        setResolving(false);
      }
    } else {
      if (!isDestination(r)) return setToError(s.invalidTo);
      next = { input: r, handle: null, address: r };
    }
    if (next.address === me) return setToError(s.self);
    setRecipient(next);
    setStep(dollarsToUnits(amount) ? 'review' : 'amount');
  };

  // A link or a scan that named the recipient goes straight on.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !params.get('to') || !me) return;
    started.current = true;
    void resolve(params.get('to')!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const units = dollarsToUnits(amount);
  const tooMuch = !!units && BigInt(units) > BigInt(balance || '0');
  const noteOk = noteBytes(note) <= 28;
  const label = recipient ? (recipient.handle ? `@${recipient.handle}` : shortAddress(recipient.address)) : '';

  if (!network || !token || !market) return <Screen back title={s.title}>{null}</Screen>;

  if (step === 'done' && recipient)
    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 pt-10 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-ok-soft text-ok" aria-hidden="true">
            <Icon name="check" size={34} strokeWidth={2.4} />
          </span>
          <h1 className="text-[1.75rem]">{s.sentTitle}</h1>
          <p className="figure text-[2.4rem]">
            <span className="marker marker-sweep">{fmtUsd(sentUnits.current)}</span>
          </p>
          <p className="text-ink-2">{fmt(s.sentBody, { amount: fmtUsd(sentUnits.current), to: label })}</p>
        </div>
        <div className="flex flex-col gap-2 pb-4">
          {typeof navigator.share === 'function' && (
            <button
              type="button"
              className="btn btn-line btn-lg"
              onClick={() =>
                void navigator
                  .share({ text: fmt(s.shareText, { amount: fmtUsd(sentUnits.current), brand: t.common.brand }) })
                  .catch(() => {})
              }
            >
              <Icon name="share" size={20} />
              {s.share}
            </button>
          )}
          <Link to="/app" className="btn btn-ink btn-lg">
            {s.done}
          </Link>
        </div>
      </Screen>
    );

  if (step === 'review' && recipient && units)
    return (
      <Screen back={undefined} title={s.review} action={
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStep('amount')}>
          {t.common.actions.edit}
        </button>
      }>
        <div className="flex flex-col gap-4 pt-2">
          <div className="text-center">
            <p className="text-ink-3">{s.youSend}</p>
            <p className="figure mt-1 text-[2.6rem]">
              <span className="marker">{fmtUsd(units)}</span>
            </p>
            {local(units) && <p className="num mt-1 text-ink-3">{local(units)}</p>}
          </div>
          <Facts
            rows={[
              [s.recipient, recipient.handle ? `@${recipient.handle}` : shortAddress(recipient.address)],
              [s.address, <span key="a" className="text-[0.8125rem] font-medium break-all">{recipient.address}</span>],
              ...(note.trim() ? ([[s.note, note.trim()]] as [string, string][]) : []),
              [s.fee, market.sponsor.enabled ? s.free : '-'],
            ]}
          />
          <SignFlow
            network={network}
            signer={me}
            via={appSubmitter}
            sponsored={market.sponsor.enabled}
            startLabel={fmt(s.confirm, { amount: fmtUsd(units) })}
            steps={[
              {
                label: fmt(s.stepLabel, { amount: fmtUsd(units), to: label }),
                build: async () => {
                  setSendError('');
                  const r = await app.transfer({
                    network: network.id,
                    to: recipient.input,
                    token: token.symbol,
                    amount: units,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                  return r.transaction;
                },
                expect: {
                  action: 'payment',
                  to: recipient.address,
                  token: token.symbol,
                  amountUnits: units,
                  // A contract receives through the token contract, which carries no memo.
                  memo: note.trim() && !recipient.address.startsWith('C') ? note.trim() : null,
                },
              },
            ]}
            onError={(e) =>
              setSendError(
                e instanceof ApiError && e.code === 'recipient_cannot_receive'
                  ? s.cannotReceive
                  : e instanceof ApiError && e.code === 'insufficient_balance'
                    ? s.tooMuch
                    : '',
              )
            }
            onDone={() => {
              sentUnits.current = units;
              setStep('done');
              refresh();
            }}
          />
          {sendError && <Notice tone="error">{sendError}</Notice>}
          <button type="button" className="btn btn-quiet" onClick={() => setStep('to')}>
            {t.common.actions.back}
          </button>
        </div>
      </Screen>
    );

  if (step === 'amount' && recipient)
    return (
      <Screen back={undefined} title={s.amount} action={
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStep('to')}>
          {t.common.actions.back}
        </button>
      }>
        <form
          className="flex flex-1 flex-col gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (units && !tooMuch && noteOk) setStep('review');
          }}
        >
          <p className="flex items-center gap-2 text-ink-2">
            <span className="text-ink-3">{s.to}</span>
            <b className="truncate">{label}</b>
          </p>
          <div className="rounded-[20px] bg-well px-4 py-6">
            <label htmlFor="send-amount" className="sr-only">
              {s.amountLabel}
            </label>
            <input
              id="send-amount"
              className="amount-input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim().replace(',', '.'))}
              aria-invalid={(amount && !units) || tooMuch ? true : undefined}
              aria-describedby="send-amount-msg"
            />
            <p className="mt-1 text-center font-semibold text-ink-3">USDC</p>
            <p id="send-amount-msg" className={`num mt-2 text-center text-[0.875rem] ${tooMuch || (amount && !units) ? 'text-bad' : 'text-ink-3'}`}>
              {tooMuch
                ? s.tooMuch
                : amount && !units
                  ? s.badAmount
                  : (units && local(units)) || fmt(s.available, { amount: fmtUsd(balance) })}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-line btn-sm self-center"
            onClick={() => {
              const whole = unitsToDecimal((BigInt(balance || '0') / 100000n * 100000n).toString());
              setAmount(whole);
            }}
          >
            {s.max}
          </button>
          <Field
            label={s.note}
            placeholder={s.notePlaceholder}
            value={note}
            maxLength={28}
            onChange={(e) => setNote(e.target.value)}
            error={noteOk ? null : s.noteTooLong}
          />
          <button
            type="submit"
            className="btn btn-ink btn-lg mt-auto mb-4 w-full"
            disabled={!units || tooMuch || !noteOk}
          >
            {s.next}
          </button>
        </form>
      </Screen>
    );

  return (
    <Screen back title={s.title}>
      <form
        className="flex flex-1 flex-col gap-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void resolve(toText);
        }}
      >
        <Field
          label={s.toLabel}
          placeholder={s.toPlaceholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={toText}
          onChange={(e) => setToText(e.target.value)}
          error={toError || null}
          autoFocus={!params.get('to')}
        />
        <div className="flex gap-2">
          <button type="submit" className="btn btn-ink btn-lg flex-1" disabled={!toText.trim() || resolving}>
            {resolving && <Spinner />}
            {resolving ? s.resolving : s.next}
          </button>
          <button
            type="button"
            className="btn btn-line btn-lg"
            onClick={() => navigate('/app/scan')}
            aria-label={s.scanInstead}
          >
            <Icon name="scan" size={22} />
          </button>
        </div>
        {recent.length > 0 && (
          <section aria-labelledby="recent-to">
            <h2 id="recent-to" className="text-[0.9375rem] font-semibold text-ink-3" style={{ fontStretch: '100%' }}>
              {s.recent}
            </h2>
            <ul className="mt-1 flex flex-col" role="list">
              {recent.map((c) => (
                <li key={c.handle ?? c.address}>
                  <button
                    type="button"
                    className="flex min-h-[56px] w-full items-center gap-3 rounded-[14px] px-1 text-left hover:bg-well"
                    onClick={() => {
                      const v = c.handle ? `@${c.handle}` : c.address;
                      setToText(v);
                      void resolve(v);
                    }}
                  >
                    <span className="grid size-10 place-items-center rounded-full bg-well font-bold uppercase" aria-hidden="true">
                      {(c.handle ?? c.address).slice(0, 1)}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <b className="truncate">{c.handle ? `@${c.handle}` : shortAddress(c.address)}</b>
                      <span className="truncate text-[0.8125rem] text-ink-3">{shortAddress(c.address)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </form>
    </Screen>
  );
}
