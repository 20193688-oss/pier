/* One purchase or sale, followed until it ends (the market's order panel, in the app's frame). A
   QR payment has its own screen. */
import { Navigate, useNavigate, useParams } from 'react-router';
import { useI18n } from '@/i18n';
import { Skeleton } from '@/components/ui/controls';
import { OrderPanel } from '@/features/trade/OrderPanel';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';

export default function OrderScreen() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { market, refresh } = useAppData();
  if (!id) return <Navigate to="/app" replace />;
  return (
    <Screen back="/app/activity" title={t.app.order.title}>
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
    </Screen>
  );
}
