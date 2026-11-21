/* The payments app (/app/*): its own frame and routes. Signed out, every screen shows the welcome
   and sign-in first, and so does a session that ended and could not be renewed (straight to the
   sign-in, never a screen without a session); signed in without an @handle, the handle comes
   next; then the person lands where they were going (a payment link opens the send screen after
   both). Screens load as their own chunks. */
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useDocumentMeta, useI18n } from '@/i18n';
import { sessionGate, useSession } from '@/lib/session';
import { Spinner } from '@/components/ui/controls';
import { AppDataProvider, useAppData } from '@/features/app/data';
import { AppFrame, TAB_PATHS } from '@/features/app/shell';
import { initPwa } from '@/lib/pwa';
import Welcome from '@/features/app/Welcome';
import Home from '@/features/app/Home';

const HandleScreen = lazy(() => import('@/features/app/HandleScreen'));
const Scan = lazy(() => import('@/features/app/Scan'));
const Send = lazy(() => import('@/features/app/Send'));
const Receive = lazy(() => import('@/features/app/Receive'));
const Trade = lazy(() => import('@/features/app/Trade'));
const OrderScreen = lazy(() => import('@/features/app/OrderScreen'));
const PayQr = lazy(() => import('@/features/app/PayQr'));
const QrOrder = lazy(() => import('@/features/app/QrOrder'));
const PayCharge = lazy(() => import('@/features/app/PayCharge'));
const Activity = lazy(() => import('@/features/app/Activity'));
const ActivityDetail = lazy(() => import('@/features/app/ActivityDetail'));
const Me = lazy(() => import('@/features/app/Me'));

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 items-center justify-center gap-3 py-24 text-ink-3" role="status">
      <Spinner />
      {t.common.actions.loading}
    </div>
  );
}

/* Screens a signed-in person without an @handle may still open: the handle itself and the
   profile (to sign out). */
const BEFORE_HANDLE = ['/app/handle', '/app/me'];

/** A screen that needs a signed-in wallet: the welcome first, then the @handle, then the screen.
    A session that ended waits while it is renewed silently, and is the sign-in if it cannot be. */
function Signed({ children }: { children: ReactNode }) {
  const auth = useSession();
  const { session } = auth;
  const { market, profile } = useAppData();
  const { pathname, search } = useLocation();
  const gate = sessionGate(auth);
  if (gate === 'loading') return <Loading />;
  if (gate === 'signin' || !session) return <Welcome />;
  if (profile === undefined && market !== null) return <Loading />;
  const path = pathname.replace(/\/+$/, '') || '/app';
  if (profile && !profile.handle && !BEFORE_HANDLE.includes(path))
    return <Navigate to={`/app/handle?next=${encodeURIComponent(path + search)}`} replace />;
  return <>{children}</>;
}

function Frame() {
  const { t } = useI18n();
  useDocumentMeta(t.app.metaTitle, t.app.metaDescription);
  const { pathname } = useLocation();
  const { session, expired } = useSession();
  const live = !!session && !expired;
  const tabs = live && TAB_PATHS.includes(pathname.replace(/\/+$/, '') || '/app');
  useEffect(() => initPwa(), []);
  return (
    <AppFrame tabs={tabs} nav={live}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route
            index
            element={
              <Signed>
                <Home />
              </Signed>
            }
          />
          <Route path="welcome" element={<Welcome />} />
          <Route
            path="handle"
            element={
              <Signed>
                <HandleScreen />
              </Signed>
            }
          />
          <Route
            path="scan"
            element={
              <Signed>
                <Scan />
              </Signed>
            }
          />
          <Route
            path="send"
            element={
              <Signed>
                <Send />
              </Signed>
            }
          />
          <Route
            path="send/bank"
            element={
              <Signed>
                <Trade side="SELL" toOther />
              </Signed>
            }
          />
          <Route
            path="receive"
            element={
              <Signed>
                <Receive />
              </Signed>
            }
          />
          <Route
            path="add"
            element={
              <Signed>
                <Trade side="BUY" />
              </Signed>
            }
          />
          <Route
            path="withdraw"
            element={
              <Signed>
                <Trade side="SELL" />
              </Signed>
            }
          />
          <Route
            path="order/:id"
            element={
              <Signed>
                <OrderScreen />
              </Signed>
            }
          />
          <Route
            path="pay-qr"
            element={
              <Signed>
                <PayQr />
              </Signed>
            }
          />
          <Route
            path="qr/:id"
            element={
              <Signed>
                <QrOrder />
              </Signed>
            }
          />
          <Route
            path="charge/:id"
            element={
              <Signed>
                <PayCharge />
              </Signed>
            }
          />
          <Route
            path="activity"
            element={
              <Signed>
                <Activity />
              </Signed>
            }
          />
          <Route
            path="activity/:type/:id"
            element={
              <Signed>
                <ActivityDetail />
              </Signed>
            }
          />
          <Route
            path="me"
            element={
              <Signed>
                <Me />
              </Signed>
            }
          />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </Suspense>
    </AppFrame>
  );
}

export default function AppRoot() {
  return (
    <AppDataProvider>
      <Frame />
    </AppDataProvider>
  );
}
