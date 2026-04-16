import { describe, it, expect } from 'vitest';
import { FairValueModel } from '../src/core/fairValue';
import { FeatureSnapshot } from '../src/types';
import { BotConfig } from '../src/config';

function mkCfg(): BotConfig {
  return {
    wMicroprice: 0.45,
    wPolyImbalance: 0.15,
    wBinanceImbalance: 0.2,
    wBinanceAggressor: 0.1,
    wBinanceMomentum: 0.1,
  } as BotConfig;
}

function mkFeat(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    ts: Date.now(),
    asset: 'BTC',
    interval: '5m',
    conditionId: 'x',
    midYes: 0.5,
    microYes: 0.5,
    bestBidYes: 0.495,
    bestAskYes: 0.505,
    spreadYes: 0.01,
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
    timeToExpirySec: 600,
    timeToExpiryFactor: 1,
    staleFactor: 0,
    spreadRegime: 'normal',
    liquidityScore: 0.6,
    bookSparsity: 0.4,
    emaFair: 0.5,
    zMove: 0,
    realizedVolEma: 20,
    quoteChurnRate: 0,
    depthAsymmetry: 0,
    liquidityResilience: 1,
    momentumPersistence: 0.3,
    entropyScore: 0.7,
    toxicFlowProxy: 0.1,
    microTrendSlope: 0,
    shortReversionScore: 0,
    participationScore: 0.5,
    fillOpportunityScore: 0.5,
    ...overrides,
  };
}

describe('FairValueModel', () => {
  const cfg = mkCfg();
  const model = new FairValueModel(cfg);

  it('returns mid-based value for balanced inputs', () => {
    const f = mkFeat({ midYes: 0.55, microYes: 0.55 });
    const v = model.compute(f);
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(0.7);
  });

  it('handles missing binance gracefully', () => {
    const f = mkFeat({
      binanceBookImbalance: 0,
      binanceAggressorRatio: 0,
      binancePriceVelocityBps: 0,
    });
    const v = model.compute(f);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it('shrinks toward mid when stale', () => {
    const f1 = mkFeat({ midYes: 0.5, microYes: 0.55, staleFactor: 0 });
    const f2 = mkFeat({ midYes: 0.5, microYes: 0.55, staleFactor: 1 });
    const v1 = model.compute(f1);
    const v2 = model.compute(f2);
    expect(Math.abs(v2 - 0.5)).toBeLessThanOrEqual(Math.abs(v1 - 0.5));
  });

  it('clamps output to valid probability', () => {
    const f = mkFeat({ midYes: 0.99, microYes: 0.99, bestBidYes: 0.98, bestAskYes: 0.995 });
    const v = model.compute(f);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
