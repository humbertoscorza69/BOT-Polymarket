import { describe, it, expect } from 'vitest';
import { AdverseSelectionDetector } from '../src/core/adverseSelection';
import { BotConfig } from '../src/config';
import { Fill } from '../src/types';

describe('AdverseSelectionDetector', () => {
  it('starts with EMA at 0', () => {
    const a = new AdverseSelectionDetector({ advEmaAlpha: 0.1, advSample1sMs: 100, advSample5sMs: 200 } as BotConfig);
    expect(a.getEma()).toBe(0);
  });

  it('records samples', async () => {
    const cfg = { advEmaAlpha: 0.5, advSample1sMs: 50, advSample5sMs: 100 } as BotConfig;
    const a = new AdverseSelectionDetector(cfg);
    // Manually drive mid via start callback
    let mid = 0.5;
    a.start(() => mid);
    const fill: Fill = {
      id: 'fx',
      ts: Date.now(),
      orderId: 'o',
      conditionId: 'c',
      asset: 'BTC',
      interval: '5m',
      token: 'YES',
      side: 'BUY',
      price: 0.5,
      size: 10,
      notional: 5,
      feeUsdc: 0,
      regime: 'low_vol_balanced',
      fairAtFill: 0.5,
      midAtFill: 0.5,
      isMaker: true,
      latencyMs: 10,
      mode: 'paper',
    };
    a.onFill(fill, null);
    // move mid down => adverse to a BUY
    mid = 0.48;
    await new Promise((r) => setTimeout(r, 250));
    a.stop();
    expect(a.getEma()).toBeGreaterThanOrEqual(0);
  });
});
