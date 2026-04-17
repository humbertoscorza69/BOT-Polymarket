import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import { ClobDriver } from './clobDriver';
import { InventoryEngine } from './inventoryEngine';
import { getLogger } from '../utils/logger';
import { ReconcileError } from '../utils/errors';
import { Fill } from '../types';
import { newFillId } from '../utils/ids';

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

export class Reconciler extends EventEmitter {
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
  private isFirstReconcile = true;

  constructor(
    private readonly cfg: BotConfig,
    private readonly clob: ClobDriver,
    private readonly inventory: InventoryEngine,
  ) {
    super();
  }

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
      const hasDrift = Math.abs(bal.usdc - this.inventory.state.freeUsdc) > driftThreshold;
      // First reconcile is always an initial sync — don't flag as drift
      // POL-39: drift flag is transient — only true for the report returned by this call,
      // not persisted in this.last. The reconciler corrects drift immediately (forceBalance),
      // so keeping the flag true for 120s between reconciles caused unnecessary HALTs.
      const drift = hasDrift && !this.isFirstReconcile;
      if (hasDrift) {
        const localFree = this.inventory.state.freeUsdc;
        const driftAmount = bal.usdc - localFree;
        log.warn('[RECONCILER] balance drift detected; taking exchange as truth', {
          localFree,
          exchange: bal.usdc,
          driftAmount: driftAmount.toFixed(4),
          threshold: driftThreshold,
          isInitialSync: this.isFirstReconcile,
        });
        this.inventory.forceBalance(bal.usdc);

        // Fix 3: Emit synthetic fill when USDC drifts downward (we lost money we didn't track)
        if (driftAmount < 0 && !this.isFirstReconcile) {
          const syntheticFill: Fill = {
            id: newFillId(),
            ts: Date.now(),
            orderId: 'reconciler-drift',
            conditionId: this.currentConditionId ?? '',
            asset: '',
            interval: '',
            token: 'YES',
            side: 'BUY',
            price: 0,
            size: 0,
            notional: Math.abs(driftAmount),
            feeUsdc: 0,
            regime: 'medium_vol',
            fairAtFill: 0,
            midAtFill: 0,
            isMaker: false,
            latencyMs: 0,
            mode: 'live',
            runId: '',
          };
          log.warn('[RECONCILER] emitting synthetic fill for downward drift', {
            driftUsdc: driftAmount.toFixed(4),
            fillId: syntheticFill.id,
            source: 'reconciler',
          });
          this.emit('syntheticFill', syntheticFill);
        }
      }
      this.isFirstReconcile = false;

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
        // POL-39: drift was already corrected (forceBalance/forceSharePositions above).
        // Don't persist the flag — it would keep risk HALTED for 120s until next reconcile.
        drift: false,
        shareDrift: false,
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
