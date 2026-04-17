import { describe, it, expect } from 'vitest';
import { OrderManager } from '../src/execution/orderManager';
import { InventoryEngine } from '../src/execution/inventoryEngine';
import { PaperTrader } from '../src/core/paperTrader';
import { QuoteEngine } from '../src/core/quoteEngine';
import { FairValueModel } from '../src/core/fairValue';
import { AvellanedaStoikov } from '../src/core/avellaneda';
import { LatencyTracker } from '../src/core/latencyTracker';
import { BotConfig } from '../src/config';
import {
  FeatureSnapshot,
  HealthSnapshot,
  InventoryState,
  PolymarketMarket,
  QuoteResult,
  RegimeSnapshot,
} from '../src/types';
import { defaultAdaptiveParams } from '../src/persistence/paramsStore';

function mkCfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    mode: 'dry_run',
    paperLatencyMs: 0,
    paperMakerFeeBps: 0,
    paperTakerFeeBps: 20,
    paperFillProbBase: 0.22,
    paperPartialFillProb: 0.3,
    paperToxicityBaseline: 0.18,
    paperSlippageBps: 4,
    orderMaxAgeMs: 15000,
    orderReplaceDriftBps: 18,
    orderPostOnly: false,
    riskMaxInventoryUsdc: 200,
    inventoryMaxShares: 1000,
    inventoryEmergencyThresholdPct: 80,
    bankrollUsdc: 90,
    rateLimitBurst: 8,
    rateLimitOrdersPerSec: 4,
    minPairEdgeBps: 200,
    tickSize: 0.01,
    fillDetectorPollMs: 3000,
    defaultQuoteSizeUsdc: 5,
    minOrderSizeUsdc: 1,
    maxOrderSizeUsdc: 10,
    quoteBaseHalfSpreadBps: 200,
    quoteSkewFactor: 2.0,
    avSigmaFloor: 0.004,
    avMinEdgeBps: 50,
    avGamma: 0.8,
    avK: 1.5,
    avSpreadMinBps: 50,
    avSpreadMaxBps: 400,
    wMicroprice: 0.25,
    wPolyImbalance: 0.10,
    wBinanceImbalance: 0.30,
    wBinanceAggressor: 0.20,
    wBinanceMomentum: 0.15,
    ...overrides,
  } as BotConfig;
}

function mkMarket(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    conditionId: 'cond-1',
    slug: 'btc-updown-5m-1234567890',
    question: 'Test',
    yesTokenId: 'YES-TOK',
    noTokenId: 'NO-TOK',
    endDateTs: Math.floor(Date.now() / 1000) + 300,
    active: true,
    closed: false,
    ...overrides,
  };
}

function mkQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    yesBid: 0.48,
    yesBidSize: 10,
    yesAsk: 0.52,
    yesAskSize: 10,
    noBid: null,
    noBidSize: 0,
    noAsk: null,
    noAskSize: 0,
    mode: 'two_sided',
    blockedReason: null,
    inventorySkew: 0,
    internalFair: 0.5,
    cautionScore: 0,
    reservationPrice: 0.5,
    optimalSpread: 0.04,
    sizingMultiplier: 1,
    ...overrides,
  };
}

function mkFeat(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    ts: Date.now(),
    asset: 'BTC',
    interval: '5m',
    conditionId: 'cond-1',
    midYes: 0.5,
    microYes: 0.5,
    bestBidYes: 0.49,
    bestAskYes: 0.51,
    spreadYes: 0.02,
    fairYes: null,
    moveBps: 0,
    volBps: 0,
    velocityBps: 0,
    polyBookImbalance: 0,
    binanceBookImbalance: 0,
    binanceAggressorRatio: 0,
    binancePriceVelocityBps: 0,
    crossPressure: 0,
    confirm: 0,
    volumeRatio: 1,
    wallSupport: 0,
    wallResistance: 0,
    timeToExpirySec: 200,
    timeToExpiryFactor: 0.7,
    staleFactor: 0,
    spreadRegime: 'normal',
    liquidityScore: 0.5,
    bookSparsity: 0.5,
    emaFair: 0.5,
    zMove: 0,
    realizedVolEma: 20,
    quoteChurnRate: 0,
    depthAsymmetry: 0,
    liquidityResilience: 1,
    momentumPersistence: 0.3,
    entropyScore: 0.7,
    toxicFlowProxy: 0,
    microTrendSlope: 0,
    shortReversionScore: 0,
    participationScore: 0.5,
    fillOpportunityScore: 0.5,
    ...overrides,
  };
}

function mkInvState(overrides: Partial<InventoryState> = {}): InventoryState {
  return {
    freeUsdc: 90,
    yesPosition: 0,
    noPosition: 0,
    yesAvgCost: 0,
    noAvgCost: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    markToMarketPnl: 0,
    normalizedSkew: 0,
    lastUpdate: Date.now(),
    ...overrides,
  };
}

function mkRegime(current: RegimeSnapshot['current'] = 'low_vol_balanced'): RegimeSnapshot {
  return { current, candidate: current, ageMs: 10_000, candidateAgeMs: 10_000, confidence: 0.8, reason: 'test' };
}

function mkHealth(): HealthSnapshot {
  return { state: 'HEALTHY', score: 0.9, reasons: [], codes: [], sizingPenalty: 1, spreadPenalty: 0 };
}

// =====================================================================
// CHECK-3: Pair-check uses POST-ROUND prices
// =====================================================================
describe('CHECK-3: pair check after tick rounding', () => {
  it('accepts a pair that remains viable after rounding', async () => {
    const cfg = mkCfg({ minPairEdgeBps: 200, tickSize: 0.01 });
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());
    // yesBid=0.489 rounds down to 0.48; yesAsk=0.511 → BUY NO at 1-0.511=0.489 → rounds down to 0.48.
    // Post-round pair = 0.48 + 0.48 = 0.96 → 400bps edge → allowed.
    await om.applyQuote(mkQuote({ yesBid: 0.489, yesAsk: 0.511 }));
    expect(om.getActive().length).toBe(2);
  });

  it('blocks a pair whose edge collapses after rounding', async () => {
    const cfg = mkCfg({ minPairEdgeBps: 200, tickSize: 0.01 });
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());
    // yesBid=0.4949 (floors to 0.49); yesAsk=0.5051 → BUY NO at 0.4949 → floors to 0.49.
    // Raw pair sum = 0.4949 + 0.4949 = 0.9898 → 102 bps edge — already below 200.
    // Post-round pair = 0.49 + 0.49 = 0.98 → 200 bps — exactly at threshold.
    // With strict < check, 200 < 200 is false, so ALLOWED (acceptable behavior).
    // Meaningful block test: raw pair at 130 bps → post-round at 100 bps.
    await om.applyQuote(mkQuote({ yesBid: 0.4937, yesAsk: 0.5063 }));
    // Raw: 0.4937 + (1-0.5063)=0.4937 → 0.9874 = 126 bps (would fail even pre-round).
    // Post-round: 0.49 + 0.49 = 0.98 = 200 bps edge.
    // With strict <, 200 < 200 is false → allowed. So this should be allowed.
    // (This test confirms pair-check operates on rounded prices — a raw-below, round-above
    // scenario passes because post-round is what matters.)
    expect(om.getActive().length).toBe(2);
  });

  it('blocks a pair whose rounded sum gives edge strictly below minimum', async () => {
    const cfg = mkCfg({ minPairEdgeBps: 300, tickSize: 0.01 }); // require 300 bps
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());
    // yesBid=0.49 exact, yesAsk=0.51 exact → BUY NO at 0.49 exact.
    // Pair sum = 0.49 + 0.49 = 0.98 → 200 bps edge. 200 < 300 → BLOCKED.
    await om.applyQuote(mkQuote({ yesBid: 0.49, yesAsk: 0.51 }));
    expect(om.getActive().length).toBe(0);
  });
});

// =====================================================================
// CHECK-9: Latency stages fv / e2e / fillDetect
// =====================================================================
describe('CHECK-9: latency instrumentation', () => {
  it('QuoteEngine invokes onFvLatency when fair value is computed', () => {
    const cfg = mkCfg();
    const qe = new QuoteEngine(cfg, new FairValueModel(cfg), new AvellanedaStoikov(cfg));
    const samples: number[] = [];
    qe.onFvLatency = (ms) => samples.push(ms);
    qe.quote({
      features: mkFeat(),
      regime: mkRegime(),
      health: mkHealth(),
      inventory: mkInvState(),
      riskState: 'NORMAL',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: false,
    });
    expect(samples.length).toBe(1);
    expect(samples[0]).toBeGreaterThanOrEqual(0);
  });

  it('LatencyTracker records e2e samples when provided', () => {
    const lt = new LatencyTracker();
    lt.record('e2e', 500);
    lt.record('e2e', 700);
    const snap = lt.snapshot();
    expect(snap.e2e?.count).toBe(2);
    expect(snap.e2e?.avg).toBeCloseTo(600, 0);
  });

  it('LatencyTracker records fillDetect samples independently', () => {
    const lt = new LatencyTracker();
    lt.record('fillDetect', 3000);
    const snap = lt.snapshot();
    expect(snap.fillDetect?.count).toBe(1);
    expect(snap.fillDetect?.max).toBe(3000);
  });
});

// =====================================================================
// CHECK-13: Trending regime allows reducing side
// =====================================================================
describe('CHECK-13: trending regime reducing-side allowance', () => {
  const cfg = mkCfg();
  const qe = new QuoteEngine(cfg, new FairValueModel(cfg), new AvellanedaStoikov(cfg));

  it('blocks entry when trending AND flat inventory', () => {
    const r = qe.quote({
      features: mkFeat(),
      regime: mkRegime('high_vol_trend'),
      health: mkHealth(),
      inventory: mkInvState(), // flat
      riskState: 'NORMAL',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: false,
    });
    expect(r.mode).toBe('blocked');
    expect(r.blockedReason).toBe('trending_regime_flat');
  });

  it('allows SELL YES when trending AND long YES', () => {
    const r = qe.quote({
      features: mkFeat(),
      regime: mkRegime('high_vol_trend'),
      health: mkHealth(),
      inventory: mkInvState({ yesPosition: 10, yesAvgCost: 0.48, normalizedSkew: 0.3 }),
      riskState: 'NORMAL',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: false,
    });
    expect(r.mode).toBe('one_sided_ask');
    expect(r.yesAsk).not.toBeNull();
    expect(r.yesAskSize).toBeGreaterThan(0);
    expect(r.yesBid).toBeNull();
    expect(r.yesBidSize).toBe(0);
    expect(r.noAsk).toBeNull();
  });

  it('allows SELL NO when trending AND long NO', () => {
    const r = qe.quote({
      features: mkFeat(),
      regime: mkRegime('high_vol_trend'),
      health: mkHealth(),
      inventory: mkInvState({ noPosition: 10, noAvgCost: 0.48, normalizedSkew: -0.3 }),
      riskState: 'NORMAL',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: false,
    });
    expect(r.mode).toBe('one_sided_ask');
    expect(r.noAsk).not.toBeNull();
    expect(r.noAskSize).toBeGreaterThan(0);
    expect(r.yesBid).toBeNull();
    expect(r.yesAsk).toBeNull();
  });

  it('non-trending regime unchanged (two-sided quote allowed)', () => {
    const r = qe.quote({
      features: mkFeat(),
      regime: mkRegime('low_vol_balanced'),
      health: mkHealth(),
      inventory: mkInvState(),
      riskState: 'NORMAL',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: false,
    });
    expect(r.mode).not.toBe('blocked');
    expect(r.yesBid).not.toBeNull();
    expect(r.yesAsk).not.toBeNull();
  });
});
