import { FeatureSnapshot, Regime, RegimeSnapshot } from '../types';

/**
 * Finite-state regime detector with hysteresis.
 * Harder to leave high-vol-trend than to enter it.
 */
export class RegimeDetector {
  private current: Regime = 'low_vol_balanced';
  private candidate: Regime = 'low_vol_balanced';
  private enteredAt = Date.now();
  private candidateSince = Date.now();
  private confidence = 0.5;
  private lastReason = 'init';

  snapshot(): RegimeSnapshot {
    const now = Date.now();
    return {
      current: this.current,
      candidate: this.candidate,
      ageMs: now - this.enteredAt,
      candidateAgeMs: now - this.candidateSince,
      confidence: this.confidence,
      reason: this.lastReason,
    };
  }

  update(f: FeatureSnapshot): RegimeSnapshot {
    const now = Date.now();
    const volBps = f.realizedVolEma;
    const momentum = f.momentumPersistence;
    const move = Math.abs(f.moveBps);
    const confirm = f.confirm;

    // Classify raw
    let raw: Regime;
    if (volBps < 20) {
      raw = momentum > 0.55 ? 'low_vol_directional' : 'low_vol_balanced';
    } else if (volBps < 60) {
      raw = 'medium_vol';
    } else if (volBps < 140) {
      raw = momentum > 0.6 && confirm > 0.3 ? 'high_vol_trend' : 'high_vol_chop';
    } else {
      raw = momentum > 0.7 ? 'high_vol_trend' : 'high_vol_chop';
    }

    // candidate tracking
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateSince = now;
    }

    // require minimum dwell in candidate before switching (hysteresis)
    // high_vol_trend is hardest to leave
    const candidateAge = now - this.candidateSince;
    const currentAge = now - this.enteredAt;
    const minDwell = this.entryThreshold(this.current, raw);
    const minCurrent = this.exitThreshold(this.current);

    let reason = 'stable';
    if (
      raw !== this.current &&
      candidateAge >= minDwell &&
      currentAge >= minCurrent
    ) {
      reason = `transition ${this.current}->${raw} vol=${volBps.toFixed(1)} mom=${momentum.toFixed(2)} conf=${confirm.toFixed(2)} move=${move.toFixed(1)}`;
      this.current = raw;
      this.enteredAt = now;
    }

    // confidence
    const volComp = Math.min(1, volBps / 100);
    const momComp = momentum;
    this.confidence = 0.5 + 0.25 * (volComp + momComp) * (raw === this.current ? 1 : 0.4);
    if (this.confidence > 1) this.confidence = 1;
    this.lastReason = reason;

    return this.snapshot();
  }

  private entryThreshold(from: Regime, to: Regime): number {
    // if moving into high vol: faster; if moving to low vol from high: slower
    if (to === 'high_vol_trend' || to === 'high_vol_chop') return 1500;
    if (from === 'high_vol_trend') return 6000;
    return 3000;
  }

  private exitThreshold(regime: Regime): number {
    if (regime === 'high_vol_trend') return 5000;
    if (regime === 'high_vol_chop') return 3000;
    return 1500;
  }
}
