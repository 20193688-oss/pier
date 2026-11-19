/* The mock API's starting data, in the API's wire shapes (base units, token addresses, flat
   deadlines), so mock mode exercises the same readers (src/lib/p2p/normalize.ts) as the real API.
   Every address here is obviously fake; nothing points at a real network. */

export const DEMO_ADDRESS = '0xde3000000000000000000000000000000000a11e';
export const MATCHER = '0x3a7c4e000000000000000000000000000000beef';

export const NETWORKS = [
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    contract: '0x5eed00000000000000000000000000000000ba5e',
    explorer: null,
    rpcUrl: null,
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'USDC', address: '0xc0c0000000000000000000000000000000000001', decimals: 6 },
      { symbol: 'USDT', address: '0xc0c0000000000000000000000000000000000002', decimals: 6 },
    ],
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    contract: '0x5eed0000000000000000000000000000000a4b17',
    explorer: null,
    rpcUrl: null,
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'USDC', address: '0xc0c0000000000000000000000000000000000003', decimals: 6 },
    ],
  },
  {
    id: 'polygon',
    name: 'Polygon',
    chainId: 137,
    contract: '0x5eed000000000000000000000000000000000137',
    explorer: null,
    rpcUrl: null,
    nativeSymbol: 'POL',
    tokens: [
      { symbol: 'USDC', address: '0xc0c0000000000000000000000000000000000004', decimals: 6 },
    ],
  },
];

const field = (key: string, required = true) => ({ key, required });

export const CURRENCIES = [
  {
    code: 'ARS',
    rails: [
      {
        id: 'ar_bank_transfer',
        fields: [field('cbu', false), field('alias', false), field('cuit')],
      },
    ],
  },
  { code: 'BRL', rails: [{ id: 'br_pix', fields: [field('keyType'), field('key')] }] },
  { code: 'MXN', rails: [{ id: 'mx_spei', fields: [field('clabe')] }] },
  {
    code: 'COP',
    rails: [
      {
        id: 'co_bank_transfer',
        fields: [
          field('bank'),
          field('accountType'),
          field('accountNumber'),
          field('documentType'),
          field('documentNumber'),
        ],
      },
    ],
  },
  {
    code: 'PEN',
    rails: [
      {
        id: 'pe_bank_transfer',
        fields: [field('cci'), field('documentType'), field('documentNumber')],
      },
    ],
  },
  {
    code: 'CLP',
    rails: [
      {
        id: 'cl_bank_transfer',
        fields: [field('bank'), field('accountType'), field('accountNumber'), field('rut')],
      },
    ],
  },
];

/** Price of 1 USDC in each currency, for the user's purchase (the merchant sells) and sale. */
export const PRICES: Record<string, { buy: number; sell: number }> = {
  ARS: { buy: 1488.5, sell: 1452 },
  BRL: { buy: 5.47, sell: 5.36 },
  MXN: { buy: 18.92, sell: 18.55 },
  COP: { buy: 4135, sell: 4060 },
  PEN: { buy: 3.77, sell: 3.7 },
  CLP: { buy: 951, sell: 932 },
};

export const MARKET = {
  networks: NETWORKS,
  currencies: CURRENCIES,
  protocolFeeBps: 30,
  windows: { paymentSeconds: 1800, acceptSeconds: 300, settleSeconds: 21600 },
  sellBondBps: 1000,
  matcher: MATCHER,
  maxPayoutItems: 100,
};

/** The merchants the matcher picks from in mock mode (their public profile only). */
export const MERCHANTS = [
  {
    displayName: 'Norte Cambios',
    completed: 1284,
    completionRate: 0.992,
    medianReleaseSeconds: 140,
    disputesLost: 1,
  },
  {
    displayName: 'Lerma Exchange',
    completed: 312,
    completionRate: 0.981,
    medianReleaseSeconds: 260,
    disputesLost: 0,
  },
];

/** The merchant's own account the user pays into on a purchase, per rail. */
export const MERCHANT_ACCOUNTS: Record<
  string,
  { holderName: string; document: string | null; details: Record<string, string> }
> = {
  ar_bank_transfer: {
    holderName: 'Norte Cambios SRL',
    document: '30-71234567-9',
    details: { cbu: '0170099222000001234561', cuit: '30712345679' },
  },
  br_pix: {
    holderName: 'Norte Câmbio Ltda',
    document: null,
    details: { keyType: 'email', key: 'pix@nortecambios.example' },
  },
  mx_spei: {
    holderName: 'Cambios del Norte SA',
    document: null,
    details: { clabe: '002010077777777771' },
  },
  co_bank_transfer: {
    holderName: 'Cambios Norte SAS',
    document: null,
    details: {
      bank: 'Bancolombia',
      accountType: 'savings',
      accountNumber: '12345678901',
      documentType: 'NIT',
      documentNumber: '9001234567',
    },
  },
  pe_bank_transfer: {
    holderName: 'Cambios Norte SAC',
    document: null,
    details: { cci: '00219300123456789012', documentType: 'RUC', documentNumber: '20100070970' },
  },
  cl_bank_transfer: {
    holderName: 'Cambios Norte SpA',
    document: null,
    details: {
      bank: 'Banco Estado',
      accountType: 'checking',
      accountNumber: '12345678',
      rut: '76.123.456-0',
    },
  },
};

export const ORGS = [
  {
    id: 'org_nortecambios',
    name: 'Norte Cambios',
    role: 'owner',
    createdAt: '2026-09-02T13:00:00.000Z',
  },
  {
    id: 'org_tiendalerma',
    name: 'Tienda Lerma',
    role: 'admin',
    createdAt: '2026-10-11T15:30:00.000Z',
  },
];

/** The merchant organization's registered wallet. */
export const MERCHANT_WALLET = DEMO_ADDRESS;
/** The business organization's registered wallet (collections land here, payouts are paid from it). */
export const BUSINESS_WALLET = '0xb05e000000000000000000000000000000007e11';
