/* Add money (a purchase: BUY), withdraw (a sale: SELL) and send to someone's bank account abroad
   (a sale whose beneficiary is someone else: `toOther`): the market's buy/sell flow in the app's
   frame, as steps (amount and price, then who pays or the account the money goes to). It starts
   in the person's currency, or in `?currency=` with `?amount=` filled in (what a QR payment lacks);
   the payer and the person's own payout account come back as last sent. Sending to an account can
   start from what was typed on the Send screen (`?rail=` and the account's fields). The order then
   opens on its own screen, where the merchant's transfer receipt arrives in the chat. */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useI18n } from '@/i18n';
import { Notice, Skeleton } from '@/components/ui/controls';
import { TradeForm } from '@/features/trade/TradeForm';
import { saveQuoteTerms, saveSteps } from '@/lib/p2p/steps';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { WalletSummary } from '@/features/app/parts';
import type { P2pSide } from '@/lib/p2p/types';

const NOT_DETAILS = new Set(['currency', 'amount', 'rail']);

export default function Trade({ side, toOther = false }: { side: P2pSide; toOther?: boolean }) {
  const { t } = useI18n();
  const words = toOther ? t.app.sendBank : side === 'BUY' ? t.app.add : t.app.withdraw;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { market, token, currency } = useAppData();
  const amount = params.get('amount');
  const [step, setStep] = useState<'form' | 'details'>('form');
  const details = toOther
    ? Object.fromEntries([...params.entries()].filter(([k]) => !NOT_DETAILS.has(k)))
    : undefined;
  return (
    <Screen
      back
      title={words.title}
      aside={<WalletSummary />}
      steps={{ labels: t.app.tradeSteps, current: step === 'form' ? 0 : 1 }}
    >
      <p className="mb-4 text-ink-2">{words.lede}</p>
      {market === undefined ? (
        <Skeleton className="h-64" />
      ) : market === null ? (
        <Notice tone="warn">{t.trade.unavailable}</Notice>
      ) : (
        <TradeForm
          key={`${side}:${toOther ? 'other' : 'self'}:${token?.symbol ?? ''}`}
          market={market}
          initialToken={token?.symbol}
          initialSide={side}
          fixedSide={side}
          initialCurrency={params.get('currency') ?? currency}
          initialAmount={amount && /^\d+(\.\d+)?$/.test(amount) ? amount : undefined}
          initialRail={toOther ? (params.get('rail') ?? undefined) : undefined}
          initialDetails={details}
          recipient={toOther ? 'other' : 'self'}
          onConnect={() => navigate('/app')}
          onStep={setStep}
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
