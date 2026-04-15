import { BotConfig } from '../config';
import { getLogger } from '../utils/logger';
import { ClobDriver } from './clobDriver';
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
    } catch (e) {
      log.error('reconciliation threw; refusing live', { err: String(e) });
      return false;
    }
    this.ready = true;
    this.reconciler.startPeriodic(120_000);
    return true;
  }
}
