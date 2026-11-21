/* route-list.ts: the routes the web app calls (src/lib/api/routes.ts), grouped by area with their
   methods, for the reference page while the API has not published its OpenAPI document. Built from
   the route table itself, so it cannot drift from what the app sends. Pure;
   tests/unit/docs.test.ts checks every route of the table is listed. */
import { ROUTES } from '@/lib/api/routes';

export type RouteKey = keyof typeof ROUTES;
export type RouteGroupKey =
  'auth' | 'orgs' | 'keys' | 'app' | 'market' | 'merchant' | 'collections' | 'checkout';

type Entry = [
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  key: RouteKey,
  ...args: string[],
];

const GROUPS: [RouteGroupKey, Entry[]][] = [
  [
    'auth',
    [
      ['GET', 'authChallenge'],
      ['POST', 'authVerify'],
      ['GET', 'authSession'],
      ['POST', 'authLogout'],
    ],
  ],
  [
    'orgs',
    [
      ['GET', 'orgs'],
      ['POST', 'orgs'],
      ['GET', 'org', '{orgId}'],
      ['GET', 'members', '{orgId}'],
      ['POST', 'members', '{orgId}'],
      ['PATCH', 'member', '{orgId}', '{memberId}'],
      ['DELETE', 'member', '{orgId}', '{memberId}'],
    ],
  ],
  [
    'keys',
    [
      ['GET', 'apiKeys', '{orgId}'],
      ['POST', 'apiKeys', '{orgId}'],
      ['DELETE', 'apiKey', '{orgId}', '{keyId}'],
      ['GET', 'webhooks'],
      ['POST', 'webhooks'],
      ['PATCH', 'webhook', '{id}'],
      ['DELETE', 'webhook', '{id}'],
      ['GET', 'webhookDeliveries', '{id}'],
    ],
  ],
  [
    'app',
    [
      ['GET', 'appProfile'],
      ['PUT', 'appProfile'],
      ['GET', 'appHandle', '{handle}'],
      ['GET', 'appBalances'],
      ['POST', 'appActivate'],
      ['POST', 'appTransfers'],
      ['GET', 'appTransfer', '{id}'],
      ['GET', 'appActivity'],
      ['GET', 'appCharge', '{id}'],
      ['POST', 'appChargePayments', '{id}'],
      ['POST', 'appSubmit'],
      ['GET', 'appSubmission', '{hash}'],
      ['POST', 'appQuotes'],
      ['GET', 'appOrders'],
      ['POST', 'appOrders'],
      ['GET', 'appOrder', '{id}'],
      ['POST', 'appOrderAction', '{id}', 'paid'],
      ['POST', 'appOrderAction', '{id}', 'cancel'],
      ['POST', 'appOrderAction', '{id}', 'dispute'],
      ['POST', 'appOrderTransactions', '{id}'],
      ['GET', 'orderMessages', 'app', '{id}'],
      ['POST', 'orderMessages', 'app', '{id}'],
      ['GET', 'orderMessageAttachment', 'app', '{id}', '{messageId}'],
      ['POST', 'devSimulateTransfer', '{id}'],
    ],
  ],
  [
    'market',
    [
      ['GET', 'market'],
      ['POST', 'accountChallenge'],
      ['GET', 'accounts'],
      ['POST', 'accounts'],
      ['GET', 'account', '{id}'],
      ['PATCH', 'account', '{id}'],
      ['DELETE', 'account', '{id}'],
      ['GET', 'methods'],
      ['POST', 'methods'],
      ['PATCH', 'method', '{id}'],
      ['DELETE', 'method', '{id}'],
      ['GET', 'offers'],
      ['POST', 'offers'],
      ['PATCH', 'offer', '{id}'],
      ['DELETE', 'offer', '{id}'],
      ['POST', 'quotes'],
      ['GET', 'orders'],
      ['POST', 'orders'],
      ['GET', 'order', '{id}'],
      ['POST', 'orderAction', '{id}', 'paid'],
      ['POST', 'orderAction', '{id}', 'cancel'],
      ['POST', 'orderAction', '{id}', 'dispute'],
      ['GET', 'orderMessages', 'org', '{id}'],
      ['POST', 'orderMessages', 'org', '{id}'],
      ['GET', 'orderMessageAttachment', 'org', '{id}', '{messageId}'],
      ['POST', 'transactions'],
      ['POST', 'submit'],
      ['GET', 'submission', '{hash}'],
    ],
  ],
  [
    'merchant',
    [
      ['GET', 'merchantOrders'],
      ['GET', 'merchantOrder', '{id}'],
      ['GET', 'orderMessages', 'merchant', '{id}'],
      ['POST', 'orderMessages', 'merchant', '{id}'],
      ['GET', 'orderMessageAttachment', 'merchant', '{id}', '{messageId}'],
      ['POST', 'transferMatches'],
    ],
  ],
  [
    'collections',
    [
      ['GET', 'charges'],
      ['POST', 'charges'],
      ['DELETE', 'charge', '{id}'],
      ['GET', 'payouts'],
      ['POST', 'payouts'],
      ['GET', 'payout', '{id}'],
    ],
  ],
  [
    'checkout',
    [
      ['GET', 'checkoutCharge', '{id}'],
      ['POST', 'checkoutChargeOrders', '{id}'],
      ['GET', 'checkoutOrder', '{id}'],
      ['POST', 'checkoutOrderAction', '{id}', 'paid'],
      ['POST', 'checkoutOrderAction', '{id}', 'cancel'],
    ],
  ],
];

export interface RouteRow {
  method: Entry[0];
  key: RouteKey;
  path: string;
}

/** A route's path with its placeholders as `{name}` (the table encodes what it is given). */
function pathOf(key: RouteKey, args: string[]): string {
  const r = ROUTES[key] as string | ((...a: string[]) => string);
  return decodeURIComponent(typeof r === 'function' ? r(...args) : r);
}

export const ROUTE_GROUPS: { key: RouteGroupKey; routes: RouteRow[] }[] = GROUPS.map(
  ([key, entries]) => ({
    key,
    routes: entries.map(([method, route, ...args]) => ({
      method,
      key: route,
      path: pathOf(route, args),
    })),
  }),
);
