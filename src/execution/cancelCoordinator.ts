import EventEmitter from 'eventemitter3';
import { BinanceSnapshot, FeatureSnapshot } from '../types';
import { getLogger } from '../utils/logger';

const log = getLogger('latency-arb');

export interface CancelCoordinatorOpts {
  velocityBpsTrigger: number; // Binance velocity bps/sec triggering pre-emptive cancel
  aggressorTrigger: number; // abs aggressor ratio trigger
  freezeMs: number; // how long to stay frozen after a trigger
  velocityAloneBpsTrigger: number; // velocity-only cancel (no aggressor needed) — flash move defense
}

/**
 * Latency arbitrage defense: listens to external (Binance) signals
 * and fires pre-emptive cancels when the external market moves fast.
 */
export class CancelCoordinator extends EventEmitter {
  private frozenUntil = 0;
  private recent: Array<{ ts: number; reason: string }> = [];
  private total = 0;
  private lastSnap: BinanceSnapshot | null = null;
  private saves: Array<{ ts: number; reason: string; polyMidBefore: number | null; polyMidAfter: number | null; estimatedSaveUsdc: number }> = [];
  private pendingSave: { ts: number; reason: string; polyMidBefore: number | null } | null = null;
  private getPolyMid: (() => number | null) | null = null;

  constructor(private readonly opts: CancelCoordinatorOpts = { velocityBpsTrigger: 12, aggressorTrigger: 0.55, freezeMs: 1200, velocityAloneBpsTrigger: 25 }) {
    super();
  }

  /** Set poly mid getter for cancel-save tracking (2C) */
  setPolyMidGetter(fn: () => number | null): void {
    this.getPolyMid = fn;
  }

  feed(bin: BinanceSnapshot | null, features: FeatureSnapshot | null): void {
    if (!bin || !features) return;
    this.lastSnap = bin;
    const vel = Math.abs(bin.priceVelocityBps);
    const aggr = Math.abs(bin.aggressorRatio);

    // Check pending save 500ms after cancel
    if (this.pendingSave && Date.now() - this.pendingSave.ts >= 500) {
      const midAfter = this.getPolyMid?.() ?? null;
      const midBefore = this.pendingSave.polyMidBefore;
      const moveBps = midBefore !== null && midAfter !== null ? Math.abs(midAfter - midBefore) * 10_000 : 0;
      const estimatedSaveUsdc = moveBps > 0 ? (moveBps / 10_000) * 5 : 0; // rough estimate based on $5 quote size
      this.saves.push({ ts: this.pendingSave.ts, reason: this.pendingSave.reason, polyMidBefore: midBefore, polyMidAfter: midAfter, estimatedSaveUsdc });
      if (this.saves.length > 200) this.saves.shift();
      log.info('[CANCEL-SAVE]', { reason: this.pendingSave.reason, polyMidBefore: midBefore?.toFixed(4), polyMid500msLater: midAfter?.toFixed(4), moveBps: moveBps.toFixed(1), estimatedSaveUsdc: estimatedSaveUsdc.toFixed(4) });
      this.pendingSave = null;
    }

    // Require BOTH velocity AND aggressor to exceed thresholds.
    if (vel >= this.opts.velocityBpsTrigger && aggr >= this.opts.aggressorTrigger) {
      this.trigger(`velocity=${vel.toFixed(1)}bps aggr=${aggr.toFixed(2)}`);
    }

    // Velocity-only cancel: flash move defense — no aggressor check needed
    if (vel >= this.opts.velocityAloneBpsTrigger) {
      this.trigger(`velocity-alone=${vel.toFixed(1)}bps`);
    }
  }

  trigger(reason: string): void {
    const now = Date.now();
    const wasFrozen = now < this.frozenUntil;
    this.frozenUntil = now + this.opts.freezeMs;
    if (!wasFrozen) {
      this.total += 1;
      this.recent.push({ ts: now, reason });
      if (this.recent.length > 50) this.recent.shift();
      log.info('preemptive cancel trigger', { reason });
      // 2C: Start tracking cancel save
      this.pendingSave = { ts: now, reason, polyMidBefore: this.getPolyMid?.() ?? null };
      this.emit('cancelAll', reason);
    }
  }

  isActive(): boolean {
    return Date.now() < this.frozenUntil;
  }

  snapshot(): { active: boolean; recentCancels: Array<{ ts: number; reason: string }>; totalCancels: number; cancelSaves: Array<{ ts: number; reason: string; polyMidBefore: number | null; polyMidAfter: number | null; estimatedSaveUsdc: number }>; totalEstimatedSavesUsdc: number } {
    return {
      active: this.isActive(),
      recentCancels: this.recent.slice(-20),
      totalCancels: this.total,
      cancelSaves: this.saves.slice(-20),
      totalEstimatedSavesUsdc: this.saves.reduce((s, c) => s + c.estimatedSaveUsdc, 0),
    };
  }
}
