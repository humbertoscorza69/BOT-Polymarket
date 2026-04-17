import { BotConfig } from '../config';
import { getLogger } from '../utils/logger';
import { TokenBucket } from './rateLimiter';
import { ExecutionError } from '../utils/errors';
import { withTimeout } from '../utils/retry';

const log = getLogger('clob.driver');

// Optional import; wrapped in try/catch so the rest of the bot works
// even if @polymarket/clob-client isn't installed in a particular environment.
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
type ClobClientLib = any;
let clobLib: ClobClientLib | null = null;
try {
  clobLib = require('@polymarket/clob-client');
} catch (e) {
  log.warn('@polymarket/clob-client not resolvable; live trading disabled');
}
let ethersLib: any = null;
try {
  ethersLib = require('ethers');
} catch (e) {
  log.warn('ethers not resolvable; live trading disabled');
}
/* eslint-enable */

export interface OrderInput {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number; // in shares
  postOnly?: boolean;
}

export interface OrderResult {
  orderId: string;
  success: boolean;
  errorMsg?: string;
  raw?: unknown;
}

export interface Balance {
  usdc: number;
  collateralAddress?: string;
}

export class ClobDriver {
  private client: any = null;
  private initialized = false;
  private apiErrors = 0;
  private bucket: TokenBucket;
  private circuitOpen = false;
  private circuitUntil = 0;

  constructor(private readonly cfg: BotConfig) {
    this.bucket = new TokenBucket(cfg.rateLimitBurst, cfg.rateLimitOrdersPerSec);
  }

  get isAvailable(): boolean {
    return this.initialized && !this.circuitOpen;
  }

  get apiErrorCount(): number {
    return this.apiErrors;
  }

  async init(): Promise<boolean> {
    if (!this.cfg.liveApiEnabled) {
      log.info('live api disabled via env; skipping clob init');
      return false;
    }
    if (!clobLib || !ethersLib) {
      log.error('required libs missing; cannot init live');
      return false;
    }
    if (!this.cfg.polyPrivateKey || !this.cfg.polyFunderAddress) {
      log.error('missing POLY_PRIVATE_KEY or POLY_FUNDER_ADDRESS');
      return false;
    }
    try {
      const provider = new ethersLib.providers.JsonRpcProvider('https://polygon-rpc.com');
      const wallet = new ethersLib.Wallet(this.cfg.polyPrivateKey, provider);
      const ClobClient = clobLib.ClobClient;
      const Chain = clobLib.Chain ?? { POLYGON: this.cfg.polyChainId };

      this.client = new ClobClient(
        this.cfg.polymarketHttp,
        Chain.POLYGON ?? this.cfg.polyChainId,
        wallet,
        this.cfg.polyApiKey && this.cfg.polyApiSecret && this.cfg.polyApiPassphrase
          ? {
              key: this.cfg.polyApiKey,
              secret: this.cfg.polyApiSecret,
              passphrase: this.cfg.polyApiPassphrase,
            }
          : undefined,
        clobLib.SignatureType?.POLY_PROXY ?? 2,
        this.cfg.polyFunderAddress,
      );

      if (!this.cfg.polyApiKey) {
        log.info('deriving CLOB api creds from wallet');
        try {
          const creds = await this.client.createOrDeriveApiKey();
          this.client = new ClobClient(
            this.cfg.polymarketHttp,
            Chain.POLYGON ?? this.cfg.polyChainId,
            wallet,
            creds,
            clobLib.SignatureType?.POLY_PROXY ?? 2,
            this.cfg.polyFunderAddress,
          );
        } catch (e) {
          log.warn('createOrDeriveApiKey failed', { err: String(e) });
        }
      }
      this.initialized = true;
      log.info('clob driver initialized');
      return true;
    } catch (e) {
      log.error('clob init failed', { err: String(e) });
      return false;
    }
  }

  async fetchBalance(): Promise<Balance> {
    return this.guarded(async () => {
      if (!this.client) throw new ExecutionError('client not initialized');
      if (typeof this.client.getBalanceAllowance === 'function') {
        const r = await this.client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
        const usdc = Number(r?.balance ?? r?.bal ?? 0) / 1e6;
        return { usdc };
      }
      return { usdc: 0 };
    });
  }

  async fetchOpenOrders(): Promise<Array<Record<string, unknown>>> {
    return this.guarded(async () => {
      if (!this.client) throw new ExecutionError('client not initialized');
      if (typeof this.client.getOpenOrders === 'function') {
        const r = await this.client.getOpenOrders();
        return Array.isArray(r) ? r : [];
      }
      return [];
    });
  }

  async fetchPositions(conditionId: string): Promise<{ yes: number; no: number }> {
    return this.guarded(async () => {
      if (!this.client) throw new ExecutionError('client not initialized');
      // Try getPositions or similar SDK method
      if (typeof this.client.getPositions === 'function') {
        const r = await this.client.getPositions({ conditionId });
        const positions = Array.isArray(r) ? r : [r];
        let yes = 0;
        let no = 0;
        for (const p of positions) {
          if (!p) continue;
          const size = Number(p.size ?? p.balance ?? 0);
          const outcome = String(p.outcome ?? p.token ?? '');
          if (outcome === 'Yes' || outcome === 'YES' || p.tokenId === conditionId) yes += size;
          else no += size;
        }
        return { yes, no };
      }
      log.debug('getPositions not available on CLOB client');
      return { yes: 0, no: 0 };
    });
  }

  async fetchTradeHistory(): Promise<Array<Record<string, unknown>>> {
    return this.guarded(async () => {
      if (!this.client) throw new ExecutionError('client not initialized');
      if (typeof this.client.getTrades === 'function') {
        const r = await this.client.getTrades();
        return Array.isArray(r) ? r : [];
      }
      return [];
    });
  }

  async placeOrder(inp: OrderInput): Promise<OrderResult> {
    await this.bucket.take(1);
    return this.guarded(async () => {
      if (!this.client) throw new ExecutionError('client not initialized');
      const order = {
        tokenID: inp.tokenId,
        price: inp.price,
        side: inp.side === 'BUY' ? (clobLib?.Side?.BUY ?? 'BUY') : (clobLib?.Side?.SELL ?? 'SELL'),
        size: inp.size,
        feeRateBps: 0,
      };
      const built = await this.client.createOrder(order);
      const orderType = clobLib?.OrderType?.GTC ?? 'GTC';
      const r = await this.client.postOrder(built, orderType);
      if (inp.postOnly) {
        log.debug('post-only enforced client-side (no native POTO order type in CLOB SDK); spread-cross guard in QuoteEngine prevents taking');
      }
      const orderId = String(r?.orderID ?? r?.orderId ?? r?.id ?? '');
      const success = Boolean(r?.success ?? orderId);
      return { orderId, success, raw: r, errorMsg: success ? undefined : String(r?.errorMsg ?? r?.error ?? 'unknown') };
    });
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    await this.bucket.take(1);
    return this.guarded(async () => {
      if (!this.client) throw new ExecutionError('client not initialized');
      if (typeof this.client.cancelOrder === 'function') {
        const r = await this.client.cancelOrder({ orderID: orderId });
        return Boolean(r);
      }
      return false;
    });
  }

  async cancelAll(): Promise<number> {
    return this.guarded(async () => {
      if (!this.client) throw new ExecutionError('client not initialized');
      if (typeof this.client.cancelAll === 'function') {
        const r = await this.client.cancelAll();
        return Array.isArray(r) ? r.length : Number(r) || 0;
      }
      return 0;
    });
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.circuitOpen && Date.now() < this.circuitUntil) {
      throw new ExecutionError('circuit_breaker_open');
    }
    if (this.circuitOpen && Date.now() >= this.circuitUntil) {
      this.circuitOpen = false;
      this.apiErrors = Math.max(0, this.apiErrors - 5);
    }
    try {
      const out = await withTimeout(fn(), 15_000, 'clob-call');
      return out;
    } catch (e) {
      this.apiErrors += 1;
      if (this.apiErrors >= this.cfg.riskApiErrorCap) {
        this.circuitOpen = true;
        this.circuitUntil = Date.now() + 60_000;
        log.error('circuit breaker opened', { apiErrors: this.apiErrors });
      }
      throw e;
    }
  }
}
