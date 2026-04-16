import { BotConfig } from '../config';
import { ClobDriver } from './clobDriver';
import { InventoryEngine } from './inventoryEngine';
import { getLogger } from '../utils/logger';
import { ReconcileError } from '../utils/errors';

const log = getLogger('reconciler');

export interface ReconcileReport {
  ok: boolean;
  reason?: string;
  usdc: number;
  openOrderCount: number;
  drift: boolean;
  lastRun: number;
}

export class Reconciler {
  private last: ReconcileReport = {
    ok: false,
    usdc: 0,
    openOrderCount: 0,
    drift: false,
    lastRun: 0,
  };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: BotConfig,
    private readonly clob: ClobDriver,
    private readonly inventory: InventoryEngine,
  ) {}

  startPeriodic(intervalMs = 120_000): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.reconcile().catch((e) => log.warn('reconcile failed', { err: String(e) }));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getLast(): ReconcileReport {
    return this.last;
  }

  async reconcile(): Promise<ReconcileReport> {
    if (!this.cfg.liveApiEnabled || !this.clob.isAvailable) {
      this.last = {
        ok: true,
        usdc: this.inventory.state.freeUsdc,
        openOrderCount: 0,
        drift: false,
        lastRun: Date.now(),
      };
      return this.last;
    }
    try {
      const [bal, open] = await Promise.all([this.clob.fetchBalance(), this.clob.fetchOpenOrders()]);
      // Simple drift check: free USDC mismatch beyond tolerance
      const drift = Math.abs(bal.usdc - this.inventory.state.freeUsdc) > Math.max(5, this.cfg.bankrollUsdc * 0.2);
      if (drift) {
        log.warn('balance drift detected; taking exchange as truth', {
          localFree: this.inventory.state.freeUsdc,
          exchange: bal.usdc,
        });
        this.inventory.forceBalance(bal.usdc);
      }
      this.last = {
        ok: true,
        usdc: bal.usdc,
        openOrderCount: open.length,
        drift,
        lastRun: Date.now(),
      };
      return this.last;
    } catch (e) {
      log.error('reconcile error', { err: String(e) });
      this.last = {
        ok: false,
        reason: String(e),
        usdc: this.inventory.state.freeUsdc,
        openOrderCount: 0,
        drift: true,
        lastRun: Date.now(),
      };
      throw new ReconcileError('reconcile failed', { err: String(e) });
    }
  }
}
