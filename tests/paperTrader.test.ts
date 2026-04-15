import { describe, it, expect } from 'vitest';
import { PaperTrader } from '../src/core/paperTrader';
import { BotConfig } from '../src/config';
import { FeatureSnapshot, PolySnapshot, QuoteIntent } from '../src/types';

function mkCfg(): BotConfig {
  return {
    paperFillProbBase: 0.5,
    paperPartialFillProb: 0.3,
    paperMakerFeeBps: 0,
    paperTakerFeeBps: 20,
    paperLatencyMs: 10,
    paperToxicityBaseline: 0.18,
    paperSlippageBps: 4,
    orderMaxAgeMs: 15000,
  } as BotConfig;
}

describe('PaperTrader', () => {
  it('submits orders and exposes active list', () => {
    const p = new PaperTrader(mkCfg());
    const intent: QuoteIntent = {
      side: 'BUY',
      token: 'YES',
      price: 0.5,
      sizeUsdc: 10,
      tokenId: 'tok',
      postOnly: true,
      quoteId: 'q1',
      createdAt: Date.now(),
    };
    p.submit(intent);
    expect(p.activeOrders().length).toBe(1);
  });

  it('cancels orders', () => {
    const p = new PaperTrader(mkCfg());
    const intent: QuoteIntent = {
      side: 'BUY',
      token: 'YES',
      price: 0.5,
      sizeUsdc: 10,
      tokenId: 'tok',
      postOnly: true,
      quoteId: 'q2',
      createdAt: Date.now(),
    };
    p.submit(intent);
    const ok = p.cancel('q2');
    expect(ok).toBe(true);
    expect(p.activeOrders().length).toBe(0);
  });
});
