/* Activity: every movement of the wallet, newest first (transfers in and out, purchases, sales,
   QR payments), a page at a time. */
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { Notice, Skeleton, Spinner } from '@/components/ui/controls';
import { app } from '@/lib/api/app';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { ActivityRow } from '@/features/app/parts';
import type { ActivityItem } from '@/lib/app/types';

export default function Activity() {
  const { t } = useI18n();
  const a = t.app.activity;
  const { market, network } = useAppData();
  const [items, setItems] = useState<ActivityItem[] | null | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (from: string | null) => {
      if (!network) return;
      setBusy(true);
      try {
        const p = await app.activity(network.id, { cursor: from, limit: 20 }, decimalsFrom(market));
        setItems((prev) => (from && prev ? [...prev, ...p.items] : p.items));
        setCursor(p.nextCursor);
      } catch {
        if (!from) setItems(null);
      } finally {
        setBusy(false);
      }
    },
    [network, market],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Screen title={a.title}>
      {items === undefined && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}
      {items === null && <Notice tone="error">{a.loadError}</Notice>}
      {items && items.length === 0 && <p className="text-ink-3">{a.empty}</p>}
      {items && items.length > 0 && (
        <ul className="flex flex-col" role="list" aria-label={a.title}>
          {items.map((it) => (
            <li key={`${it.type}-${it.type === 'order' ? it.order.id : it.transfer.id}`}>
              <ActivityRow item={it} />
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button type="button" className="btn btn-line mt-3 mb-4" disabled={busy} onClick={() => void load(cursor)}>
          {busy && <Spinner />}
          {a.more}
        </button>
      )}
    </Screen>
  );
}
