import { describe, it, expect } from 'vitest';
import { PnlTracker } from '../src/core/pnl';
import { Fill } from '../src/types';

function mkFill(price: number, size: number, feeUsdc = 0, regime: Fill['regime'] = 'low_vol_balanced'): Fill {
  return {
    id: 'f1',
    ts: Date.now(),
    orderId: 'o1',
    conditionId: 'c1',
    asset: 'BTC',
    interval: '5m',
    token: 'YES',
    side: 'BUY',
    price,
    size,
    notional: price * size,
    feeUsdc,
    regime,
    fairAtFill: 0.5,
    midAtFill: 0.5,
    isMaker: true,
    latencyMs: 10,
    mode: 'paper',
    runId: 'test',
  };
}

describe('PnlTracker', () => {
  it('tracks winning fills', () => {
    const p = new PnlTracker();
    p.recordFillRealized(mkFill(0.5, 10), 5);
    const s = p.state();
    expect(s.realized).toBe(5);
    expect(s.wins).toBe(1);
    expect(s.consecutiveLosses).toBe(0);
  });

  it('tracks losing fills and consecutive losses', () => {
    const p = new PnlTracker();
    p.recordFillRealized(mkFill(0.5, 10), -3);
    p.recordFillRealized(mkFill(0.5, 10), -2);
    const s = p.state();
    expect(s.losses).toBe(2);
    expect(s.consecutiveLosses).toBe(2);
    expect(s.realized).toBe(-5);
  });

  it('resets consecutive losses on a win', () => {
    const p = new PnlTracker();
    p.recordFillRealized(mkFill(0.5, 10), -1);
    p.recordFillRealized(mkFill(0.5, 10), 3);
    expect(p.state().consecutiveLosses).toBe(0);
  });

  it('computes gross and net correctly with fees', () => {
    const p = new PnlTracker();
    p.recordFillRealized(mkFill(0.5, 10, 0.5), 5);
    const s = p.state();
    expect(s.fees).toBe(0.5);
    expect(s.gross).toBe(5);
    expect(s.net).toBeCloseTo(4.5, 4);
  });

  it('tracks per-regime breakdown', () => {
    const p = new PnlTracker();
    p.recordFillRealized(mkFill(0.5, 10, 0, 'medium_vol'), 2);
    p.recordFillRealized(mkFill(0.5, 10, 0, 'medium_vol'), -1);
    const r = p.state().perRegime['medium_vol'];
    expect(r.fills).toBe(2);
    expect(r.pnl).toBe(1);
    expect(r.wins).toBe(1);
  });

  it('computes drawdown', () => {
    const p = new PnlTracker();
    p.recordFillRealized(mkFill(0.5, 10), 10);
    p.recordFillRealized(mkFill(0.5, 10), -3);
    const s = p.state();
    expect(s.peak).toBe(10);
    expect(s.drawdown).toBe(3);
  });
});
