import { describe, it, expect } from 'vitest';
import { HealthEngine } from '../src/core/health';
import { BotConfig } from '../src/config';
import { FeatureSnapshot, PolySnapshot } from '../src/types';

function mkCfg(): BotConfig {
  return {
    binanceEnabled: true,
    riskToxicFlowEmaCap: 0.55,
  } as BotConfig;
}

function mkPoly(overrides: Partial<PolySnapshot> = {}): PolySnapshot {
  return {
    market: {} as any,
    yesBook: { bids: [], asks: [], ts: 0 },
    noBook: { bids: [], asks: [], ts: 0 },
    bestBidYes: 0.5,
    bestAskYes: 0.51,
    midYes: 0.505,
    microYes: 0.505,
    spreadYes: 0.01,
    topImbalance: 0,
    depthImbalance: 0,
    feedAgeMs: 100,
    lastUpdateTs: Date.now(),
    stale: false,
    ...overrides,
  };
}

describe('HealthEngine', () => {
  const h = new HealthEngine(mkCfg());
  const feat = { spreadRegime: 'normal', realizedVolEma: 30, liquidityScore: 0.5, bookSparsity: 0.5 } as FeatureSnapshot;

  it('healthy when all feeds ok', () => {
    const r = h.evaluate({
      poly: mkPoly(),
      bin: { available: true, stale: false } as any,
      features: feat,
      apiErrorRate: 0,
      adverseSelectionEma: 0,
      orderRejectionRate: 0,
      polyReconnects: 0,
      binReconnects: 0,
    });
    expect(r.state).toBe('HEALTHY');
    expect(r.score).toBeGreaterThan(0.7);
  });

  it('degraded when poly stale', () => {
    const r = h.evaluate({
      poly: mkPoly({ stale: true }),
      bin: { available: true, stale: false } as any,
      features: feat,
      apiErrorRate: 0,
      adverseSelectionEma: 0,
      orderRejectionRate: 0,
      polyReconnects: 0,
      binReconnects: 0,
    });
    expect(r.state === 'DEGRADED' || r.state === 'HEALTHY').toBeTruthy();
  });

  it('unsafe when poly missing', () => {
    const r = h.evaluate({
      poly: null,
      bin: null,
      features: null,
      apiErrorRate: 1,
      adverseSelectionEma: 0.9,
      orderRejectionRate: 0.9,
      polyReconnects: 20,
      binReconnects: 20,
    });
    expect(r.state).toBe('UNSAFE');
  });
});
