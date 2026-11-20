/**
 * Development only: "a bank transfer arrived" for an order on the local dev
 * network. Plays the merchant’s bot through the API’s dev route (refused unless
 * the order is on a test network and the API runs with DEV_TOOLS=true).
 *
 *   npm run dev:simulate -- <orderId> [--api http://localhost:4100]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orderId = args.find((a) => !a.startsWith('--'));
  const apiIndex = args.indexOf('--api');
  const api =
    (apiIndex >= 0 ? args[apiIndex + 1] : undefined) ??
    process.env.PEDOSPE_API_URL ??
    'http://localhost:4100';
  if (!orderId) {
    console.error('usage: simulate-transfer <orderId> [--api <url>]');
    process.exit(1);
  }
  const res = await fetch(`${api}/v1/dev/orders/${orderId}/simulate-transfer`, { method: 'POST' });
  const body = await res.text();
  if (!res.ok) {
    console.error(`${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(body);
  console.log('The indexer moves the order within a few seconds.');
}

void main();
