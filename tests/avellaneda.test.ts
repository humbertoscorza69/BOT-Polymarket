import { describe, it, expect } from 'vitest';
import { AvellanedaStoikov } from '../src/core/avellaneda';
import { BotConfig } from '../src/config';

function mkCfg(): BotConfig {
  return {
    avGamma: 0.8,
    avK: 1.5,
    avSigmaFloor: 0.004,
    avSpreadMinBps: 40,
    avSpreadMaxBps: 400,
    avMinEdgeBps: 18,
  } as BotConfig;
}

describe('AvellanedaStoikov', () => {
  const av = new AvellanedaStoikov(mkCfg());

  it('computes reservation price below fair when long inventory', () => {
    const r = av.compute({ fair: 0.5, sigma: 0.01, gamma: 0.8, k: 1.5, inventorySkew: 0.5, timeToExpirySec: 600 });
    expect(r.reservationPrice).toBeLessThan(0.5);
  });

  it('computes reservation price above fair when short inventory', () => {
    const r = av.compute({ fair: 0.5, sigma: 0.01, gamma: 0.8, k: 1.5, inventorySkew: -0.5, timeToExpirySec: 600 });
    expect(r.reservationPrice).toBeGreaterThan(0.5);
  });

  it('widens spread with higher sigma', () => {
    const lo = av.compute({ fair: 0.5, sigma: 0.005, gamma: 0.8, k: 1.5, inventorySkew: 0, timeToExpirySec: 600 });
    const hi = av.compute({ fair: 0.5, sigma: 0.02, gamma: 0.8, k: 1.5, inventorySkew: 0, timeToExpirySec: 600 });
    expect(hi.optimalSpread).toBeGreaterThanOrEqual(lo.optimalSpread);
  });

  it('widens spread with higher gamma', () => {
    const lo = av.compute({ fair: 0.5, sigma: 0.01, gamma: 0.3, k: 1.5, inventorySkew: 0, timeToExpirySec: 600 });
    const hi = av.compute({ fair: 0.5, sigma: 0.01, gamma: 2.0, k: 1.5, inventorySkew: 0, timeToExpirySec: 600 });
    expect(hi.optimalSpread).toBeGreaterThanOrEqual(lo.optimalSpread);
  });

  it('clamps spread between min and max', () => {
    const r = av.compute({ fair: 0.5, sigma: 0.5, gamma: 5, k: 0.5, inventorySkew: 0, timeToExpirySec: 600 });
    expect(r.optimalSpread).toBeLessThanOrEqual(0.04 + 1e-9);
  });

  it('bid < ask always', () => {
    const r = av.compute({ fair: 0.5, sigma: 0.01, gamma: 0.8, k: 1.5, inventorySkew: 0, timeToExpirySec: 600 });
    expect(r.bid).toBeLessThan(r.ask);
  });
});
