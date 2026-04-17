import { BotConfig } from '../config';
import { getLogger } from '../utils/logger';
import { ActiveOrder } from '../types';
import { ClobDriver } from './clobDriver';
import { InventoryEngine } from './inventoryEngine';
import { Reconciler } from './reconciler';

const log = getLogger('live-executor');

/**
 * Wrapper responsible for the live-mode readiness checks.
 * Must succeed before the OrderManager is allowed to place live orders.
 */
export class LiveExecutor {
  private ready = false;
  private lastExitAttemptTs = 0;
  private exitCooldownMs = 10_000; // don't spam exit orders

  constructor(
    private readonly cfg: BotConfig,
    private readonly clob: ClobDriver,
    private readonly reconciler: Reconciler,
    private readonly inventory?: InventoryEngine,
  ) {}

  isReady(): boolean {
    return this.ready;
  }

  async bootstrap(): Promise<boolean> {
    if (this.cfg.mode !== 'live' || !this.cfg.liveApiEnabled) {
      log.info('live mode off; executor remains disabled');
      return false;
    }
    log.warn('================================================');
    log.warn('LIVE MODE ENABLED - REAL ORDERS WILL BE PLACED');
    log.warn('================================================');
    const initOk = await this.clob.init();
    if (!initOk) {
      log.error('clob init failed; refusing live');
      return false;
    }
    try {
      const bal = await this.clob.fetchBalance();
      if (bal.usdc <= 0) {
        log.error('zero USDC balance; refusing live');
        return false;
      }
      log.info('live balance confirmed', { usdc: bal.usdc });
    } catch (e) {
      log.error('balance fetch failed; refusing live', { err: String(e) });
      return false;
    }
    try {
      const report = await this.reconciler.reconcile();
      if (!report.ok) {
        log.error('initial reconciliation failed; refusing live');
        return false;
      }
      log.info('initial reconciliation ok', {
        usdc: report.usdc,
        openOrders: report.openOrderCount,
        drift: report.drift,
      });

      // POL-39 Fix 1: Cancel orphaned orders from previous session
      if (report.openOrderCount > 0) {
        log.warn('[RECOVERY] cancelling orphaned orders from previous session', {
          count: report.openOrderCount,
        });
        try {
          const cancelled = await this.clob.cancelAll();
          log.info('[RECOVERY] orphaned orders cancelled', { cancelled });
        } catch (e) {
          log.warn('[RECOVERY] orphan cancel failed (non-fatal)', { err: String(e) });
        }
        // Re-fetch balance after cancellation (collateral may have been freed)
        try {
          const freshBal = await this.clob.fetchBalance();
          if (this.inventory) {
            this.inventory.forceBalance(freshBal.usdc);
          }
          log.info('[RECOVERY] post-cancel balance', { usdc: freshBal.usdc });
        } catch (e) {
          log.warn('[RECOVERY] post-cancel balance fetch failed', { err: String(e) });
        }
      }
    } catch (e) {
      log.error('reconciliation threw; refusing live', { err: String(e) });
      return false;
    }
    this.ready = true;
    this.reconciler.startPeriodic(120_000);
    return true;
  }

  /**
   * Fix 5: Exit stranded inventory.
   * When we hold YES or NO shares but no corresponding BID order exists,
   * place an aggressive ask to liquidate. Prevents indefinite accumulation.
   *
   * @param activeOrders - current active orders from OrderManager
   * @param market - current market with token IDs
   * @param midYes - current YES mid price for aggressive pricing
   */
  async exitStrandedInventory(
    activeOrders: ActiveOrder[],
    market: { yesTokenId: string; noTokenId: string } | null,
    midYes: number | null,
  ): Promise<void> {
    if (!this.ready || !this.inventory || !market || !midYes) return;
    if (!this.clob.isAvailable) return;

    const now = Date.now();
    if (now - this.lastExitAttemptTs < this.exitCooldownMs) return;

    const { yesPosition, noPosition } = this.inventory.state;

    // Check if there's a BUY order for YES or NO
    const hasBuyYes = activeOrders.some((o) => o.side === 'BUY' && o.token === 'YES');
    const hasBuyNo = activeOrders.some((o) => o.side === 'BUY' && o.token === 'NO');

    // Stranded YES: have position but no BID to offset
    if (yesPosition > 0 && !hasBuyYes) {
      const aggressiveAsk = Math.max(0.01, midYes - 0.01); // sell 1c below mid
      const size = yesPosition;
      log.warn('[EXIT] stranded YES inventory — placing aggressive ask', {
        yesPosition,
        askPrice: aggressiveAsk.toFixed(4),
        size: size.toFixed(2),
      });
      try {
        await this.clob.placeOrder({
          tokenId: market.yesTokenId,
          side: 'SELL',
          price: aggressiveAsk,
          size,
          postOnly: false,
        });
        this.lastExitAttemptTs = now;
      } catch (e) {
        log.warn('[EXIT] stranded YES exit failed', { err: String(e) });
      }
    }

    // Stranded NO: have position but no BID to offset
    if (noPosition > 0 && !hasBuyNo) {
      const noMid = 1 - midYes;
      const aggressiveAsk = Math.max(0.01, noMid - 0.01);
      const size = noPosition;
      log.warn('[EXIT] stranded NO inventory — placing aggressive ask', {
        noPosition,
        askPrice: aggressiveAsk.toFixed(4),
        size: size.toFixed(2),
      });
      try {
        await this.clob.placeOrder({
          tokenId: market.noTokenId,
          side: 'SELL',
          price: aggressiveAsk,
          size,
          postOnly: false,
        });
        this.lastExitAttemptTs = now;
      } catch (e) {
        log.warn('[EXIT] stranded NO exit failed', { err: String(e) });
      }
    }
  }
}
