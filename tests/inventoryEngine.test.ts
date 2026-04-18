import { describe, it, expect } from 'vitest';
import { InventoryEngine } from '../src/execution/inventoryEngine';
import { Fill } from '../src/types';

function mkFill(token: 'YES' | 'NO', side: 'BUY' | 'SELL', price: number, size: number): Fill {
  return {
    id: 'f1',
    ts: Date.now(),
    orderId: 'o1',
    conditionId: 'c1',
    asset: 'BTC',
    interval: '5m',
    token,
    side,
    price,
    size,
    notional: price * size,
    feeUsdc: 0,
    regime: 'low_vol_balanced',
    fairAtFill: 0.5,
    midAtFill: 0.5,
    isMaker: true,
    latencyMs: 10,
    mode: 'paper',
    runId: 'test',
  };
}

describe('InventoryEngine', () => {
  it('tracks buy YES correctly', () => {
    const inv = new InventoryEngine({ bankrollUsdc: 500, riskMaxInventoryUsdc: 200 } as any);
    inv.applyFill(mkFill('YES', 'BUY', 0.50, 100));
    const s = inv.state;
    expect(s.yesPosition).toBe(100);
    expect(s.yesAvgCost).toBeCloseTo(0.50, 4);
    expect(s.freeUsdc).toBeCloseTo(500 - 50, 2);
  });

  it('tracks sell YES and realizes PnL', () => {
    const inv = new InventoryEngine({ bankrollUsdc: 500, riskMaxInventoryUsdc: 200 } as any);
    inv.applyFill(mkFill('YES', 'BUY', 0.40, 100));
    const realized = inv.applyFill(mkFill('YES', 'SELL', 0.60, 100));
    expect(inv.state.yesPosition).toBe(0);
    expect(realized).toBeCloseTo(20, 2);
    expect(inv.state.realizedPnl).toBeCloseTo(20, 2);
  });

  it('tracks buy NO correctly', () => {
    const inv = new InventoryEngine({ bankrollUsdc: 500, riskMaxInventoryUsdc: 200 } as any);
    inv.applyFill(mkFill('NO', 'BUY', 0.40, 50));
    expect(inv.state.noPosition).toBe(50);
    expect(inv.state.noAvgCost).toBeCloseTo(0.40, 4);
  });

  it('computes normalized skew', () => {
    const inv = new InventoryEngine({ bankrollUsdc: 500, riskMaxInventoryUsdc: 200 } as any);
    inv.applyFill(mkFill('YES', 'BUY', 0.50, 400));
    inv.markToMarket(0.50);
    const skew = inv.state.normalizedSkew;
    expect(skew).toBeGreaterThan(0);
  });

  it('markToMarket computes unrealized PnL', () => {
    const inv = new InventoryEngine({ bankrollUsdc: 500, riskMaxInventoryUsdc: 200 } as any);
    inv.applyFill(mkFill('YES', 'BUY', 0.40, 100));
    inv.markToMarket(0.60);
    expect(inv.state.unrealizedPnl).toBeCloseTo(20, 2);
  });

  it('forceBalance updates freeUsdc', () => {
    const inv = new InventoryEngine({ bankrollUsdc: 500, riskMaxInventoryUsdc: 200 } as any);
    inv.forceBalance(750);
    expect(inv.state.freeUsdc).toBe(750);
  });

  describe('canAccumulate — combined market exposure cap', () => {
    const mkEngine = (perSide = 15, combined = 15) =>
      new InventoryEngine({
        bankrollUsdc: 90,
        riskMaxInventoryUsdc: perSide,
        riskMaxMarketExposureUsdc: combined,
        inventoryMaxShares: 1000,
        inventoryEmergencyThresholdPct: 80,
      } as any);

    it('allows first BUY YES under cap', () => {
      const inv = mkEngine();
      expect(inv.canAccumulate('YES', 5, 10)).toBe(true);
    });

    it('allows first BUY NO under cap', () => {
      const inv = mkEngine();
      expect(inv.canAccumulate('NO', 5, 10)).toBe(true);
    });

    it('blocks YES when per-side cap exceeded', () => {
      const inv = mkEngine();
      inv.applyFill(mkFill('YES', 'BUY', 0.50, 28)); // 14 USDC notional
      expect(inv.canAccumulate('YES', 2, 4)).toBe(false); // 14 + 2 = 16 > 15
    });

    it('blocks NO via combined cap even when per-side is fine', () => {
      const inv = mkEngine();
      // Build up 12 USDC on YES side
      inv.applyFill(mkFill('YES', 'BUY', 0.50, 24)); // 12 USDC
      // NO side is 0 — per-side NO cap is fine, but combined = 12 + 5 = 17 > 15
      expect(inv.canAccumulate('NO', 5, 10)).toBe(false);
    });

    it('blocks YES via combined cap even when per-side is fine', () => {
      const inv = mkEngine();
      // Build up 12 USDC on NO side
      inv.applyFill(mkFill('NO', 'BUY', 0.40, 30)); // 12 USDC
      // YES side is 0 — per-side YES cap is fine, but combined = 12 + 5 = 17 > 15
      expect(inv.canAccumulate('YES', 5, 10)).toBe(false);
    });

    it('allows when combined exactly at cap', () => {
      const inv = mkEngine();
      inv.applyFill(mkFill('YES', 'BUY', 0.50, 20)); // 10 USDC
      // 10 + 5 = 15 == cap, not exceeded
      expect(inv.canAccumulate('NO', 5, 10)).toBe(true);
    });

    it('blocks when combined just over cap', () => {
      const inv = mkEngine();
      inv.applyFill(mkFill('YES', 'BUY', 0.50, 20)); // 10 USDC
      // 10 + 5.01 = 15.01 > 15
      expect(inv.canAccumulate('NO', 5.01, 10)).toBe(false);
    });

    it('dual-side accumulation blocked at $15 total (POL-48 scenario)', () => {
      const inv = mkEngine();
      // Simulate the "buy and hold" pattern: BUY YES then SELL YES → BUY NO
      inv.applyFill(mkFill('YES', 'BUY', 0.50, 20)); // 10 USDC YES
      inv.applyFill(mkFill('NO', 'BUY', 0.40, 10));  // 4 USDC NO
      // Combined = 10 + 4 = 14. Can add 1 more USDC
      expect(inv.canAccumulate('YES', 1, 2)).toBe(true);
      // But can't add 2 more
      expect(inv.canAccumulate('YES', 2, 4)).toBe(false); // 14 + 2 = 16 > 15
      expect(inv.canAccumulate('NO', 2, 5)).toBe(false);  // 14 + 2 = 16 > 15
    });
  });
});
