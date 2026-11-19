/* Mock mode's entry: the mock API becomes the client's transport and the demo wallet announces
   itself. Loaded only in mock mode (src/main.tsx imports it dynamically), so a normal build never
   runs it. */
import { setTransport } from '@/lib/api/client';
import { mockTransport } from '@/lib/mock/api';
import { announceDemoWallet } from '@/lib/mock/wallet';

export { resetMock } from '@/lib/mock/db';

export function installMock() {
  setTransport(mockTransport);
  announceDemoWallet();
}
