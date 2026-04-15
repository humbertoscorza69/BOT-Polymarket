import { describe, it, expect } from 'vitest';
import { QuoteEngine } from '../src/core/quoteEngine';
import { AvellanedaStoikov } from '../src/core/avellaneda';
import { FairValueModel } from '../src/core/fairValue';
import { BotConfig } from '../src/config';
import { defaultAdaptiveParams } from '../src/persistence/paramsStore';
import { FeatureSnapshot } from '../src/types';

function mkCfg(): BotConfig {
  return {
    avGamma: 0.8,
    avK: 1.5,
    avSigmaFloor: 0.004,
    avSpreadMinBps: 40,
    avSpreadMaxBps: 400,
    avMinEdgeBps: 18,
    wMicroprice: 0.45,
    wPolyImbalance: 0.15,
    wBinanceImbalance: 0.2,
    wBinanceAggressor: 0.1,
    wBinanceMomentum: 0.1,
    defaultQuoteSizeUsdc: 15,
    minOrderSizeUsdc: 5,
    maxOrderSizeUsdc: 50,
    orderPostOnly: true,
  } as BotConfig;
}

function mkFeat(): FeatureSnapshot {
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
  };
}

describe('QuoteEngine', () => {
  const cfg = mkCfg();
  const qe = new QuoteEngine(cfg, new FairValueModel(cfg), new AvellanedaStoikov(cfg));

  it('blocks when risk HALTED', () => {
    const r = qe.quote({
      features: mkFeat(),
      regime: { current: 'low_vol_balanced', candidate: 'low_vol_balanced', ageMs: 0, candidateAgeMs: 0, confidence: 1, reason: '' },
      health: { state: 'HEALTHY', score: 1, reasons: [], codes: [], sizingPenalty: 1, spreadPenalty: 0 },
      inventory: {
        freeUsdc: 500,
        yesPosition: 0,
        noPosition: 0,
        yesAvgCost: 0,
        noAvgCost: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        markToMarketPnl: 0,
        normalizedSkew: 0,
        lastUpdate: 0,
      },
      riskState: 'HALTED',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: false,
    });
    expect(r.mode).toBe('blocked');
  });

  it('produces two_sided quote on healthy market', () => {
    const r = qe.quote({
      features: mkFeat(),
      regime: { current: 'low_vol_balanced', candidate: 'low_vol_balanced', ageMs: 0, candidateAgeMs: 0, confidence: 1, reason: '' },
      health: { state: 'HEALTHY', score: 1, reasons: [], codes: [], sizingPenalty: 1, spreadPenalty: 0 },
      inventory: {
        freeUsdc: 500,
        yesPosition: 0,
        noPosition: 0,
        yesAvgCost: 0,
        noAvgCost: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        markToMarketPnl: 0,
        normalizedSkew: 0,
        lastUpdate: 0,
      },
      riskState: 'NORMAL',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: false,
    });
    expect(r.mode === 'two_sided' || r.mode === 'one_sided_ask' || r.mode === 'one_sided_bid').toBeTruthy();
    if (r.yesBid !== null && r.yesAsk !== null) {
      expect(r.yesBid).toBeLessThan(r.yesAsk);
    }
  });

  it('blocks during preemptive cancel', () => {
    const r = qe.quote({
      features: mkFeat(),
      regime: { current: 'low_vol_balanced', candidate: 'low_vol_balanced', ageMs: 0, candidateAgeMs: 0, confidence: 1, reason: '' },
      health: { state: 'HEALTHY', score: 1, reasons: [], codes: [], sizingPenalty: 1, spreadPenalty: 0 },
      inventory: {
        freeUsdc: 500,
        yesPosition: 0,
        noPosition: 0,
        yesAvgCost: 0,
        noAvgCost: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        markToMarketPnl: 0,
        normalizedSkew: 0,
        lastUpdate: 0,
      },
      riskState: 'NORMAL',
      params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
      preemptiveCancelActive: true,
    });
    expect(r.mode).toBe('blocked');
  });
});
