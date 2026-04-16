import { describe, it, expect } from 'vitest';
import { FeatureStore } from '../src/core/featureStore';
import { PolySnapshot, BinanceSnapshot, PolymarketMarket } from '../src/types';

function mkMarket(): PolymarketMarket {
  return {
    conditionId: 'c1',
    slug: 'btc-updown-5m-123',
    question: 'BTC up?',
    yesTokenId: 'y1',
    noTokenId: 'n1',
    endDateTs: Math.floor(Date.now() / 1000) + 300,
    active: true,
    closed: false,
    tags: ['5m'],
    category: 'Crypto',
  };
}

function mkPoly(mid: number, opts: Partial<PolySnapshot> = {}): PolySnapshot {
  return {
    market: mkMarket(),
    yesBook: { bids: [{ price: mid - 0.005, size: 100 }], asks: [{ price: mid + 0.005, size: 100 }], ts: Date.now() },
    noBook: { bids: [{ price: 1 - mid - 0.005, size: 50 }], asks: [{ price: 1 - mid + 0.005, size: 50 }], ts: Date.now() },
    bestBidYes: mid - 0.005,
    bestAskYes: mid + 0.005,
    midYes: mid,
    microYes: mid,
    spreadYes: 0.01,
    topImbalance: 0,
    depthImbalance: 0,
    feedAgeMs: 100,
    lastUpdateTs: Date.now(),
    stale: false,
    ...opts,
  };
}

function mkBin(): BinanceSnapshot {
  return {
    symbol: 'BTCUSDT',
    bestBid: 95000,
    bestAsk: 95001,
    mid: 95000.5,
    bookImbalance: 0,
    aggressorRatio: 0,
    priceVelocityBps: 0,
    volumeRatio: 1,
    bidWall: null,
    askWall: null,
    lastTradeTs: Date.now(),
    feedAgeMs: 50,
    stale: false,
    available: true,
  };
}

describe('FeatureStore', () => {
  it('produces valid features from poly snapshot', () => {
    const fs = new FeatureStore();
    const f = fs.update(mkPoly(0.50), mkBin(), 'BTC', '5m');
    expect(f).not.toBeNull();
    expect(f!.midYes).toBe(0.50);
    expect(f!.asset).toBe('BTC');
    expect(f!.conditionId).toBe('c1');
    expect(f!.timeToExpirySec).toBeGreaterThan(0);
  });

  it('returns null when poly mid is null', () => {
    const fs = new FeatureStore();
    const f = fs.update(mkPoly(0.50, { midYes: null }), mkBin(), 'BTC', '5m');
    expect(f).toBeNull();
  });

  it('tracks rolling stats across updates', () => {
    const fs = new FeatureStore();
    fs.update(mkPoly(0.50), mkBin(), 'BTC', '5m');
    fs.update(mkPoly(0.51), mkBin(), 'BTC', '5m');
    fs.update(mkPoly(0.52), mkBin(), 'BTC', '5m');
    const f = fs.update(mkPoly(0.53), mkBin(), 'BTC', '5m');
    expect(f!.moveBps).not.toBe(0);
    expect(f!.volBps).toBeGreaterThanOrEqual(0);
  });

  it('classifies spread regime', () => {
    const fs = new FeatureStore();
    const tight = fs.update(mkPoly(0.50, { spreadYes: 0.003 }), mkBin(), 'BTC', '5m');
    expect(tight!.spreadRegime).toBe('tight');
  });
});
