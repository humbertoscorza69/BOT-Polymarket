import { describe, it, expect } from 'vitest';
import { RiskManager } from '../src/core/riskManager';
import { BotConfig } from '../src/config';

function mkCfg(): BotConfig {
  return {
    riskSessionLossCapUsdc: 100,
    riskDrawdownCapUsdc: 60,
    riskConsecutiveLossCap: 6,
    riskApiErrorCap: 25,
    riskToxicFlowEmaCap: 0.55,
  } as BotConfig;
}

const emptyInv = {
  freeUsdc: 100,
  yesPosition: 0,
  noPosition: 0,
  yesAvgCost: 0,
  noAvgCost: 0,
  realizedPnl: 0,
  unrealizedPnl: 0,
  markToMarketPnl: 0,
  normalizedSkew: 0,
  lastUpdate: 0,
};

describe('RiskManager', () => {
  it('defaults to NORMAL', () => {
    const r = new RiskManager(mkCfg());
    const s = r.evaluate({
      sessionPnl: 0,
      peakPnl: 0,
      consecutiveLosses: 0,
      adverseSelectionEma: 0,
      apiErrors: 0,
      feedStale: false,
      orderRejections: 0,
      reconcileDrift: false,
      inventory: emptyInv,
      totalFills: 0,
    });
    expect(s).toBe('NORMAL');
  });

  it('enters EMERGENCY on session loss cap', () => {
    const r = new RiskManager(mkCfg());
    const s = r.evaluate({
      sessionPnl: -200,
      peakPnl: 0,
      consecutiveLosses: 1,
      adverseSelectionEma: 0,
      apiErrors: 0,
      feedStale: false,
      orderRejections: 0,
      reconcileDrift: false,
      inventory: emptyInv,
      totalFills: 0,
    });
    expect(s).toBe('EMERGENCY');
  });

  it('HALTED on toxic flow', () => {
    const r = new RiskManager(mkCfg());
    const s = r.evaluate({
      sessionPnl: 0,
      peakPnl: 0,
      consecutiveLosses: 0,
      adverseSelectionEma: 0.9,
      apiErrors: 0,
      feedStale: false,
      orderRejections: 0,
      reconcileDrift: false,
      inventory: emptyInv,
      totalFills: 3,
    });
    expect(s).toBe('HALTED');
  });
});
