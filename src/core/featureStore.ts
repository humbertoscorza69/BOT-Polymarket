import {
  BinanceSnapshot,
  FeatureSnapshot,
  PolySnapshot,
  Regime,
} from '../types';
import { Ema, RollingWindow, zscore } from '../utils/stats';
import { clamp, clamp01, safeDivide } from '../utils/math';
import { nowSec } from '../utils/time';

/**
 * Feature store converts raw snapshots into a rich feature vector.
 * It owns rolling statistics used by the rest of the brain.
 */
export class FeatureStore {
  private midHistory = new RollingWindow(240); // ~2-4 minutes at typical tick rate
  private moveHistory = new RollingWindow(60);
  private spreadHistory = new RollingWindow(60);

  private emaFair = new Ema(0.15);
  private volEma = new Ema(0.1);
  private churnEma = new Ema(0.1);
  private depthAsymEma = new Ema(0.1);
  private momentumEma = new Ema(0.1);
  private toxicEma = new Ema(0.05);
  private participationEma = new Ema(0.05);

  private lastTopBid: number | null = null;
  private lastTopAsk: number | null = null;
  private quoteChurnCount = 0;
  private quoteChurnWindowStart = Date.now();

  update(
    poly: PolySnapshot | null,
    bin: BinanceSnapshot | null,
    asset: string,
    interval: string,
  ): FeatureSnapshot | null {
    if (!poly || poly.midYes === null) return null;

    const now = Date.now();
    const mid = poly.midYes;
    const micro = poly.microYes ?? mid;
    const spread = poly.spreadYes ?? 0;

    this.midHistory.push(mid);
    this.spreadHistory.push(spread);

    const prevMid = this.midHistory.size() >= 2 ? this.midHistory.values()[this.midHistory.size() - 2] : mid;
    const moveBps = (mid - prevMid) * 10_000;
    this.moveHistory.push(moveBps);

    // rolling vol
    const moveStd = this.moveHistory.std();
    this.volEma.update(moveStd);

    // quote churn
    if (this.lastTopBid !== poly.bestBidYes || this.lastTopAsk !== poly.bestAskYes) {
      this.quoteChurnCount += 1;
    }
    this.lastTopBid = poly.bestBidYes;
    this.lastTopAsk = poly.bestAskYes;
    if (now - this.quoteChurnWindowStart > 5000) {
      const rate = this.quoteChurnCount / ((now - this.quoteChurnWindowStart) / 1000);
      this.churnEma.update(rate);
      this.quoteChurnCount = 0;
      this.quoteChurnWindowStart = now;
    }

    // momentum persistence: sign consistency of last 10 moves
    const moves = this.moveHistory.values().slice(-10);
    let sameSign = 0;
    for (let i = 1; i < moves.length; i++) if (Math.sign(moves[i]) === Math.sign(moves[i - 1]) && moves[i] !== 0) sameSign += 1;
    const momentumPersist = moves.length > 1 ? sameSign / (moves.length - 1) : 0;
    this.momentumEma.update(momentumPersist);

    // depth asymmetry
    const bidsTotal = poly.yesBook.bids.slice(0, 5).reduce((s, l) => s + l.size, 0);
    const asksTotal = poly.yesBook.asks.slice(0, 5).reduce((s, l) => s + l.size, 0);
    const depthAsym = safeDivide(bidsTotal - asksTotal, bidsTotal + asksTotal, 0);
    this.depthAsymEma.update(depthAsym);

    // participation: depth scaled by typical
    const depthTotal = bidsTotal + asksTotal;
    this.participationEma.update(Math.log10(1 + depthTotal));

    // binance fields
    const binImbal = bin?.bookImbalance ?? 0;
    const binAggr = bin?.aggressorRatio ?? 0;
    const binVel = bin?.priceVelocityBps ?? 0;
    const volRatio = bin?.volumeRatio ?? 1;

    // confirm = agreement across signals
    const polyPressure = poly.depthImbalance;
    const confirm = Math.sign(polyPressure) === Math.sign(binImbal) && Math.sign(binImbal) === Math.sign(binAggr)
      ? (Math.abs(polyPressure) + Math.abs(binImbal) + Math.abs(binAggr)) / 3
      : 0;
    const crossPressure = clamp(0.5 * polyPressure + 0.3 * binImbal + 0.2 * binAggr, -1, 1);

    // walls
    const wallSupport = bin?.bidWall && bin.mid && bin.bidWall < bin.mid ? clamp01((bin.mid - bin.bidWall) / bin.mid * 100) : 0;
    const wallResistance = bin?.askWall && bin.mid && bin.askWall > bin.mid ? clamp01((bin.askWall - bin.mid) / bin.mid * 100) : 0;

    // time to expiry
    const ttl = Math.max(0, poly.market.endDateTs - nowSec());
    const targetTtl = interval === '5m' ? 300 : interval === '15m' ? 900 : 3600;
    const ttlFactor = clamp01(ttl / targetTtl);

    // stale factor
    const staleFactor = poly.stale ? 1 : clamp01(poly.feedAgeMs / 5000);

    // spread regime
    let spreadRegime: FeatureSnapshot['spreadRegime'] = 'normal';
    const spreadBps = spread * 10_000;
    if (spreadBps < 60) spreadRegime = 'tight';
    else if (spreadBps < 180) spreadRegime = 'normal';
    else if (spreadBps < 400) spreadRegime = 'wide';
    else spreadRegime = 'pathological';

    // liquidity score
    const liquidityScore = clamp01(Math.log10(1 + depthTotal) / 4);
    const bookSparsity = clamp01(1 - liquidityScore);

    // emaFair incorporates micro heavily
    this.emaFair.update(micro);

    // z-score of move
    const moveStdVal = moveStd || 1;
    const zMove = zscore(moveBps, 0, Math.max(1, moveStdVal));

    // toxic flow proxy: sustained same-side aggressor + poly depth decline
    const toxicProxy = clamp01(Math.abs(binAggr) * clamp01(Math.abs(momentumPersist)) * (1 - liquidityScore));
    this.toxicEma.update(toxicProxy);

    // trend slope
    const h = this.midHistory.values();
    let trendSlope = 0;
    if (h.length >= 5) {
      const n = h.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += h[i];
        sumXY += i * h[i];
        sumXX += i * i;
      }
      const denom = n * sumXX - sumX * sumX;
      trendSlope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    }

    // short-reversion score: if momentum > 0 but zMove extreme, expect mean-revert
    const shortReversion = clamp01(Math.abs(zMove) / 3) * (1 - clamp01(momentumPersist));

    // entropy score (chop): inverse of momentum persistence
    const entropyScore = clamp01(1 - momentumPersist);

    // fillOpportunityScore: tight spread, enough depth, not too volatile
    const fillOpp = clamp01(
      0.4 * clamp01(1 - spreadBps / 400) + 0.4 * liquidityScore + 0.2 * clamp01(1 - Math.abs(zMove) / 5),
    );

    // liquidity resilience: how quickly depth recovers (use rolling depth avg vs current)
    const resilience = clamp01(depthTotal > 0 ? 1 : 0); // placeholder proxy

    const snap: FeatureSnapshot = {
      ts: now,
      asset,
      interval,
      conditionId: poly.market.conditionId,
      midYes: mid,
      microYes: micro,
      bestBidYes: poly.bestBidYes,
      bestAskYes: poly.bestAskYes,
      spreadYes: spread,
      fairYes: null, // filled by fairValue module
      moveBps,
      volBps: this.volEma.value,
      velocityBps: binVel,
      polyBookImbalance: poly.depthImbalance,
      binanceBookImbalance: binImbal,
      binanceAggressorRatio: binAggr,
      binancePriceVelocityBps: binVel,
      crossPressure,
      confirm,
      volumeRatio: volRatio,
      wallSupport,
      wallResistance,
      timeToExpirySec: ttl,
      timeToExpiryFactor: ttlFactor,
      staleFactor,
      spreadRegime,
      liquidityScore,
      bookSparsity,
      emaFair: this.emaFair.initialized ? this.emaFair.value : null,
      zMove,
      realizedVolEma: this.volEma.value,
      quoteChurnRate: this.churnEma.value,
      depthAsymmetry: this.depthAsymEma.value,
      liquidityResilience: resilience,
      momentumPersistence: this.momentumEma.value,
      entropyScore,
      toxicFlowProxy: this.toxicEma.value,
      microTrendSlope: trendSlope * 10_000,
      shortReversionScore: shortReversion,
      participationScore: clamp01(this.participationEma.value / 4),
      fillOpportunityScore: fillOpp,
    };
    return snap;
  }

  getMidHistory(): number[] {
    return this.midHistory.values();
  }

  /** Reset all rolling state. Call on market rotation so EMAs from
   *  the old market (different asset/price regime) don't contaminate
   *  the new market's first ticks. */
  reset(): void {
    this.midHistory.clear();
    this.moveHistory.clear();
    this.spreadHistory.clear();
    this.emaFair.reset();
    this.volEma.reset();
    this.churnEma.reset();
    this.depthAsymEma.reset();
    this.momentumEma.reset();
    this.toxicEma.reset();
    this.participationEma.reset();
    this.lastTopBid = null;
    this.lastTopAsk = null;
    this.quoteChurnCount = 0;
    this.quoteChurnWindowStart = Date.now();
  }

}
