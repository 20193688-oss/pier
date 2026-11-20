/* Add money (a purchase: BUY) and withdraw (a sale: SELL): the market's buy/sell flow in the app's
   frame, as steps (amount and price, then who pays or the account the money goes to). The order
   then opens on its own screen. */
import { useNavigate } from 'react-router';
import { useI18n } from '@/i18n';
import { Notice, Skeleton } from '@/components/ui/controls';
import { TradeForm } from '@/features/trade/TradeForm';
import { saveQuoteTerms, saveSteps } from '@/lib/p2p/steps';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import type { P2pSide } from '@/lib/p2p/types';

export default function Trade({ side }: { side: P2pSide }) {
  const { t } = useI18n();
  const words = side === 'BUY' ? t.app.add : t.app.withdraw;
  const navigate = useNavigate();
  const { market } = useAppData();
  return (
    <Screen back title={words.title}>
      <p className="mb-4 text-ink-2">{words.lede}</p>
      {market === undefined ? (
        <Skeleton className="h-64" />
      ) : market === null ? (
        <Notice tone="warn">{t.trade.unavailable}</Notice>
      ) : (
        <TradeForm
          key={side}
          market={market}
          initialSide={side}
          fixedSide={side}
          onConnect={() => navigate('/app')}
          onOpened={(o, accepted) => {
            saveSteps(o.id, o.transactions);
            if (o.kind === 'SELL') saveQuoteTerms(o.id, accepted);
            navigate(`/app/order/${o.id}`, { replace: true });
          }}
        />
      )}
    </Screen>
  );
}
