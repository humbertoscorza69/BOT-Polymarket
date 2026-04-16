import { describe, it, expect, vi } from 'vitest';
import { OrderManager } from '../src/execution/orderManager';
import { PaperTrader } from '../src/core/paperTrader';
import { BotConfig } from '../src/config';
import { PolymarketMarket, QuoteResult } from '../src/types';

function mkCfg(): BotConfig {
  return {
    mode: 'dry_run',
    runId: 'test-run',
    bankrollUsdc: 500,
    minOrderSizeUsdc: 5,
    maxOrderSizeUsdc: 50,
    defaultQuoteSizeUsdc: 15,
    orderMaxAgeMs: 15000,
    orderReplaceDriftBps: 18,
    orderPostOnly: true,
    paperFillProbBase: 0.5,
    paperPartialFillProb: 0.3,
    paperMakerFeeBps: 0,
    paperTakerFeeBps: 20,
    paperLatencyMs: 0,
    paperToxicityBaseline: 0.18,
    paperSlippageBps: 4,
  } as BotConfig;
}

function mkMarket(): PolymarketMarket {
  return {
    conditionId: 'c1',
    slug: 'test-mkt',
    question: 'Test?',
    yesTokenId: 'y1',
    noTokenId: 'n1',
    endDateTs: Math.floor(Date.now() / 1000) + 300,
    active: true,
    closed: false,
  };
}

function mkQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    yesBid: 0.48,
    yesAsk: 0.52,
    yesBidSize: 30,
    yesAskSize: 30,
    noBid: null,
    noAsk: null,
    noBidSize: 0,
    noAskSize: 0,
    mode: 'two_sided',
    blockedReason: null,
    inventorySkew: 0,
    internalFair: 0.5,
    cautionScore: 0.1,
    reservationPrice: 0.5,
    optimalSpread: 0.04,
    sizingMultiplier: 1,
    ...overrides,
  };
}

describe('OrderManager', () => {
  it('places two-sided orders on healthy quote', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper });
    om.setMarket(mkMarket());
    await om.applyQuote(mkQuote());
    const active = om.getActive();
    expect(active.length).toBeGreaterThanOrEqual(2);
  });

  it('cancels all on blocked quote', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper });
    om.setMarket(mkMarket());
    await om.applyQuote(mkQuote());
    expect(om.getActive().length).toBeGreaterThan(0);
    await om.applyQuote(mkQuote({ mode: 'blocked', blockedReason: 'test', yesBid: null, yesAsk: null, yesBidSize: 0, yesAskSize: 0 }));
    expect(om.getActive().length).toBe(0);
  });

  it('cancelAll returns count', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper });
    om.setMarket(mkMarket());
    await om.applyQuote(mkQuote());
    const n = await om.cancelAll('test');
    expect(n).toBeGreaterThan(0);
    expect(om.getActive().length).toBe(0);
  });
});
