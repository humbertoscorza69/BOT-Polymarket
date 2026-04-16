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
});
