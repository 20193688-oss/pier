import { Injectable } from '@nestjs/common';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import { NETWORKS, type NetworkId, type Tier } from '@/chain/networks';
import {
  P2P_BUY_PAYMENT_WINDOW_SECONDS,
  P2P_CURRENCIES,
  P2P_CURRENCY_CODES,
  P2P_MAX_INTEGRATOR_FEE_BPS,
  P2P_SELL_ACCEPT_WINDOW_SECONDS,
  P2P_SELL_BOND_BPS,
  P2P_SELL_PAYMENT_WINDOW_SECONDS,
  P2P_SELL_SETTLE_WINDOW_SECONDS,
} from '@/p2p/domain/constants';
import { P2P_RAILS, railsFor } from '@/p2p/domain/rails';
import type { MarketOverviewView, NetworkView } from '@/p2p/entities/market.entity';

/** The coin each network pays gas in, as wallets name it. */
const NATIVE_SYMBOLS: Record<NetworkId, string> = {
  eth: 'ETH',
  base: 'ETH',
  arb: 'ETH',
  op: 'ETH',
  pol: 'POL',
  bsc: 'BNB',
  avax: 'AVAX',
  monad: 'MON',
  local: 'ETH',
};

/** The origin of an explorer, from its transaction URL prefix (`<origin>/tx/`). */
function explorerOrigin(txUrl: string | null): string | null {
  if (!txUrl) return null;
  const at = txUrl.indexOf('/tx/');
  return at > 0 ? txUrl.slice(0, at) : null;
}

/**
 * `GET /v1/market`: what anyone needs to integrate on one tier. The networks
 * are the configured deployments that verified on-chain, each with the fee and
 * pause state the contract answers now; one whose node does not answer is
 * left out rather than failing the answer. The RPC URL is only ever the
 * table's public one, never the operator's (which may carry a key).
 */
@Injectable()
export class MarketService {
  constructor(
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
  ) {}

  async overview(tier: Tier): Promise<MarketOverviewView> {
    const live = await this.reader.liveDeployments(tier);
    const networks = (
      await Promise.all(
        live.map(async (d): Promise<NetworkView[]> => {
          try {
            const state = await this.reader.protocolState(d);
            const entry = NETWORKS[d.network].tiers[tier];
            return [
              {
                id: d.network,
                name: d.name,
                chainId: d.chainId,
                nativeSymbol: NATIVE_SYMBOLS[d.network],
                explorerUrl: explorerOrigin(d.explorerTxUrl),
                rpcUrl: entry?.defaultRpcUrl ?? null,
                contract: d.contract,
                protocolFeeBps: state.feeBps,
                paused: state.paused,
                tokens: d.tokens.map((t) => ({ ...t })),
              },
            ];
          } catch {
            return [];
          }
        }),
      )
    ).flat();
    return {
      tier,
      available: networks.length > 0,
      matcher: this.deployments.matcherAddress(),
      bondBps: Number(P2P_SELL_BOND_BPS),
      maxIntegratorFeeBps: P2P_MAX_INTEGRATOR_FEE_BPS,
      windows: {
        buyPaymentWindow: P2P_BUY_PAYMENT_WINDOW_SECONDS,
        sellAcceptWindow: P2P_SELL_ACCEPT_WINDOW_SECONDS,
        sellPaymentWindow: P2P_SELL_PAYMENT_WINDOW_SECONDS,
        sellSettleWindow: P2P_SELL_SETTLE_WINDOW_SECONDS,
      },
      networks,
      currencies: P2P_CURRENCY_CODES.map((code) => ({
        code,
        decimals: P2P_CURRENCIES[code].decimals,
        rails: railsFor(code).map((id) => ({
          id,
          name: P2P_RAILS[id].name,
          fields: P2P_RAILS[id].fields.map((f) => ({
            name: f.name,
            description: f.description,
            required: f.required,
            ...(f.options ? { options: [...f.options] } : {}),
          })),
        })),
      })),
    };
  }
}
