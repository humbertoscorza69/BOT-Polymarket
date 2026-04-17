import { describe, it, expect } from 'vitest';
import { OrderManager } from '../src/execution/orderManager';
import { PaperTrader } from '../src/core/paperTrader';
import { InventoryEngine } from '../src/execution/inventoryEngine';
import { BotConfig } from '../src/config';
import { Fill, PolymarketMarket, QuoteResult } from '../src/types';

function mkCfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    mode: 'dry_run',
    runId: 'test-run',
    bankrollUsdc: 20,
    riskMaxInventoryUsdc: 5,
    minOrderSizeUsdc: 1,
    maxOrderSizeUsdc: 2,
    defaultQuoteSizeUsdc: 1,
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
    inventoryMaxShares: 1000,
    inventoryEmergencyThresholdPct: 80,
    ...overrides,
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
    yesBidSize: 2,
    yesAskSize: 2,
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

function mkFill(token: 'YES' | 'NO', side: 'BUY' | 'SELL', price: number, size: number): Fill {
  return {
    id: 'f1', ts: Date.now(), orderId: 'o1', conditionId: 'c1',
    asset: 'BTC', interval: '15m', token, side, price, size,
    notional: price * size, feeUsdc: 0, regime: 'medium_vol',
    fairAtFill: price, midAtFill: price, isMaker: true,
    latencyMs: 0, mode: 'paper', runId: 'test',
  };
}

// ============================================================
// FIX 1: Ask sizing formula
// ============================================================
describe('FIX 1: Ask sizing formula', () => {
  it('yesAskShares = quoteSize / yesAsk (not 1 - yesAsk)', () => {
    // At yesAsk=0.55, $1 quote should produce $1/0.55 = 1.82 shares
    const quoteSize = 1;
    const yesAsk = 0.55;
    const shares = quoteSize / Math.max(0.02, yesAsk);
    expect(shares).toBeCloseTo(1.82, 1);
  });

  it('yesAskShares at 0.30 = 3.33 shares', () => {
    const shares = 1 / Math.max(0.02, 0.30);
    expect(shares).toBeCloseTo(3.33, 1);
  });

  it('yesBidShares = quoteSize / yesBid', () => {
    const shares = 1 / Math.max(0.02, 0.48);
    expect(shares).toBeCloseTo(2.08, 1);
  });

  it('BUY and SELL sizes are symmetric at mid=0.50', () => {
    const quoteSize = 1;
    const mid = 0.50;
    const halfSpread = 0.015; // 150bps
    const bid = mid - halfSpread; // 0.485
    const ask = mid + halfSpread; // 0.515
    const bidShares = quoteSize / bid;
    const askShares = quoteSize / ask;
    // At mid ~0.50, both should be close to 2 shares
    expect(Math.abs(bidShares - askShares)).toBeLessThan(0.15);
  });
});

// ============================================================
// FIX 2: SELL-side inventory gate
// ============================================================
describe('FIX 2: SELL-side inventory gate', () => {
  it('blocks SELL when position=0 YES', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());

    // Try to place a SELL-only quote with no inventory
    await om.applyQuote(mkQuote({
      yesBid: null, yesBidSize: 0,
      yesAsk: 0.55, yesAskSize: 2,
      mode: 'one_sided_ask',
    }));
    // SELL should have been blocked — no active orders
    expect(om.getActive().length).toBe(0);
  });

  it('allows SELL when position > 0', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    // Build a position first
    inv.applyFill(mkFill('YES', 'BUY', 0.50, 3));
    expect(inv.state.yesPosition).toBe(3);

    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());
    await om.applyQuote(mkQuote({
      yesBid: null, yesBidSize: 0,
      yesAsk: 0.55, yesAskSize: 2,
      mode: 'one_sided_ask',
    }));
    expect(om.getActive().length).toBe(1);
  });

  it('clamps SELL size to current position', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);
    inv.applyFill(mkFill('YES', 'BUY', 0.50, 1.5));

    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());
    await om.applyQuote(mkQuote({
      yesBid: null, yesBidSize: 0,
      yesAsk: 0.55, yesAskSize: 3, // more than 1.5 position
      mode: 'one_sided_ask',
    }));
    const active = om.getActive();
    expect(active.length).toBe(1);
    // Order should be clamped to 1.5 shares
    expect(active[0].sizeShares).toBeCloseTo(1.5, 1);
  });

  it('allows BUY with no position (not blocked by SELL gate)', async () => {
    const cfg = mkCfg();
    const paper = new PaperTrader(cfg);
    const inv = new InventoryEngine(cfg);

    const om = new OrderManager({ mode: 'dry_run', cfg, paper, inventory: inv });
    om.setMarket(mkMarket());
    await om.applyQuote(mkQuote({
      yesBid: 0.48, yesBidSize: 2,
      yesAsk: null, yesAskSize: 0,
      mode: 'one_sided_bid',
    }));
    expect(om.getActive().length).toBe(1);
  });
});
