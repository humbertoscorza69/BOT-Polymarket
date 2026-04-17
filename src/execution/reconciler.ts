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
  shareDrift: boolean;
  lastRun: number;
}

export class Reconciler {
  private last: ReconcileReport = {
    ok: false,
    usdc: 0,
    openOrderCount: 0,
    drift: false,
    shareDrift: false,
    lastRun: 0,
  };
  private timer: NodeJS.Timeout | null = null;
  private currentConditionId: string | null = null;

  constructor(
    private readonly cfg: BotConfig,
    private readonly clob: ClobDriver,
    private readonly inventory: InventoryEngine,
  ) {}

  setConditionId(conditionId: string | null): void {
    this.currentConditionId = conditionId;
  }

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
        shareDrift: false,
        lastRun: Date.now(),
      };
      return this.last;
    }
    try {
      const [bal, open] = await Promise.all([this.clob.fetchBalance(), this.clob.fetchOpenOrders()]);
      // M2: Tightened drift threshold
      const driftThreshold = Math.max(2, this.cfg.bankrollUsdc * 0.05);
      const drift = Math.abs(bal.usdc - this.inventory.state.freeUsdc) > driftThreshold;
      if (drift) {
        log.warn('[RECONCILER] balance drift detected; taking exchange as truth', {
          localFree: this.inventory.state.freeUsdc,
          exchange: bal.usdc,
          threshold: driftThreshold,
        });
        this.inventory.forceBalance(bal.usdc);
      }

      // B3: Share position reconciliation (live mode only)
      let shareDrift = false;
      if (this.currentConditionId) {
        try {
          const positions = await this.clob.fetchPositions(this.currentConditionId);
          const localYes = this.inventory.state.yesPosition;
          const localNo = this.inventory.state.noPosition;
          const driftYes = Math.abs(positions.yes - localYes);
          const driftNo = Math.abs(positions.no - localNo);
          log.info('[RECONCILER] share check', {
            exchangeYes: positions.yes,
            exchangeNo: positions.no,
            localYes,
            localNo,
            driftYes: driftYes.toFixed(2),
            driftNo: driftNo.toFixed(2),
          });
          if (driftYes > driftThreshold || driftNo > driftThreshold) {
            shareDrift = true;
            log.error('[RECONCILER] share drift detected', {
              exchangeYes: positions.yes, localYes,
              exchangeNo: positions.no, localNo,
            });
            this.inventory.forceSharePositions(positions.yes, positions.no);
          }
        } catch (e) {
          log.warn('[RECONCILER] share position fetch failed', { err: String(e) });
        }
      }

      this.last = {
        ok: true,
        usdc: bal.usdc,
        openOrderCount: open.length,
        drift,
        shareDrift,
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
        shareDrift: false,
        lastRun: Date.now(),
      };
      throw new ReconcileError('reconcile failed', { err: String(e) });
    }
  }
}
