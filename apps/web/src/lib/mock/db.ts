/* The mock API's state: what a real API and chain would hold, in this tab's memory, saved to
   sessionStorage so a reload (or a dev hot reload) keeps the session and every order. Orders move
   on their own as time passes (a merchant accepting, paying, releasing), the way the indexer
   would move them from on-chain events. */
import { keccak256, stringToHex } from 'viem';
import {
  BUSINESS_WALLET,
  DEMO_ADDRESS,
  MARKET,
  MERCHANTS,
  MERCHANT_WALLET,
  NETWORKS,
  ORGS,
} from '@/lib/mock/fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Wire = Record<string, any>;

export interface MockState {
  v: number;
  session: { address: string } | null;
  orgs: Wire[];
  members: Record<string, Wire[]>;
  orders: Wire[];
  quotes: Record<string, Wire>;
  accounts: Wire[];
  challenges: Record<string, Wire>;
  methods: Wire[];
  offers: Wire[];
  charges: Wire[];
  payouts: Wire[];
  keys: Wire[];
  webhooks: Wire[];
  deliveries: Wire[];
  payerTokens: Record<string, string>;
  nextOnchainId: number;
}

const VERSION = 3;
const STORAGE_KEY = 'pedospe.mock';

export const now = () => Date.now();
export const iso = (ms: number) => new Date(ms).toISOString();
export const rid = (prefix: string, n = 12) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return `${prefix}_${[...bytes].map((b) => (b % 36).toString(36)).join('')}`;
};
export const hash32 = () =>
  `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
export const refOf = (id: string) => keccak256(stringToHex(id));
export const units = (decimal: number, decimals = 6) =>
  BigInt(Math.round(decimal * 10 ** decimals)).toString();

const MIN = 60_000;

function token(network: string, symbol = 'USDC') {
  const n = NETWORKS.find((x) => x.id === network)!;
  return n.tokens.find((t) => t.symbol === symbol)!;
}

/** One order in the API's wire shape, with the mock's private fields (`_...`). */
export function makeOrder(o: {
  kind: 'BUY' | 'SELL' | 'CHARGE' | 'PAYOUT';
  status: string;
  owner: string; // 'app' or an organization id: who created it
  merchantOrg?: string | null; // the organization whose merchant took it
  network?: string;
  symbol?: string;
  fiat: number;
  currency: string;
  rail: string;
  price: number;
  buyer: string;
  seller: string;
  merchant?: Wire;
  createdAgoMin?: number;
  extra?: Wire;
  auto?: boolean;
}): Wire {
  const created = now() - (o.createdAgoMin ?? 0) * MIN;
  const network = o.network ?? 'base';
  const t = token(network, o.symbol);
  const tokens = Math.floor((o.fiat / o.price) * 100) / 100;
  const id = rid('ord');
  const bonded = o.kind === 'SELL' || o.kind === 'PAYOUT';
  return {
    id,
    ref: refOf(id),
    kind: o.kind,
    status: o.status,
    network,
    token: t.address,
    tokenSymbol: t.symbol,
    tokenDecimals: t.decimals,
    tokenAmount: units(tokens, t.decimals),
    fiatAmount: o.fiat.toFixed(o.currency === 'CLP' ? 0 : 2),
    currency: o.currency,
    rail: o.rail,
    price: String(o.price),
    feeBps: MARKET.protocolFeeBps,
    integratorFeeBps: 0,
    buyerAddress: o.buyer,
    sellerAddress: o.seller,
    bond: bonded ? units(tokens * 0.1, t.decimals) : '0',
    merchant: o.merchant ?? MERCHANTS[0],
    paymentDeadline: null,
    acceptDeadline: null,
    settleDeadline: null,
    paymentDetails: null,
    beneficiary: null,
    payer: null,
    paidReference: null,
    onchainId: null,
    txHashes: {},
    chargeId: null,
    payoutBatchId: null,
    externalReference: null,
    createdAt: iso(created),
    updatedAt: iso(created),
    _owner: o.owner,
    _merchantOrg: o.merchantOrg ?? null,
    _auto: o.auto ?? true,
    _t: {},
    ...o.extra,
  };
}

function seed(): MockState {
  const t = now();
  const s: MockState = {
    v: VERSION,
    session: null,
    orgs: ORGS.map((o) => ({ ...o })),
    members: {
      org_nortecambios: [
        { address: DEMO_ADDRESS, role: 'owner', label: null, addedAt: '2026-09-02T13:00:00.000Z' },
        {
          address: '0x0a5e000000000000000000000000000000000a11',
          role: 'admin',
          label: 'Operaciones',
          addedAt: '2026-09-10T18:00:00.000Z',
        },
      ],
      org_tiendalerma: [
        {
          address: '0x7e11a00000000000000000000000000000000001',
          role: 'owner',
          label: 'Dueña',
          addedAt: '2026-10-11T15:30:00.000Z',
        },
        { address: DEMO_ADDRESS, role: 'admin', label: null, addedAt: '2026-10-12T09:00:00.000Z' },
      ],
    },
    orders: [],
    quotes: {},
    accounts: [
      {
        id: 'acc_norte_treasury',
        _org: 'org_nortecambios',
        address: MERCHANT_WALLET,
        label: 'Tesorería',
        verifiedAt: '2026-09-02T13:10:00.000Z',
        createdAt: '2026-09-02T13:10:00.000Z',
        displayName: 'Norte Cambios',
        merchantStatus: 'ACTIVE',
        stats: {
          completedOrders: 1284,
          cancelledOrders: 9,
          disputesLost: 1,
          medianReleaseSeconds: 140,
          lastActiveAt: iso(t - 3 * MIN),
        },
        networks: [
          {
            network: 'base',
            balances: [
              {
                token: token('base').address,
                symbol: 'USDC',
                decimals: 6,
                freeUnits: units(12450.5),
                lockedUnits: units(233.45),
              },
              {
                token: token('base', 'USDT').address,
                symbol: 'USDT',
                decimals: 6,
                freeUnits: units(800),
                lockedUnits: '0',
              },
            ],
            matcher: { maxPerOrder: units(2000), autoSettle: false },
            operators: { '0xb07000000000000000000000000000000000b075': 6 },
          },
          {
            network: 'arbitrum',
            balances: [
              {
                token: token('arbitrum').address,
                symbol: 'USDC',
                decimals: 6,
                freeUnits: units(3100),
                lockedUnits: '0',
              },
            ],
            matcher: { maxPerOrder: '0', autoSettle: false },
            operators: {},
          },
        ],
      },
      {
        id: 'acc_lerma_collect',
        _org: 'org_tiendalerma',
        address: BUSINESS_WALLET,
        label: 'Cobros',
        verifiedAt: '2026-10-11T16:00:00.000Z',
        createdAt: '2026-10-11T16:00:00.000Z',
        networks: [
          {
            network: 'base',
            balances: [
              {
                token: token('base').address,
                symbol: 'USDC',
                decimals: 6,
                freeUnits: units(5000),
                lockedUnits: units(410.2),
              },
            ],
            matcher: { maxPerOrder: units(1000), autoSettle: false },
            operators: {},
          },
        ],
      },
    ],
    challenges: {},
    methods: [
      {
        id: 'pm_ars_main',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        currency: 'ARS',
        rail: 'ar_bank_transfer',
        label: 'Cuenta principal',
        holderName: 'Norte Cambios SRL',
        document: '30712345679',
        details: { cbu: '0170099222000001234561', cuit: '30712345679' },
        active: true,
        createdAt: '2026-09-02T14:00:00.000Z',
        summary: 'CBU ···· 4561',
      },
      {
        id: 'pm_brl_pix',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        currency: 'BRL',
        rail: 'br_pix',
        label: 'PIX',
        holderName: 'Norte Câmbio Ltda',
        document: null,
        details: { keyType: 'email', key: 'pix@nortecambios.example' },
        active: true,
        createdAt: '2026-09-20T14:00:00.000Z',
        summary: 'email pix@nortecambios.example',
      },
      {
        id: 'pm_mxn_spei',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        currency: 'MXN',
        rail: 'mx_spei',
        label: null,
        holderName: 'Cambios del Norte SA',
        document: null,
        details: { clabe: '002010077777777771' },
        active: false,
        createdAt: '2026-10-01T14:00:00.000Z',
        summary: 'CLABE ···· 7771',
      },
    ],
    offers: [
      {
        id: 'off_ars_sell',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        side: 'SELL_TOKEN',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        currency: 'ARS',
        rails: ['ar_bank_transfer'],
        price: '1488.5',
        priceUpdatedAt: iso(t - 4 * MIN),
        priceTtlSeconds: 3600,
        minFiat: '10000',
        maxFiat: '2000000',
        active: true,
        createdAt: '2026-09-03T12:00:00.000Z',
      },
      {
        id: 'off_ars_buy',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        side: 'BUY_TOKEN',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        currency: 'ARS',
        rails: ['ar_bank_transfer'],
        price: '1452',
        priceUpdatedAt: iso(t - 4 * MIN),
        priceTtlSeconds: 3600,
        minFiat: '10000',
        maxFiat: '1500000',
        active: true,
        createdAt: '2026-09-03T12:00:00.000Z',
      },
      {
        id: 'off_brl_sell',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        side: 'SELL_TOKEN',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        currency: 'BRL',
        rails: ['br_pix'],
        price: '5.47',
        priceUpdatedAt: iso(t - 9 * MIN),
        priceTtlSeconds: 900,
        minFiat: '50',
        maxFiat: '25000',
        active: true,
        createdAt: '2026-09-21T12:00:00.000Z',
      },
      {
        id: 'off_mxn_sell',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        side: 'SELL_TOKEN',
        network: 'arbitrum',
        token: token('arbitrum').address,
        tokenSymbol: 'USDC',
        currency: 'MXN',
        rails: ['mx_spei'],
        price: '18.70',
        priceUpdatedAt: iso(t - 190 * MIN),
        priceTtlSeconds: 900,
        minFiat: '200',
        maxFiat: '60000',
        active: true,
        createdAt: '2026-10-02T12:00:00.000Z',
      },
      {
        id: 'off_brl_buy',
        _org: 'org_nortecambios',
        accountId: 'acc_norte_treasury',
        side: 'BUY_TOKEN',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        currency: 'BRL',
        rails: ['br_pix'],
        price: '5.36',
        priceUpdatedAt: iso(t - 600 * MIN),
        priceTtlSeconds: 3600,
        minFiat: '50',
        maxFiat: '20000',
        active: false,
        createdAt: '2026-09-21T12:00:00.000Z',
      },
    ],
    charges: [
      {
        id: 'ch_pedido1042',
        _org: 'org_tiendalerma',
        currency: 'ARS',
        fiatAmount: '25000.00',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        recipientAddress: BUSINESS_WALLET,
        description: 'Pedido #1042: dos frascos de dulce de cayote',
        status: 'open',
        multiUse: false,
        expiresAt: iso(t + 22 * 60 * MIN),
        payeeName: 'Tienda Lerma',
        paidAt: null,
        orders: 0,
        createdAt: iso(t - 40 * MIN),
      },
      {
        id: 'ch_cuotaclub',
        _org: 'org_tiendalerma',
        currency: 'ARS',
        fiatAmount: '12000.00',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        recipientAddress: BUSINESS_WALLET,
        description: 'Cuota mensual del club de lectura',
        status: 'open',
        multiUse: true,
        expiresAt: null,
        payeeName: 'Tienda Lerma',
        paidAt: null,
        orders: 7,
        createdAt: '2026-11-01T12:00:00.000Z',
      },
      {
        id: 'ch_pedido1039',
        _org: 'org_tiendalerma',
        currency: 'ARS',
        fiatAmount: '48500.00',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        recipientAddress: BUSINESS_WALLET,
        description: 'Pedido #1039',
        status: 'paid',
        multiUse: false,
        expiresAt: null,
        payeeName: 'Tienda Lerma',
        paidAt: iso(t - 26 * 60 * MIN),
        orders: 1,
        createdAt: iso(t - 28 * 60 * MIN),
      },
      {
        id: 'ch_pedido1031',
        _org: 'org_tiendalerma',
        currency: 'BRL',
        fiatAmount: '320.00',
        network: 'base',
        token: token('base').address,
        tokenSymbol: 'USDC',
        recipientAddress: BUSINESS_WALLET,
        description: 'Pedido #1031',
        status: 'expired',
        multiUse: false,
        expiresAt: iso(t - 3 * 24 * 60 * MIN),
        payeeName: 'Tienda Lerma',
        paidAt: null,
        orders: 0,
        createdAt: iso(t - 4 * 24 * 60 * MIN),
      },
    ],
    payouts: [],
    keys: [
      {
        id: 'key_bot',
        _org: 'org_nortecambios',
        name: 'Bot de precios',
        prefix: 'pk_test_7f2c',
        tier: 'test',
        scopes: ['p2p:read', 'p2p:write'],
        createdAt: '2026-09-05T10:00:00.000Z',
        lastUsedAt: iso(t - 2 * MIN),
        revokedAt: null,
      },
      {
        id: 'key_bot_live',
        _org: 'org_nortecambios',
        name: 'Bot de precios',
        prefix: 'pk_live_91ad',
        tier: 'live',
        scopes: ['p2p:read', 'p2p:write'],
        createdAt: '2026-09-12T10:00:00.000Z',
        lastUsedAt: iso(t - 1 * MIN),
        revokedAt: null,
      },
      {
        id: 'key_shop',
        _org: 'org_tiendalerma',
        name: 'Tienda online',
        prefix: 'pk_live_c41e',
        tier: 'live',
        scopes: ['p2p:read', 'p2p:write'],
        createdAt: '2026-10-12T10:00:00.000Z',
        lastUsedAt: iso(t - 55 * MIN),
        revokedAt: null,
      },
    ],
    webhooks: [
      {
        id: 'wh_bot',
        _org: 'org_nortecambios',
        url: 'https://bot.nortecambios.example/hooks/pedospe',
        description: 'Bot de liberación',
        events: [
          'P2P_ORDER_CREATED',
          'P2P_ORDER_PAID',
          'P2P_ORDER_COMPLETED',
          'P2P_ORDER_CANCELLED',
          'P2P_ORDER_EXPIRED',
          'P2P_ORDER_DISPUTED',
        ],
        active: true,
        createdAt: '2026-09-05T10:30:00.000Z',
      },
      {
        id: 'wh_shop',
        _org: 'org_tiendalerma',
        url: 'https://tiendalerma.example/api/pedospe',
        description: null,
        events: ['P2P_CHARGE_SUCCEEDED', 'P2P_PAYOUT_BATCH_COMPLETED'],
        active: true,
        createdAt: '2026-10-12T10:30:00.000Z',
      },
    ],
    deliveries: [
      {
        id: 'dlv_1',
        _endpoint: 'wh_bot',
        event: 'P2P_ORDER_PAID',
        status: 'delivered',
        attempts: 1,
        responseStatus: 200,
        createdAt: iso(t - 6 * MIN),
        nextAttemptAt: null,
      },
      {
        id: 'dlv_2',
        _endpoint: 'wh_bot',
        event: 'P2P_ORDER_CREATED',
        status: 'delivered',
        attempts: 1,
        responseStatus: 200,
        createdAt: iso(t - 9 * MIN),
        nextAttemptAt: null,
      },
      {
        id: 'dlv_3',
        _endpoint: 'wh_bot',
        event: 'P2P_ORDER_COMPLETED',
        status: 'failed',
        attempts: 3,
        responseStatus: 502,
        createdAt: iso(t - 70 * MIN),
        nextAttemptAt: iso(t + 8 * MIN),
      },
      {
        id: 'dlv_4',
        _endpoint: 'wh_shop',
        event: 'P2P_CHARGE_SUCCEEDED',
        status: 'delivered',
        attempts: 1,
        responseStatus: 204,
        createdAt: iso(t - 26 * 60 * MIN),
        nextAttemptAt: null,
      },
    ],
    payerTokens: {},
    nextOnchainId: 4100,
  };

  // The merchant's orders to work on, and its history.
  const m = (o: Omit<Parameters<typeof makeOrder>[0], 'owner'>) => {
    const order = makeOrder({
      merchantOrg: 'org_nortecambios',
      owner: 'org_other',
      auto: false,
      ...o,
    });
    order.onchainId = String(s.nextOnchainId++);
    order.txHashes = { open: hash32() };
    s.orders.push(order);
    return order;
  };
  const user = '0x11ce00000000000000000000000000000000f0e1';
  const arsAccount = {
    rail: 'ar_bank_transfer',
    holderName: 'Norte Cambios SRL',
    document: '30712345679',
    details: { cbu: '0170099222000001234561', cuit: '30712345679' },
  };
  m({
    kind: 'BUY',
    status: 'awaiting_payment',
    fiat: 150000,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1488.5,
    buyer: user,
    seller: MERCHANT_WALLET,
    createdAgoMin: 8,
    extra: {
      paymentDeadline: iso(t + 22 * MIN),
      payer: { name: 'Lucía Fernández', document: '32964233' },
      paymentDetails: arsAccount,
    },
  });
  m({
    kind: 'BUY',
    status: 'paid',
    fiat: 85000,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1488.5,
    buyer: user,
    seller: MERCHANT_WALLET,
    createdAgoMin: 14,
    extra: {
      paymentDeadline: iso(t + 16 * MIN),
      payer: { name: 'Martín Gómez', document: '20329642330' },
      paidReference: 'TRX-48213',
      paymentDetails: arsAccount,
    },
  });
  m({
    kind: 'SELL',
    status: 'awaiting_acceptance',
    fiat: 60984,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1452,
    buyer: MERCHANT_WALLET,
    seller: user,
    createdAgoMin: 1,
    extra: {
      acceptDeadline: iso(t + 4 * MIN),
      beneficiary: {
        rail: 'ar_bank_transfer',
        holderName: 'Sofía Ruiz',
        document: '27345678906',
        details: { alias: 'sofia.ruiz.mp', cuit: '27345678906' },
      },
    },
  });
  m({
    kind: 'SELL',
    status: 'awaiting_payment',
    fiat: 1072,
    currency: 'BRL',
    rail: 'br_pix',
    price: 5.36,
    buyer: MERCHANT_WALLET,
    seller: user,
    createdAgoMin: 6,
    extra: {
      paymentDeadline: iso(t + 25 * MIN),
      beneficiary: {
        rail: 'br_pix',
        holderName: 'João Silva',
        document: '52998224725',
        details: { keyType: 'cpf', key: '52998224725' },
      },
    },
  });
  m({
    kind: 'BUY',
    status: 'completed',
    fiat: 297700,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1488.5,
    buyer: user,
    seller: MERCHANT_WALLET,
    createdAgoMin: 26 * 60,
    extra: {
      payer: { name: 'Carla Méndez', document: '27311222337' },
      txHashes: { open: hash32(), paid: hash32(), release: hash32() },
    },
  });
  m({
    kind: 'CHARGE',
    status: 'completed',
    fiat: 48500,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1488.5,
    buyer: BUSINESS_WALLET,
    seller: MERCHANT_WALLET,
    createdAgoMin: 28 * 60,
    extra: { payer: { name: 'Diego Paz', document: '23301234569' }, chargeId: 'ch_pedido1039' },
  });
  m({
    kind: 'SELL',
    status: 'cancelled',
    fiat: 29040,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1452,
    buyer: MERCHANT_WALLET,
    seller: user,
    createdAgoMin: 50 * 60,
  });
  m({
    kind: 'BUY',
    status: 'expired',
    fiat: 40000,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1488.5,
    buyer: user,
    seller: MERCHANT_WALLET,
    createdAgoMin: 72 * 60,
  });
  m({
    kind: 'BUY',
    status: 'disputed',
    fiat: 220000,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: 1488.5,
    buyer: user,
    seller: MERCHANT_WALLET,
    createdAgoMin: 30 * 60,
    extra: { payer: { name: 'Pablo Ortiz', document: '20111222334' }, paidReference: '000981223' },
  });

  // The business's payouts: one batch half-way through.
  const batchId = 'pob_novpayroll';
  const ben = (name: string, alias: string, cuit: string) => ({
    rail: 'ar_bank_transfer',
    holderName: name,
    document: cuit,
    details: { alias, cuit },
  });
  const p = (status: string, fiat: number, b: Wire, ref: string) => {
    const order = makeOrder({
      kind: 'PAYOUT',
      status,
      owner: 'org_tiendalerma',
      merchantOrg: 'org_other',
      fiat,
      currency: 'ARS',
      rail: 'ar_bank_transfer',
      price: 1452,
      buyer: '0x9e77000000000000000000000000000000000c4a',
      seller: BUSINESS_WALLET,
      createdAgoMin: 90,
      extra: {
        beneficiary: b,
        payoutBatchId: batchId,
        externalReference: ref,
        txHashes: { open: hash32() },
      },
    });
    order.onchainId = String(s.nextOnchainId++);
    if (status === 'paid') {
      order.paidReference = 'TRF-55120';
      order.settleDeadline = null;
    }
    s.orders.push(order);
    return order;
  };
  const items = [
    p('completed', 180000, ben('Ana Gómez', 'ana.gomez.mp', '20329642330'), 'nov-001'),
    p('completed', 95000, ben('Jorge Díaz', 'jorge.diaz', '20123456786'), 'nov-002'),
    p('paid', 120000, ben('Valeria Cruz', 'vale.cruz.uala', '27301234564'), 'nov-003'),
  ];
  s.payouts.push({
    id: batchId,
    _org: 'org_tiendalerma',
    network: 'base',
    token: token('base').address,
    tokenSymbol: 'USDC',
    accountId: 'acc_lerma_collect',
    _orderIds: items.map((o) => o.id),
    failedItems: [
      {
        index: 3,
        currency: 'ARS',
        fiatAmount: '50000',
        rail: 'ar_bank_transfer',
        holderName: 'Luis Peña',
        externalReference: 'nov-004',
        reason: 'No merchant takes this amount right now.',
      },
    ],
    createdAt: iso(t - 90 * MIN),
  });
  return s;
}

let state: MockState | null = null;

export function db(): MockState {
  if (state) return state;
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (raw && raw.v === VERSION) state = raw as MockState;
  } catch {
    /* fresh state below */
  }
  state ??= seed();
  return state;
}

export function save() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked: the state lives in memory */
  }
}

/** Start over with the seed data (the demo banner's reset), keeping the signed-in wallet. */
export function resetMock() {
  const session = state?.session ?? null;
  state = seed();
  state.session = session;
  save();
}

/** The wire shape without the mock's private fields. */
export function pub<T extends Wire>(o: T): Wire {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
}

/** Move an order on as its counterpart would (the merchant accepting, paying, releasing), and
    expire it when its deadline passed. Called on every read. */
export function tick(o: Wire): Wire {
  const t = now();
  const w = MARKET.windows;
  const T = o._t ?? (o._t = {});
  const at = (ms: number) => iso(ms);
  const touch = () => (o.updatedAt = at(t));
  if (o.status === 'awaiting_payment' && o.paymentDeadline && Date.parse(o.paymentDeadline) < t) {
    o.status = 'expired';
    touch();
    return o;
  }
  if (o.status === 'awaiting_acceptance' && o.acceptDeadline && Date.parse(o.acceptDeadline) < t) {
    o.status = 'expired';
    touch();
    return o;
  }
  if (!o._auto) return o;
  const created = Date.parse(o.createdAt);
  const buyLike = o.kind === 'BUY' || o.kind === 'CHARGE';
  if (buyLike) {
    if (o.status === 'pending' && t - created > 1500) {
      o.status = 'awaiting_payment';
      o.onchainId = String(db().nextOnchainId++);
      o.paymentDeadline = at(created + w.paymentSeconds * 1000);
      o.txHashes = { ...o.txHashes, open: hash32() };
      touch();
    }
    if (o.status === 'paid' && T.paid && t - T.paid > 6000) {
      o.status = 'completed';
      o.txHashes = { ...o.txHashes, release: hash32() };
      touch();
      onCompleted(o);
    }
    return o;
  }
  // A sale or a payout: the merchant accepts, pays the beneficiary and marks it paid.
  if (o.status === 'awaiting_acceptance' && T.opened && t - T.opened > 4000) {
    o.status = 'awaiting_payment';
    T.accepted = t;
    o.paymentDeadline = at(t + w.paymentSeconds * 1000);
    o.txHashes = { ...o.txHashes, accept: hash32() };
    touch();
  }
  if (o.status === 'awaiting_payment' && T.accepted && t - T.accepted > 6000) {
    o.status = 'paid';
    T.paid = t;
    o.paidReference = `TRF-${Math.floor(10000 + Math.random() * 89999)}`;
    o.settleDeadline = o.kind === 'SELL' ? at(t + w.settleSeconds * 1000) : null;
    o.txHashes = { ...o.txHashes, paid: hash32() };
    touch();
  }
  return o;
}

/** A completed order's side effects: its charge is paid. */
export function onCompleted(o: Wire) {
  if (o.chargeId) {
    const c = db().charges.find((x) => x.id === o.chargeId);
    if (c) {
      c.orders = Number(c.orders ?? 0) + 1;
      if (!c.multiUse) {
        c.status = 'paid';
        c.paidAt = o.updatedAt;
      }
    }
  }
}

export { DEMO_ADDRESS };
