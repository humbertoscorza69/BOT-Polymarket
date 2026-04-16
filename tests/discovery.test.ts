import { describe, it, expect } from 'vitest';
import { DiscoveryEngine } from '../src/adapters/discovery';
import { BotConfig } from '../src/config';

const cfg = {
  polymarketGamma: 'https://gamma-api.polymarket.com',
  discoveryMinLiquidityScore: 0.1,
  discoveryPrewarmSecs: 60,
  discoveryPollMs: 30000,
  targetAssets: ['BTC'],
  targetIntervals: ['5m'],
} as BotConfig;

describe('DiscoveryEngine scoring', () => {
  it('ignores markets without matching slug pattern', () => {
    const eng = new DiscoveryEngine(cfg, {
      targetAssets: ['BTC'],
      targetIntervals: ['5m'],
      minLiquidityScore: 0.1,
      prewarmSecs: 60,
      gammaUrl: 'x',
      pollMs: 30000,
    });
    // Slug doesn't match {asset}-updown-{interval}-{ts} pattern
    const markets = [
      {
        conditionId: 'x',
        slug: 'sol-price-something',
        question: 'Will SOL go up?',
        yesTokenId: '1',
        noTokenId: '2',
        endDateTs: Math.floor(Date.now() / 1000) + 200,
        active: true,
        closed: false,
      },
    ];
    const scored = (eng as any).scoreAll(markets);
    expect(scored.length).toBe(0);
  });

  it('prefers higher liquidity market', () => {
    const eng = new DiscoveryEngine(cfg, {
      targetAssets: ['BTC'],
      targetIntervals: ['5m'],
      minLiquidityScore: 0.1,
      prewarmSecs: 60,
      gammaUrl: 'x',
      pollMs: 30000,
    });
    const ts = Math.floor(Date.now() / 1000);
    const wTs = ts - (ts % 300);
    const markets = [
      {
        conditionId: 'a',
        slug: `btc-updown-5m-${wTs}`,
        question: 'Bitcoin Up or Down',
        yesTokenId: '1',
        noTokenId: '2',
        endDateTs: ts + 200,
        active: true,
        closed: false,
        liquidityNum: 15000,
        outcomePriceYes: 0.50,
      },
      {
        conditionId: 'b',
        slug: `btc-updown-5m-${wTs + 300}`,
        question: 'Bitcoin Up or Down',
        yesTokenId: '3',
        noTokenId: '4',
        endDateTs: ts + 500,
        active: true,
        closed: false,
        liquidityNum: 500,
        outcomePriceYes: 0.50,
      },
    ];
    const scored = (eng as any).scoreAll(markets);
    expect(scored.length).toBe(2);
    expect(scored[0].market.conditionId).toBe('a');
  });

  it('scores price balance — prefers 0.50 over skewed', () => {
    const eng = new DiscoveryEngine(cfg, {
      targetAssets: ['BTC'],
      targetIntervals: ['5m'],
      minLiquidityScore: 0.1,
      prewarmSecs: 60,
      gammaUrl: 'x',
      pollMs: 30000,
    });
    const ts = Math.floor(Date.now() / 1000);
    const wTs = ts - (ts % 300);
    const markets = [
      {
        conditionId: 'balanced',
        slug: `btc-updown-5m-${wTs}`,
        question: 'Bitcoin Up or Down',
        yesTokenId: '1',
        noTokenId: '2',
        endDateTs: ts + 200,
        active: true,
        closed: false,
        liquidityNum: 10000,
        outcomePriceYes: 0.50,
      },
      {
        conditionId: 'skewed',
        slug: `btc-updown-5m-${wTs + 300}`,
        question: 'Bitcoin Up or Down',
        yesTokenId: '3',
        noTokenId: '4',
        endDateTs: ts + 200,
        active: true,
        closed: false,
        liquidityNum: 10000,
        outcomePriceYes: 0.15,
      },
    ];
    const scored = (eng as any).scoreAll(markets);
    expect(scored[0].market.conditionId).toBe('balanced');
  });
});
