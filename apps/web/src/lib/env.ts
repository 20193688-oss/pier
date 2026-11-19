/* Run-time switches.

   Mock mode serves every screen from the in-browser mock API and the demo wallet: `npm run
   dev:mock` (or a build with VITE_MOCK=1), or `?mock` in the address of a development server
   (kept for the tab, so navigating keeps it). A production build ignores `?mock`. */
const MOCK_KEY = 'pedospe.mock-mode';

function detectMock(): boolean {
  if (import.meta.env.VITE_MOCK === '1') return true;
  if (!import.meta.env.DEV) return false;
  try {
    if (new URLSearchParams(location.search).has('mock')) {
      sessionStorage.setItem(MOCK_KEY, '1');
      return true;
    }
    return sessionStorage.getItem(MOCK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether this build can run mock mode at all: a development server or a VITE_MOCK=1 build. A
    production build replaces both with constants, so the mock API and the demo wallet are
    compiled out of it, not merely unused. */
export const MOCK_BUILD = import.meta.env.DEV || import.meta.env.VITE_MOCK === '1';

export const MOCK = MOCK_BUILD && detectMock();

/** The wallet the mock mode announces; in mock mode only it is offered. */
export const DEMO_WALLET_RDNS = 'com.pedospe.demo';
