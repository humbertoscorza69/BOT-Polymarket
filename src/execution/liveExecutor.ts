import { BotConfig } from '../config';
import { getLogger } from '../utils/logger';
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
}
