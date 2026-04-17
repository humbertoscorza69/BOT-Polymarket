import { describe, it, expect } from 'vitest';
import { InventoryEngine } from '../src/execution/inventoryEngine';
import { MetricsCalculator, DEFAULT_KILL_THRESHOLDS } from '../src/core/metricsCalculator';
import { BotConfig } from '../src/config';
import { Fill, InventoryState } from '../src/types';

function mkCfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    bankrollUsdc: 100,
    riskMaxInventoryUsdc: 50,
    inventoryMaxShares: 100,
    inventoryEmergencyThresholdPct: 80,
    ...overrides,
  } as BotConfig;
}

function mkFill(token: 'YES' | 'NO', side: 'BUY' | 'SELL', price: number, size: number, overrides: Partial<Fill> = {}): Fill {
  return {
    id: `fill-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    orderId: `o-${Math.random().toString(36).slice(2)}`,
    conditionId: 'c1',
    asset: 'BTC',
    interval: '5m',
    token,
    side,
    price,
    size,
    notional: price * size,
    feeUsdc: 0,
    regime: 'medium_vol',
    fairAtFill: price,
    midAtFill: price,
    isMaker: true,
    latencyMs: 0,
    mode: 'paper',
    runId: 'test',
    ...overrides,
  };
}

function mkInventoryState(overrides: Partial<InventoryState> = {}): InventoryState {
  return {
    freeUsdc: 100,
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

describe('POL-26 Bug 1: Per-side share cap in canAccumulate', () => {
  it('blocks BUY when share position would exceed inventoryMaxShares', () => {
    const inv = new InventoryEngine(mkCfg({ inventoryMaxShares: 100, riskMaxInventoryUsdc: 500 }));
    // Accumulate 90 YES shares at $0.03 each (only $2.70 notional — well under USDC cap)
    inv.applyFill(mkFill('YES', 'BUY', 0.03, 90));
    // Try to add 20 more shares — under USDC cap but over share cap
    expect(inv.canAccumulate('YES', 0.03 * 20, 20)).toBe(false);
  });

  it('allows BUY when under both USDC and share cap', () => {
    const inv = new InventoryEngine(mkCfg({ inventoryMaxShares: 100, riskMaxInventoryUsdc: 500 }));
    inv.applyFill(mkFill('YES', 'BUY', 0.03, 50));
    expect(inv.canAccumulate('YES', 0.03 * 10, 10)).toBe(true);
  });

  it('enforces share cap independently per side', () => {
    const inv = new InventoryEngine(mkCfg({ inventoryMaxShares: 100, riskMaxInventoryUsdc: 500 }));
    inv.applyFill(mkFill('YES', 'BUY', 0.03, 95));
    // YES side almost full, NO side empty
    expect(inv.canAccumulate('YES', 0.03 * 10, 10)).toBe(false);
    expect(inv.canAccumulate('NO', 0.03 * 10, 10)).toBe(true);
  });

  it('still enforces USDC cap even when share cap is fine', () => {
    const inv = new InventoryEngine(mkCfg({ inventoryMaxShares: 1000, riskMaxInventoryUsdc: 10 }));
    inv.applyFill(mkFill('YES', 'BUY', 0.5, 18)); // $9 notional, 18 shares
    // 4 more shares at $0.5 = $2 more notional, total $11 > $10 cap
    expect(inv.canAccumulate('YES', 2, 4)).toBe(false);
  });

  it('backward-compatible: works without sizeShares param', () => {
    const inv = new InventoryEngine(mkCfg({ inventoryMaxShares: 1000, riskMaxInventoryUsdc: 10 }));
    inv.applyFill(mkFill('YES', 'BUY', 0.5, 18));
    // No sizeShares param — defaults to 0, so only USDC cap applies
    expect(inv.canAccumulate('YES', 0.5)).toBe(true);
    expect(inv.canAccumulate('YES', 2)).toBe(false);
  });
});

describe('POL-26 Bug 2: Fill rate metric uses orders placed', () => {
  it('computes fillRate as uniqueOrdersFilled / ordersPlaced', () => {
    const mc = new MetricsCalculator();
    // Place 10 orders
    for (let i = 0; i < 10; i++) mc.recordOrderPlaced();
    // 3 unique orders got fills
    mc.recordFill(mkFill('YES', 'BUY', 0.5, 10, { orderId: 'o1' }));
    mc.recordFill(mkFill('YES', 'BUY', 0.5, 5, { orderId: 'o1' })); // second fill on same order
    mc.recordFill(mkFill('NO', 'BUY', 0.5, 10, { orderId: 'o2' }));
    mc.recordFill(mkFill('YES', 'SELL', 0.6, 5, { orderId: 'o3' }));

    const metrics = mc.calculateMetrics(100, mkInventoryState(), 1000, 0, 0, 100);
    // 3 unique orders filled out of 10 placed = 0.3
    expect(metrics.fillQualityMetrics.fillRate).toBeCloseTo(0.3);
    expect(metrics.fillQualityMetrics.orderCount).toBe(10);
    expect(metrics.fillQualityMetrics.fillCount).toBe(4);
  });

  it('returns 0 fill rate when no orders placed', () => {
    const mc = new MetricsCalculator();
    const metrics = mc.calculateMetrics(100, mkInventoryState(), 1000, 0, 0, 100);
    expect(metrics.fillQualityMetrics.fillRate).toBe(0);
  });
});

// Permissive thresholds: disable all warmup-gated checks so we can isolate inventory kill
const permissiveThresholds = {
  ...DEFAULT_KILL_THRESHOLDS,
  spreadBpsMin: 0,
  adverseSelectionBpsMax: 999999,
  fillRateMin: 0,
  fillRateMax: 999999,
  takerExecutionRateMax: 1,
  staleNoQuoteRateMax: 1,
  pnlNetMinUsdc: -999999,
};

describe('POL-26 Bug 3: Inventory breach kill check', () => {
  it('triggers kill when inventory utilization >= inventoryMismatchPctMax', () => {
    const mc = new MetricsCalculator();
    mc.recordCycleComplete();
    mc.recordCycleComplete();

    const inventory = mkInventoryState({ yesPosition: 100, noPosition: 0 });
    const thresholds = { ...permissiveThresholds, inventoryMismatchPctMax: 100 };
    const metrics = mc.calculateMetrics(100, inventory, 100, 0, 0, 100, thresholds);
    expect(metrics.killThresholdBreached).toMatch(/Inventory utilization/);
  });

  it('does not trigger kill when under threshold', () => {
    const mc = new MetricsCalculator();
    mc.recordCycleComplete();
    mc.recordCycleComplete();

    const inventory = mkInventoryState({ yesPosition: 50, noPosition: 0 });
    const thresholds = { ...permissiveThresholds, inventoryMismatchPctMax: 100 };
    const metrics = mc.calculateMetrics(100, inventory, 100, 0, 0, 100, thresholds);
    expect(metrics.killThresholdBreached).toBeNull();
  });

  it('checks both sides for inventory breach', () => {
    const mc = new MetricsCalculator();
    mc.recordCycleComplete();
    mc.recordCycleComplete();

    const inventory = mkInventoryState({ yesPosition: 10, noPosition: 100 });
    const thresholds = { ...permissiveThresholds, inventoryMismatchPctMax: 100 };
    const metrics = mc.calculateMetrics(100, inventory, 100, 0, 0, 100, thresholds);
    expect(metrics.killThresholdBreached).toMatch(/Inventory utilization/);
  });
});

describe('POL-26 Bug 4: inventoryMismatchPctMax field is wired up', () => {
  it('mismatchPct returns actual utilization, not hardcoded 0', () => {
    const mc = new MetricsCalculator();
    const inventory = mkInventoryState({ yesPosition: 75, noPosition: 25 });
    const metrics = mc.calculateMetrics(100, inventory, 100, 0, 0, 100);
    // max(75, 25) / 100 * 100 = 75%
    expect(metrics.inventoryMetrics.mismatchPct).toBe(75);
  });

  it('mismatchPct is 0 when no positions', () => {
    const mc = new MetricsCalculator();
    const metrics = mc.calculateMetrics(100, mkInventoryState(), 100, 0, 0, 100);
    expect(metrics.inventoryMetrics.mismatchPct).toBe(0);
  });
});
