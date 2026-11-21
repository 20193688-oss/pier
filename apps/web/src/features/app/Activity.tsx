/* Activity: every movement of the wallet, newest first and by day (transfers in and out,
   purchases, sales, QR payments), a page at a time. */
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Skeleton, Spinner } from '@/components/ui/controls';
import { app } from '@/lib/api/app';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { ActivityList } from '@/features/app/parts';
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
    <Screen title={a.title} width="page">
      {items === undefined && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}
      {items === null && <Notice tone="error" stay>{a.loadError}</Notice>}
      {items && items.length === 0 && (
        <div className="sheet flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="icon-tile" aria-hidden="true">
            <Icon name="list" size={20} />
          </span>
          <p className="max-w-sm text-ink-3">{a.empty}</p>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="sheet px-5 pb-2 md:px-6 md:pb-4">
          <ActivityList items={items} level={2} />
        </div>
      )}
      {cursor && (
        <button
          type="button"
          className="btn btn-line mt-4 mb-4"
          disabled={busy}
          onClick={() => void load(cursor)}
        >
          {busy && <Spinner />}
          {a.more}
        </button>
      )}
    </Screen>
  );
}
