/* Liquidity: the organization's registered wallets and what the market contract holds for them.
   Register a wallet with an EIP-191 signature over the API's single-use challenge; deposit
   (approve + deposit) and withdraw; authorise pedospe's matcher with a per-order cap; give a bot
   permission bits or revoke it; pause or resume a merchant. Every on-chain step is built by the
   API for that wallet and checked against what was typed before the wallet signs (SignFlow). */
import { useMemo, useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import { accounts as accountsApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { ApiError } from '@/lib/api/client';
import { fromBaseUnits, gteUnits, parseDecimal, toBaseUnits } from '@/lib/p2p/amounts';
import { maskToPerms, OPERATOR_PERM_KEYS, permsToMask, type OperatorPerm } from '@/lib/p2p/perms';
import { units, shortAddress } from '@/lib/format';
import { useSession } from '@/lib/session';
import { signText, WalletError } from '@/lib/wallet/actions';
import { Check, Field, Notice, SelectField, Spinner, Switch } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Address, Empty, Pill } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { TokenMark } from '@/components/p2p/parts';
import { WalletList } from '@/components/wallet/ConnectDialog';
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
import type { DiscoveredWallet } from '@/lib/wallet/eip6963';
import type { P2pAccount, P2pAccountChain, P2pMarket, P2pNetwork } from '@/lib/p2p/types';

type Action =
  | {
      kind: 'deposit' | 'withdraw' | 'matcher' | 'bot';
      account: P2pAccount;
      network?: string;
      bot?: string;
    }
  | { kind: 'revokeBot'; account: P2pAccount; network: string; bot: string };

export function LiquidityView() {
  const { t, lang } = useI18n();
  const l = t.p2p.liquidity;
  const d = t.dash.liq;
  const toast = useToast();
  const { scope, market, canWrite } = useDash();
  const load = useLoad(async () => {
    const list = await accountsApi.list(scope);
    // The list answers each wallet; its on-chain state (balances, matcher, bots) is in its detail.
    return Promise.all(list.map((a) => accountsApi.get(scope, a.id).catch(() => a)));
  }, [scope.org, scope.tier]);
  const [registering, setRegistering] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [removing, setRemoving] = useState<P2pAccount | null>(null);
  const [error, setError] = useState('');

  const totals = useMemo(() => {
    let free = 0n;
    let locked = 0n;
    let authorised = 0;
    for (const a of load.data ?? [])
      for (const c of a.chains ?? []) {
        if (c.matcher) authorised += 1;
        for (const b of c.balances) {
          if (b.decimals !== 6) continue;
          free += BigInt(b.freeUnits || '0');
          locked += BigInt(b.lockedUnits || '0');
        }
      }
    return {
      free: fromBaseUnits(free.toString(), 6),
      locked: fromBaseUnits(locked.toString(), 6),
      authorised,
    };
  }, [load.data]);

  const merchants = (load.data ?? []).filter((a) => a.merchant).length;

  const setStatus = async (a: P2pAccount, active: boolean) => {
    setError('');
    try {
      await accountsApi.update(scope, a.id, { merchantStatus: active ? 'ACTIVE' : 'PAUSED' });
      toast(active ? d.resumed : d.paused);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e, l.saveFailed));
    }
  };

  const remove = async (a: P2pAccount) => {
    setError('');
    try {
      await accountsApi.remove(scope, a.id);
      toast(l.removed);
      setRemoving(null);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e, l.removeFailed));
    }
  };

  return (
    <>
      <PageHead
        title={l.title}
        lede={d.lede}
        actions={
          canWrite && (
            <button type="button" className="btn btn-ink" onClick={() => setRegistering(true)}>
              <Icon name="plus" size={18} />
              {l.register}
            </button>
          )
        }
      />
      {!canWrite && <ReadOnly />}
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      {load.data && (
        <Figures
          label={l.figuresLabel}
          items={[
            {
              label: l.figures.wallets,
              value: load.data.length,
              sub:
                merchants === 1
                  ? l.figures.merchantsOne
                  : fmt(l.figures.merchants, { n: merchants }),
            },
            {
              label: l.figures.free,
              value: units(lang, totals.free, 'USD'),
              sub: l.figures.stable,
            },
            {
              label: l.figures.locked,
              value: units(lang, totals.locked, 'USD'),
              sub: l.figures.inOrders,
            },
            { label: l.figures.matcher, value: totals.authorised, sub: l.figures.matcherSub },
          ]}
        />
      )}
      <LoadState load={load} empty={<Empty title={d.empty} body={d.emptyBody} />}>
        {(list) => (
          <ul className="flex flex-col gap-4" role="list">
            {list.map((a) => (
              <li key={a.id} className="sheet p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[1.1rem] font-semibold">
                      {a.label || a.merchant?.displayName || shortAddress(a.address)}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.875rem] text-ink-3">
                      <Address value={a.address} />
                      {a.merchant ? (
                        <>
                          <span>{a.merchant.displayName}</span>
                          <Pill
                            tone={
                              a.merchant.status === 'ACTIVE'
                                ? 'ok'
                                : a.merchant.status === 'SUSPENDED'
                                  ? 'fail'
                                  : 'off'
                            }
                          >
                            {
                              l.state[
                                a.merchant.status === 'ACTIVE'
                                  ? 'active'
                                  : a.merchant.status === 'SUSPENDED'
                                    ? 'suspended'
                                    : 'paused'
                              ]
                            }
                          </Pill>
                        </>
                      ) : (
                        <Pill tone="off">{l.state.plain}</Pill>
                      )}
                    </p>
                  </div>
                  {canWrite && (
                    <div className="flex flex-wrap items-center gap-2">
                      {a.merchant && a.merchant.status !== 'SUSPENDED' && (
                        <label className="flex items-center gap-2 text-[0.875rem] font-semibold text-ink-2">
                          {l.merchantStatus}
                          <Switch
                            checked={a.merchant.status === 'ACTIVE'}
                            onChange={(on) => void setStatus(a, on)}
                            label={a.merchant.status === 'ACTIVE' ? d.pause : d.resume}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className="btn btn-ink btn-sm"
                        onClick={() => setAction({ kind: 'deposit', account: a })}
                      >
                        {l.deposit}
                      </button>
                      <button
                        type="button"
                        className="btn btn-line btn-sm"
                        onClick={() => setAction({ kind: 'withdraw', account: a })}
                      >
                        {l.withdraw}
                      </button>
                      <button
                        type="button"
                        className="btn btn-line btn-sm"
                        onClick={() => setAction({ kind: 'matcher', account: a })}
                      >
                        {l.authorise}
                      </button>
                      <button
                        type="button"
                        className="btn btn-line btn-sm"
                        onClick={() => setAction({ kind: 'bot', account: a })}
                      >
                        {l.bots.add}
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => setRemoving(a)}
                      >
                        {l.remove}
                      </button>
                    </div>
                  )}
                </div>
                {a.merchant?.status === 'SUSPENDED' && (
                  <Notice tone="error" className="mt-3">
                    {l.suspended}
                  </Notice>
                )}
                <Chains
                  account={a}
                  market={market}
                  canWrite={canWrite}
                  onRevoke={(network, bot) =>
                    setAction({ kind: 'revokeBot', account: a, network, bot })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </LoadState>

      {registering && (
        <RegisterDialog
          onClose={() => setRegistering(false)}
          onDone={() => {
            setRegistering(false);
            toast(d.registered);
            load.reload();
          }}
        />
      )}
      {action && market && (
        <ActionDialog
          action={action}
          market={market}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            toast(d.sent);
            load.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={l.removeTitle}
          body={fmt(l.removeBody, { name: removing.label || shortAddress(removing.address) })}
          confirmLabel={l.remove}
          danger
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function Chains({
  account,
  market,
  canWrite,
  onRevoke,
}: {
  account: P2pAccount;
  market: P2pMarket | null | undefined;
  canWrite: boolean;
  onRevoke: (network: string, bot: string) => void;
}) {
  const { t, lang } = useI18n();
  const l = t.p2p.liquidity;
  const chains = (account.chains ?? []).filter(
    (c) => c.balances.length || c.matcher || c.operators.length,
  );
  if (!chains.length)
    return <p className="mt-3 text-[0.9375rem] text-ink-3">{t.dash.liq.noBalance}</p>;
  const nameOf = (id: string) => market?.networks.find((n) => n.id === id)?.name ?? id;
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {chains.map((c: P2pAccountChain) => (
        <section
          key={c.network}
          className="rounded-[16px] bg-well p-4"
          aria-label={nameOf(c.network)}
        >
          <h3 className="text-[1rem]">{nameOf(c.network)}</h3>
          <dl className="mt-2 flex flex-col gap-1.5 text-[0.9375rem]">
            {c.balances.map((b) => (
              <div key={b.token} className="flex flex-wrap items-center justify-between gap-2">
                <dt className="flex items-center gap-2">
                  <TokenMark symbol={b.symbol} size={20} />
                  {b.symbol}
                </dt>
                <dd className="num text-right">
                  <b>{units(lang, fromBaseUnits(b.freeUnits, b.decimals), b.symbol)}</b>
                  {b.lockedUnits !== '0' && (
                    <span className="block text-[0.8125rem] text-ink-3">
                      {fmt(l.lockedValue, {
                        amount: units(lang, fromBaseUnits(b.lockedUnits, b.decimals), b.symbol),
                      })}
                    </span>
                  )}
                </dd>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-2">
              <dt className="text-ink-3">{l.balances.cap}</dt>
              <dd className="num">
                {c.matcher
                  ? fmt(l.balances.capValue, {
                      amount: units(lang, fromBaseUnits(c.matcher.maxPerOrderUnits, 6), 'USDC'),
                    })
                  : l.balances.noMatcher}
              </dd>
            </div>
          </dl>
          {c.operators.length > 0 && (
            <div className="mt-3 border-t border-line pt-2">
              <p className="text-[0.875rem] font-semibold text-ink-2">{l.bots.title}</p>
              <ul className="mt-1 flex flex-col gap-1.5" role="list">
                {c.operators.map((o) => (
                  <li
                    key={o.address}
                    className="flex flex-wrap items-center justify-between gap-2 text-[0.875rem]"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Address value={o.address} />
                      <span className="text-ink-3">
                        {maskToPerms(o.perms)
                          .map((p) => l.perms[p].title)
                          .join(', ')}
                      </span>
                    </span>
                    {canWrite && (
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => onRevoke(c.network, o.address)}
                      >
                        {l.bots.revoke}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Deposit, withdraw, authorise the matcher, add or revoke a bot: pick the network (and token),
    type the amount or address, then sign. */
function ActionDialog({
  action,
  market,
  onClose,
  onDone,
}: {
  action: Action;
  market: P2pMarket;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const l = t.p2p.liquidity;
  const f = l.form;
  const d = t.dash.liq;
  const { scope } = useDash();
  const a = action.account;
  const [networkId, setNetworkId] = useState(action.network ?? market.networks[0]?.id ?? '');
  const network: P2pNetwork | undefined = market.networks.find((n) => n.id === networkId);
  const [symbol, setSymbol] = useState(network?.tokens[0]?.symbol ?? 'USDC');
  const token = network?.tokens.find((x) => x.symbol === symbol) ?? network?.tokens[0];
  const chain = a.chains?.find((c) => c.network === networkId);
  const freeUnits = chain?.balances.find((b) => b.symbol === token?.symbol)?.freeUnits ?? '0';
  const [amount, setAmount] = useState(
    action.kind === 'matcher' && chain?.matcher
      ? fromBaseUnits(chain.matcher.maxPerOrderUnits, 6)
      : '',
  );
  const [autoSettle, setAutoSettle] = useState(chain?.matcher?.autoSettle ?? false);
  const [bot, setBot] = useState(action.bot ?? '');
  const [perms, setPerms] = useState<OperatorPerm[]>(['release', 'trade']);
  const [touched, setTouched] = useState(false);
  const [ready, setReady] = useState(action.kind === 'revokeBot');

  const decimals = token?.decimals ?? 6;
  const parsed = parseDecimal(amount, Math.min(decimals, 6));
  const units6 = parsed !== null ? toBaseUnits(parsed, decimals) : null;
  const amountError = (() => {
    if (action.kind === 'bot' || action.kind === 'revokeBot') return null;
    if (!amount.trim()) return action.kind === 'matcher' ? f.enterCap : f.enterAmount;
    if (units6 === null) return fmt(f.badAmount, { n: Math.min(decimals, 6) });
    if (action.kind !== 'matcher' && units6 === '0') return f.enterAmount;
    if (action.kind === 'withdraw' && !gteUnits(freeUnits, units6)) return f.overFree;
    return null;
  })();
  const botError = (() => {
    if (action.kind !== 'bot') return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(bot.trim())) return f.badBot;
    if (bot.trim().toLowerCase() === a.address.toLowerCase()) return f.selfBot;
    if (!perms.length) return f.pickPerms;
    return null;
  })();
  const noMatcher = action.kind === 'matcher' && !market.matcher;
  const valid = !amountError && !botError && !!network && !!token && !noMatcher;

  const title = {
    deposit: l.deposit,
    withdraw: l.withdraw,
    matcher: l.authorise,
    bot: l.bots.add,
    revokeBot: l.bots.revokeTitle,
  }[action.kind];

  if (ready && valid && network && token) {
    const amt = parsed ?? '0';
    const base = { network: network.id, accountId: a.id };
    const steps =
      action.kind === 'deposit'
        ? [
            accountStep(
              scope,
              { ...base, action: 'approve', args: { token: token.symbol, amount: units6 } },
              fmt(d.approveStep, { amount: amt, token: token.symbol }),
              {
                action: 'approve',
                token: token.symbol,
                spender: network.contract,
                amountUnits: units6!,
              },
            ),
            accountStep(
              scope,
              { ...base, action: 'deposit', args: { token: token.symbol, amount: units6 } },
              fmt(d.depositStep, { amount: amt, token: token.symbol }),
              {
                action: 'deposit',
                token: token.symbol,
                amountUnits: units6!,
              },
            ),
          ]
        : action.kind === 'withdraw'
          ? [
              accountStep(
                scope,
                { ...base, action: 'withdraw', args: { token: token.symbol, amount: units6 } },
                fmt(d.withdrawStep, { amount: amt, token: token.symbol }),
                {
                  action: 'withdraw',
                  token: token.symbol,
                  amountUnits: units6!,
                },
              ),
            ]
          : action.kind === 'matcher'
            ? [
                accountStep(
                  scope,
                  { ...base, action: 'setMatcher', args: { maxPerOrder: units6, autoSettle } },
                  fmt(d.matcherStep, { amount: amt, token: token.symbol }),
                  {
                    action: 'setMatcher',
                    matcher: market.matcher,
                    maxPerOrderUnits: units6!,
                    autoSettle,
                  },
                ),
              ]
            : [
                accountStep(
                  scope,
                  {
                    ...base,
                    action: 'setOperator',
                    args: {
                      operator: bot.trim(),
                      permissions: action.kind === 'revokeBot' ? 0 : permsToMask(perms),
                    },
                  },
                  fmt(action.kind === 'revokeBot' ? d.revokeStep : d.botStep, {
                    address: shortAddress(bot.trim()),
                  }),
                  {
                    action: 'setOperator',
                    operator: bot.trim(),
                    perms: action.kind === 'revokeBot' ? 0 : permsToMask(perms),
                  },
                ),
              ];
    const intro =
      action.kind === 'deposit' ? (
        <>
          <b className="block text-ink">{f.depositTitle}</b>
          {f.depositBody}
        </>
      ) : action.kind === 'matcher' ? (
        <>
          <b className="block text-ink">{f.matcherTitle}</b>
          {f.matcherBody}
        </>
      ) : action.kind === 'bot' && perms.includes('withdraw') ? (
        <>
          <b className="block text-ink">{f.withdrawTitle}</b>
          {f.withdrawBody}
        </>
      ) : undefined;
    return (
      <SignDialog
        title={title}
        intro={intro}
        network={network}
        signer={a.address}
        steps={steps}
        onDone={onDone}
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-line" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button
            type="button"
            className="btn btn-ink"
            onClick={() => {
              setTouched(true);
              if (valid) setReady(true);
            }}
          >
            {f.continue}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SelectField
          label={d.network}
          value={networkId}
          onChange={(e) => {
            setNetworkId(e.target.value);
            setSymbol(
              market.networks.find((n) => n.id === e.target.value)?.tokens[0]?.symbol ?? 'USDC',
            );
          }}
          options={market.networks.map((n) => ({ value: n.id, label: n.name }))}
        />
        {(action.kind === 'deposit' || action.kind === 'withdraw') &&
          network &&
          network.tokens.length > 1 && (
            <SelectField
              label={d.token}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              options={network.tokens.map((x) => ({ value: x.symbol, label: x.symbol }))}
            />
          )}
        {action.kind !== 'bot' && (
          <Field
            label={action.kind === 'matcher' ? f.cap : f.amount}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim().replace(',', '.'))}
            onBlur={() => setTouched(true)}
            error={touched ? amountError : null}
            hint={
              action.kind === 'withdraw'
                ? fmt(f.freeNow, {
                    amount: units(lang, fromBaseUnits(freeUnits, decimals), token?.symbol ?? ''),
                  })
                : action.kind === 'matcher'
                  ? f.capHint
                  : undefined
            }
          />
        )}
        {action.kind === 'matcher' && !a.merchant && (
          <>
            <Check
              checked={autoSettle}
              onChange={setAutoSettle}
              title={f.autoSettle}
              desc={f.autoSettleHint}
            />
            {autoSettle && (
              <Notice tone="warn">
                <b className="block">{f.autoSettleRiskTitle}</b>
                {f.autoSettleRisk}
              </Notice>
            )}
          </>
        )}
        {action.kind === 'bot' && (
          <>
            <Field
              label={l.bots.address}
              value={bot}
              spellCheck={false}
              autoComplete="off"
              placeholder="0x…"
              onChange={(e) => setBot(e.target.value)}
              onBlur={() => setTouched(true)}
              error={touched ? botError : null}
              hint={f.botHint}
            />
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-[0.875rem] font-semibold text-ink-2">
                {l.bots.perms}
              </legend>
              {OPERATOR_PERM_KEYS.map((p) => (
                <Check
                  key={p}
                  checked={perms.includes(p)}
                  onChange={(on) => setPerms((x) => (on ? [...x, p] : x.filter((y) => y !== p)))}
                  title={l.perms[p].title}
                  desc={l.perms[p].desc}
                />
              ))}
            </fieldset>
          </>
        )}
        {noMatcher && <Notice tone="warn">{d.noMatcher}</Notice>}
      </div>
    </Dialog>
  );
}

/** Register a wallet: a name and, for a merchant, the name people see; then the wallet's account
    signs the API's challenge (EIP-191), which proves the organization holds it. */
function RegisterDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const r = t.p2p.liquidity.registerForm;
  const d = t.dash.liq;
  const { scope } = useDash();
  const { wallet: sessionWallet, wallets } = useSession();
  const [label, setLabel] = useState('');
  const [merchant, setMerchant] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [wallet, setWallet] = useState<DiscoveredWallet | null>(sessionWallet);
  const [addresses, setAddresses] = useState<string[] | null>(null);
  const [address, setAddress] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const nameMissing = merchant && displayName.trim().length < 2;

  const connect = async (w: DiscoveredWallet) => {
    setWallet(w);
    setError('');
    try {
      const list =
        ((await w.provider.request({ method: 'eth_requestAccounts' })) as string[]) ?? [];
      setAddresses(list);
      setAddress(list[0] ?? '');
    } catch {
      setError(t.common.wallet.rejected);
    }
  };

  const register = async () => {
    if (!wallet || !address || nameMissing) return;
    setError('');
    try {
      setProgress(r.challenge);
      const ch = await accountsApi.challenge(scope, address);
      setProgress(
        fmt(t.common.wallet.signing, { wallet: wallet.info.name || t.common.wallet.unnamed }),
      );
      const signature = await signText(wallet.provider, address as `0x${string}`, ch.message);
      setProgress(r.checking);
      await accountsApi.register(scope, {
        address,
        signature,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(merchant ? { displayName: displayName.trim() } : {}),
      });
      onDone();
    } catch (e) {
      setProgress('');
      if (e instanceof WalletError)
        setError(e.kind === 'rejected' ? t.common.wallet.rejected : t.common.wallet.failed);
      else if (e instanceof ApiError && e.status === 409) setError(d.alreadyRegistered);
      else setError(errorMessage(t.common, e));
    }
  };

  return (
    <Dialog title={r.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field
          label={r.label}
          value={label}
          placeholder={r.labelPlaceholder}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Check checked={merchant} onChange={setMerchant} title={r.merchant} desc={r.merchantHint} />
        {merchant && (
          <Field
            label={r.displayName}
            value={displayName}
            maxLength={40}
            hint={r.displayNameHint}
            onChange={(e) => setDisplayName(e.target.value)}
            error={displayName && nameMissing ? t.dash.orgs.nameError : null}
          />
        )}
        <div className="border-t border-line pt-4">
          <h3 className="text-[1.05rem]">{r.signTitle}</h3>
          <p className="mt-1 mb-3 text-[0.9375rem] text-ink-2">{r.signBody}</p>
          {!addresses ? (
            wallets.length ? (
              <WalletList
                wallets={wallet ? [wallet, ...wallets.filter((w) => w !== wallet)] : wallets}
                onPick={(w) => void connect(w)}
              />
            ) : (
              <Notice tone="warn">{t.common.wallet.none}</Notice>
            )
          ) : (
            <div className="flex flex-col gap-3">
              <SelectField
                label={d.pickAccount}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                options={addresses.map((x) => ({ value: x, label: x }))}
              />
              <button
                type="button"
                className="btn btn-ink btn-lg"
                disabled={!!progress || !address || nameMissing}
                onClick={() => void register()}
              >
                {progress ? <Spinner /> : <Icon name="wallet" />}
                {progress || d.sign}
              </button>
            </div>
          )}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
