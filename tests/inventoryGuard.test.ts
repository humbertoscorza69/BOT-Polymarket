import { describe, it, expect } from 'vitest';
import { InventoryEngine } from '../src/execution/inventoryEngine';
import { BotConfig } from '../src/config';
import { Fill } from '../src/types';

function mkCfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    bankrollUsdc: 90,
    riskMaxInventoryUsdc: 10,
    inventoryMaxShares: 1000,
    inventoryEmergencyThresholdPct: 80,
    ...overrides,
  } as BotConfig;
}

function mkFill(token: 'YES' | 'NO', side: 'BUY' | 'SELL', price: number, size: number): Fill {
  return {
    id: 'f1',
    ts: Date.now(),
    orderId: 'o1',
    conditionId: 'c1',
    asset: 'BTC',
    interval: '15m',
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
  };
}

describe('B1: canAccumulate gate', () => {
  it('blocks BUY when at cap', () => {
    const inv = new InventoryEngine(mkCfg({ riskMaxInventoryUsdc: 10 }));
    // Accumulate $9 of YES
    inv.applyFill(mkFill('YES', 'BUY', 0.5, 18)); // 18 shares * 0.5 = $9 notional
    // Try to add $2 more YES — should be blocked
    expect(inv.canAccumulate('YES', 2)).toBe(false);
  });

  it('allows BUY when under cap', () => {
    const inv = new InventoryEngine(mkCfg({ riskMaxInventoryUsdc: 10 }));
    inv.applyFill(mkFill('YES', 'BUY', 0.5, 18)); // $9
    // $0.50 more should fit
    expect(inv.canAccumulate('YES', 0.5)).toBe(true);
  });

  it('allows reducing exposure (NO buy when long YES)', () => {
    const inv = new InventoryEngine(mkCfg({ riskMaxInventoryUsdc: 10 }));
    inv.applyFill(mkFill('YES', 'BUY', 0.5, 18)); // $9 YES
    // Buying NO is accumulating on NO side, which is at $0
    expect(inv.canAccumulate('NO', 2)).toBe(true);
  });
});

describe('B2: inventory reset on rotation', () => {
  it('resets positions to zero', () => {
    const inv = new InventoryEngine(mkCfg());
    inv.applyFill(mkFill('YES', 'BUY', 0.5, 40)); // $20 YES position
    expect(inv.state.yesPosition).toBe(40);

    const { residualUsdc } = inv.reset();
    expect(inv.state.yesPosition).toBe(0);
    expect(inv.state.noPosition).toBe(0);
    expect(inv.state.normalizedSkew).toBe(0);
    expect(residualUsdc).toBeGreaterThan(0); // was long YES
  });

  it('reports zero residual when flat', () => {
    const inv = new InventoryEngine(mkCfg());
    const { residualUsdc } = inv.reset();
    expect(residualUsdc).toBe(0);
  });
});
