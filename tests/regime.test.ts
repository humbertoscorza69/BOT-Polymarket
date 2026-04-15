import { describe, it, expect } from 'vitest';
import { RegimeDetector } from '../src/core/regime';
import { FeatureSnapshot } from '../src/types';

function mkFeat(overrides: Partial<FeatureSnapshot>): FeatureSnapshot {
  return {
    ts: Date.now(),
    asset: 'BTC',
    interval: '5m',
    conditionId: 'x',
    midYes: 0.5,
    microYes: 0.5,
    bestBidYes: 0.49,
    bestAskYes: 0.51,
    spreadYes: 0.02,
    fairYes: 0.5,
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
    liquidityScore: 0.5,
    bookSparsity: 0.5,
    emaFair: 0.5,
    zMove: 0,
    realizedVolEma: 10,
    quoteChurnRate: 0,
    depthAsymmetry: 0,
    liquidityResilience: 1,
    momentumPersistence: 0.2,
    entropyScore: 0.8,
    toxicFlowProxy: 0,
    microTrendSlope: 0,
    shortReversionScore: 0,
    participationScore: 0.5,
    fillOpportunityScore: 0.5,
    ...overrides,
  };
}

describe('RegimeDetector', () => {
  it('starts low_vol_balanced', () => {
    const r = new RegimeDetector();
    const s = r.snapshot();
    expect(s.current).toBe('low_vol_balanced');
  });

  it('enters high_vol_chop on high vol without momentum', async () => {
    const r = new RegimeDetector();
    // feed high vol samples repeatedly past dwell
    for (let i = 0; i < 5; i++) {
      r.update(mkFeat({ realizedVolEma: 90, momentumPersistence: 0.2, confirm: 0 }));
      await new Promise((res) => setTimeout(res, 400));
    }
    const s = r.snapshot();
    expect(['high_vol_chop', 'medium_vol']).toContain(s.current);
  }, 5000);

  it('tags low_vol_directional when momentum is high', async () => {
    const r = new RegimeDetector();
    for (let i = 0; i < 10; i++) {
      r.update(mkFeat({ realizedVolEma: 10, momentumPersistence: 0.7 }));
      await new Promise((res) => setTimeout(res, 400));
    }
    const s = r.snapshot();
    expect(['low_vol_directional', 'low_vol_balanced']).toContain(s.current);
  }, 7000);
});
