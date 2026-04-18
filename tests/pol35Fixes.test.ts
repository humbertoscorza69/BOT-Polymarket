import { describe, it, expect } from 'vitest';
import { OrderManager } from '../src/execution/orderManager';
import { InventoryEngine } from '../src/execution/inventoryEngine';
import { PaperTrader } from '../src/core/paperTrader';
import { BotConfig } from '../src/config';
import { PolymarketMarket, QuoteResult } from '../src/types';
import { LatencyTracker } from '../src/core/latencyTracker';

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

describe('POL-35 VERIFY-3: future market filter', () => {
  it('refuses orders when windowStartTs is in the future', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    const futureMarket = mkMarket({
      windowStartTs: Math.floor(Date.now() / 1000) + 600, // 10 min in future
      endDateTs: Math.floor(Date.now() / 1000) + 900,
    });
    om.setMarket(futureMarket);
    await om.applyQuote(mkQuote());
    expect(om.getActive().length).toBe(0);
  });

  it('accepts orders when windowStartTs is in the past or absent', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    const activeMarket = mkMarket({
      windowStartTs: Math.floor(Date.now() / 1000) - 60, // started 1 min ago
    });
    om.setMarket(activeMarket);
    await om.applyQuote(mkQuote());
    expect(om.getActive().length).toBeGreaterThan(0);
  });
});

describe('POL-35-L: pair edge validation', () => {
  it('blocks paired BUY YES + BUY NO when sum >= 1 - minEdge', async () => {
    const cfg = mkCfg({ minPairEdgeBps: 200 }); // require 2c edge
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());

    // yesBid=0.53 + (sellYes converts to BUY NO at 1-0.54=0.46) = 0.99 sum → 1c edge, below min
    await om.applyQuote(
      mkQuote({
        yesBid: 0.53,
        yesAsk: 0.54, // will convert to BUY NO @ 0.46 since position=0
      }),
    );
    expect(om.getActive().length).toBe(0);
  });

  it('allows paired orders when edge >= minEdge', async () => {
    const cfg = mkCfg({ minPairEdgeBps: 200 });
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());

    // yesBid=0.48 + (BUY NO @ 0.48) = 0.96 sum → 4c edge
    await om.applyQuote(mkQuote({ yesBid: 0.48, yesAsk: 0.52 }));
    expect(om.getActive().length).toBe(2);
  });
});

describe('POL-35-K: tick-size rounding', () => {
  it('rounds BUY prices down to tick', async () => {
    const cfg = mkCfg({ tickSize: 0.01 });
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());

    await om.applyQuote(mkQuote({ yesBid: 0.4853, yesBidSize: 10, yesAsk: 0.52 }));
    const active = om.getActive();
    const buy = active.find((o) => o.side === 'BUY' && o.token === 'YES');
    expect(buy).toBeDefined();
    // 0.4853 floored to nearest 0.01 = 0.48
    expect(buy!.price).toBeCloseTo(0.48, 4);
  });
});

describe('POL-35 VERIFY-7: flatten', () => {
  it('emergency flatten places SELL at $0.01 bypassing post-only', async () => {
    const cfg = mkCfg({ tickSize: 0.01 });
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    // Build YES position to flatten
    inv.state.yesPosition = 5;
    inv.state.yesAvgCost = 0.48;
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());

    const placed = await om.flatten('emergency');
    expect(placed).toBe(1);
    const active = om.getActive();
    expect(active.length).toBe(1);
    expect(active[0].side).toBe('SELL');
    expect(active[0].price).toBeCloseTo(0.01, 2);
  });

  it('flatten does nothing when no inventory', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());
    const placed = await om.flatten('emergency');
    expect(placed).toBe(0);
  });
});

describe('POL-35-I: LatencyTracker', () => {
  it('records and averages observations', () => {
    const lt = new LatencyTracker();
    lt.record('orderPlace', 100);
    lt.record('orderPlace', 200);
    lt.record('orderPlace', 300);
    const snap = lt.snapshot();
    expect(snap.orderPlace.count).toBe(3);
    expect(snap.orderPlace.avg).toBeCloseTo(200, 1);
    expect(snap.orderPlace.max).toBe(300);
  });

  it('ignores non-finite and negative values', () => {
    const lt = new LatencyTracker();
    lt.record('orderPlace', NaN);
    lt.record('orderPlace', -1);
    lt.record('orderPlace', 100);
    const snap = lt.snapshot();
    expect(snap.orderPlace.count).toBe(1);
  });

  it('time() wrapper measures duration', async () => {
    const lt = new LatencyTracker();
    await lt.time('orderPlace', async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const snap = lt.snapshot();
    expect(snap.orderPlace.count).toBe(1);
    expect(snap.orderPlace.max).toBeGreaterThanOrEqual(15);
  });
});
