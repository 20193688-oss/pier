/* Providers and routes. The payments app (/app/*), the dashboard and the docs load as their own
   chunks; Pollar loads beside the app (never around it) only when this build has its key. */
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, Link, Outlet, RouterProvider, useLocation } from 'react-router';
import { I18nProvider, useDocumentMeta, useT } from '@/i18n';
import { SessionProvider } from '@/lib/session';
import { ToastProvider } from '@/components/ui/Toast';
import { SiteLayout } from '@/components/layout/SiteFrame';
import { Spinner } from '@/components/ui/controls';
import LandingPage from '@/features/landing/LandingPage';
import { POLLAR_KEY } from '@/lib/wallet/pollar-store';
import { MOCK } from '@/lib/env';
import { APP_TIER } from '@/lib/api/endpoints';

const AppRoot = lazy(() => import('@/features/app/AppRoot'));
const PollarRoot = lazy(() => import('@/lib/wallet/pollar'));
const ChargePage = lazy(() => import('@/features/charge/ChargePage'));
const DashboardApp = lazy(() => import('@/features/dashboard/DashboardApp'));
const DocsApp = lazy(() => import('@/features/docs/DocsApp'));

function Loading() {
  const t = useT();
  return (
    <div className="flex min-h-[40vh] items-center justify-center gap-3 text-ink-3" role="status">
      <Spinner />
      {t.common.actions.loading}
    </div>
  );
}

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

function Site({ children }: { children?: ReactNode }) {
  return (
    <SiteLayout>
      <Suspense fallback={<Loading />}>{children ?? <Outlet />}</Suspense>
    </SiteLayout>
  );
}

function NotFound() {
  const t = useT();
  useDocumentMeta(`${t.common.notFound.title} · ${t.common.brand}`);
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-4 px-4 py-24">
      <h1 className="text-[2rem]">{t.common.notFound.title}</h1>
      <p className="text-ink-2">{t.common.notFound.body}</p>
      <Link to="/" className="btn btn-ink">
        {t.common.notFound.home}
      </Link>
    </div>
  );
}

function Root() {
  return (
    <>
      <ScrollToTop />
      <Outlet />
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <Site />,
        children: [
          { path: '/', element: <LandingPage /> },
          { path: '/docs/*', element: <DocsApp /> },
          { path: '*', element: <NotFound /> },
        ],
      },
      // The API links a charge as <web>/pay/<id>; /c/<id> is the short form.
      ...['/pay/:chargeId', '/c/:chargeId'].map((path) => ({
        path,
        element: (
          <Suspense fallback={<Loading />}>
            <ChargePage />
          </Suspense>
        ),
      })),
      {
        path: '/app/*',
        element: (
          <Suspense fallback={<Loading />}>
            <AppRoot />
          </Suspense>
        ),
      },
      {
        path: '/dashboard/*',
        element: (
          <Suspense fallback={<Loading />}>
            <DashboardApp />
          </Suspense>
        ),
      },
    ],
  },
]);

/* Pollar's network follows the market tier: testnet for test, mainnet for live. */
const POLLAR_NETWORK = APP_TIER === 'live' ? 'mainnet' : 'testnet';

export function App() {
  return (
    <I18nProvider>
      <SessionProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
        {POLLAR_KEY && !MOCK && (
          <Suspense fallback={null}>
            <PollarRoot apiKey={POLLAR_KEY} network={POLLAR_NETWORK} />
          </Suspense>
        )}
      </SessionProvider>
    </I18nProvider>
  );
}
