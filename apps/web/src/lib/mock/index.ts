/* Mock mode's entry: the mock API becomes the client's transport. Loaded only in mock mode
   (src/main.tsx imports it dynamically), so a normal build never runs it; the demo wallet loads on
   demand from the sign-in screens. */
import { setTransport } from '@/lib/api/client';
import { mockTransport } from '@/lib/mock/api';

export { resetMock } from '@/lib/mock/db';

export function installMock() {
  setTransport(mockTransport);
}
