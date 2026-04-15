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
  it('ignores markets without asset match', () => {
    const eng = new DiscoveryEngine(cfg, {
      targetAssets: ['BTC'],
      targetIntervals: ['5m'],
      minLiquidityScore: 0.1,
      prewarmSecs: 60,
      gammaUrl: 'x',
      pollMs: 30000,
    });
    const markets = [
      {
        conditionId: 'x',
        slug: 'sol-price',
        question: 'Will SOL go up in 5m?',
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

  it('prefers higher liquidity + correct ttl', () => {
    const eng = new DiscoveryEngine(cfg, {
      targetAssets: ['BTC'],
      targetIntervals: ['5m'],
      minLiquidityScore: 0.1,
      prewarmSecs: 60,
      gammaUrl: 'x',
      pollMs: 30000,
    });
    const markets = [
      {
        conditionId: 'a',
        slug: 'btc-5m-a',
        question: 'Will Bitcoin go up in 5 minutes?',
        yesTokenId: '1',
        noTokenId: '2',
        endDateTs: Math.floor(Date.now() / 1000) + 120,
        active: true,
        closed: false,
        liquidityNum: 1000,
      },
      {
        conditionId: 'b',
        slug: 'btc-5m-b',
        question: 'Will Bitcoin go up in 5 minutes?',
        yesTokenId: '1',
        noTokenId: '2',
        endDateTs: Math.floor(Date.now() / 1000) + 120,
        active: true,
        closed: false,
        liquidityNum: 100,
      },
    ];
    const scored = (eng as any).scoreAll(markets);
    expect(scored[0].market.conditionId).toBe('a');
  });
});
