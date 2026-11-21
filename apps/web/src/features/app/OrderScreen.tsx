/* One purchase or sale, followed until it ends (the market's order panel, in the app's frame), with
   its chat with the merchant beside it on a wide screen and below it on a phone. A QR payment has
   its own screen. */
import { Navigate, useNavigate, useParams } from 'react-router';
import { useI18n } from '@/i18n';
import { Skeleton } from '@/components/ui/controls';
import { OrderPanel } from '@/features/trade/OrderPanel';
import { OrderChat } from '@/components/p2p/OrderChat';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';

export default function OrderScreen() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { market, refresh } = useAppData();
  if (!id) return <Navigate to="/app" replace />;
  return (
    <Screen back="/app/activity" title={t.app.order.title} width="page">
      <div className="grid gap-6 pb-6 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start xl:gap-8">
        <div className="mx-auto w-full max-w-[720px] xl:mx-0">
          {market ? (
            <OrderPanel
              key={id}
              id={id}
              market={market}
              onNew={() => navigate('/app')}
              onMoved={refresh}
            />
          ) : (
            <Skeleton className="h-64" />
          )}
        </div>
        <OrderChat
          key={`chat-${id}`}
          scope="app"
          orderId={id}
          className="mx-auto w-full max-w-[720px] xl:sticky xl:top-8 xl:mx-0"
        />
      </div>
    </Screen>
  );
}
