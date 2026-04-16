import EventEmitter from 'eventemitter3';
import { BinanceSnapshot, FeatureSnapshot } from '../types';
import { getLogger } from '../utils/logger';

const log = getLogger('latency-arb');

export interface CancelCoordinatorOpts {
  velocityBpsTrigger: number; // Binance velocity bps/sec triggering pre-emptive cancel
  aggressorTrigger: number; // abs aggressor ratio trigger
  freezeMs: number; // how long to stay frozen after a trigger
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

  constructor(private readonly opts: CancelCoordinatorOpts = { velocityBpsTrigger: 12, aggressorTrigger: 0.55, freezeMs: 1200 }) {
    super();
  }

  feed(bin: BinanceSnapshot | null, features: FeatureSnapshot | null): void {
    if (!bin || !features) return;
    this.lastSnap = bin;
    const vel = Math.abs(bin.priceVelocityBps);
    const aggr = Math.abs(bin.aggressorRatio);

    // Require BOTH velocity AND aggressor to exceed thresholds.
    // High aggressor alone is normal one-sided flow; only dangerous with high velocity.
    if (vel >= this.opts.velocityBpsTrigger && aggr >= this.opts.aggressorTrigger) {
      this.trigger(`velocity=${vel.toFixed(1)}bps aggr=${aggr.toFixed(2)}`);
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
      this.emit('cancelAll', reason);
    }
  }

  isActive(): boolean {
    return Date.now() < this.frozenUntil;
  }

  snapshot(): { active: boolean; recentCancels: Array<{ ts: number; reason: string }>; totalCancels: number } {
    return {
      active: this.isActive(),
      recentCancels: this.recent.slice(-20),
      totalCancels: this.total,
    };
  }
}
