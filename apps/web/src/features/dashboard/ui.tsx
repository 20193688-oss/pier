/* Pieces every dashboard view shares: the page head, a loader hook that ends the session on a
   401, the loading / error / empty states, figures, and a dialog that signs transactions from one
   of the organization's wallets. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { Notice, Skeleton } from '@/components/ui/controls';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Address } from '@/components/ui/misc';
import { addressKind, explorerLink } from '@/lib/stellar/network';
import { SignFlow, type TxStep } from '@/components/wallet/SignFlow';
import { errorMessage, isUnauthorized } from '@/lib/api/messages';
import { useSession } from '@/lib/session';
import { useDash } from '@/features/dashboard/context';
import { orgSubmitter } from '@/features/dashboard/tx';
import type { P2pNetwork } from '@/lib/p2p/types';

export function PageHead({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-[44rem]">
        <h1 className="text-[1.75rem] sm:text-[2rem]">{title}</h1>
        {lede && <p className="mt-2 text-ink-2">{lede}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  reload: () => void;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}

/** Load `fn` now and whenever `deps` change; a 401 ends the session (the dashboard asks to sign
    in again), any other failure is a message the view shows with a retry. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const { t } = useI18n();
  const { expire } = useSession();
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setError(null);
    fnRef
      .current()
      .then((d) => alive && setDataState(d))
      .catch((e) => {
        if (!alive) return;
        if (isUnauthorized(e)) expire();
        else setError(errorMessage(t.common, e, t.dash.state.error));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  const setData = useCallback((f: (d: T | undefined) => T | undefined) => setDataState(f), []);
  return { data, error, reload, setData };
}

/** Skeleton while loading, the error with a retry, the empty state, else the content. */
export function LoadState<T>({
  load,
  empty,
  children,
  isEmpty = (d) => Array.isArray(d) && d.length === 0,
}: {
  load: Loaded<T>;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
  isEmpty?: (d: T) => boolean;
}) {
  const { t } = useI18n();
  if (load.error && load.data === undefined)
    return (
      <div className="flex flex-col items-start gap-3">
        <Notice tone="error" stay>{load.error}</Notice>
        <button type="button" className="btn btn-line btn-sm" onClick={load.reload}>
          {t.common.actions.retry}
        </button>
      </div>
    );
  if (load.data === undefined)
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t.dash.state.loading}>
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  if (empty && isEmpty(load.data)) return <>{empty}</>;
  return <>{children(load.data)}</>;
}

export function Figures({
  items,
  label,
}: {
  items: { label: string; value: ReactNode; sub?: ReactNode }[];
  label: string;
}) {
  return (
    <dl aria-label={label} className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((f) => (
        <div key={f.label} className="rounded-[18px] border border-line bg-sheet p-4">
          <dt className="text-[0.8125rem] font-semibold text-ink-3">{f.label}</dt>
          <dd className="figure mt-2 text-[clamp(1.05rem,4.4vw,1.45rem)] [overflow-wrap:anywhere]">
            {f.value}
          </dd>
          {f.sub && <dd className="mt-1 text-[0.8125rem] text-ink-3">{f.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function ReadOnly() {
  const { t } = useI18n();
  return <Notice className="mb-6">{t.dash.state.readOnly}</Notice>;
}

/** A dialog that signs one or more transactions from `signer` (one of the organization's
    registered wallets) after the check in SignFlow, and submits them through the organization's
    submit route (the API pays the network fee when the market sponsors it). */
export function SignDialog({
  title,
  intro,
  network,
  signer,
  steps,
  onDone,
  onClose,
  children,
  blocked,
}: {
  title: string;
  intro?: ReactNode;
  network: P2pNetwork;
  signer: string;
  steps: TxStep[];
  onDone: () => void;
  onClose: () => void;
  /* What goes with the signature, above it (a mark-paid's receipt). */
  children?: ReactNode;
  /* What is still missing before it can be signed; the signing waits while set. */
  blocked?: string;
}) {
  const { scope, market } = useDash();
  return (
    <Dialog title={title} onClose={onClose}>
      {intro && <div className="mb-4 text-ink-2">{intro}</div>}
      {children && <div className="mb-4">{children}</div>}
      {blocked ? (
        <Notice tone="info">{blocked}</Notice>
      ) : (
        <SignFlow
          allowConnect
          network={network}
          signer={signer}
          steps={steps}
          via={orgSubmitter(scope)}
          sponsored={market?.sponsor.enabled ?? false}
          onDone={onDone}
        />
      )}
    </Dialog>
  );
}

/** A labelled row of a definition list. */
export function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-ink-3">{k}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** A Stellar address, shortened, with a link to its page on the network's explorer when the
    market names one. */
export function AddressLink({
  value,
  network,
}: {
  value: string;
  network?: Pick<P2pNetwork, 'explorerUrl'> | null;
}) {
  const { t } = useI18n();
  const href = explorerLink(network, addressKind(value), value);
  return (
    <span className="inline-flex items-center gap-1">
      <Address value={value} />
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t.dash.liq.explorer}
          title={t.dash.liq.explorer}
          className="text-ink-3 hover:text-ink"
        >
          <Icon name="external" size={14} />
        </a>
      )}
    </span>
  );
}
