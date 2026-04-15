import { BotConfig } from '../config';
import { clamp } from '../utils/math';
import { clampProb } from '../utils/clamps';

export interface AvellanedaInput {
  fair: number; // in probability space 0..1
  sigma: number; // realized vol in probability units (not bps)
  gamma: number;
  k: number;
  inventorySkew: number; // -1..1 (negative = long YES)
  timeToExpirySec: number;
}

export interface AvellanedaOutput {
  reservationPrice: number;
  optimalSpread: number;
  halfSpread: number;
  bid: number;
  ask: number;
  clamped: boolean;
}

/**
 * Classic Avellaneda-Stoikov quoting formulas:
 *   r = s - q * gamma * sigma^2 * tau
 *   spread = gamma * sigma^2 * tau + (2/gamma) * ln(1 + gamma/k)
 *
 * We normalize tau to a horizon of 1 (intraday); for very short TTLs we floor it.
 */
export class AvellanedaStoikov {
  constructor(private readonly cfg: BotConfig) {}

  compute(inp: AvellanedaInput): AvellanedaOutput {
    const sigma = Math.max(this.cfg.avSigmaFloor, inp.sigma);
    const gamma = Math.max(0.05, inp.gamma);
    const k = Math.max(0.05, inp.k);

    // tau in [0, 1]; the horizon used is the "session horizon" normalized.
    // For intraday 5m/15m contracts we represent remaining life as a fraction of a 30-minute horizon.
    const horizon = 30 * 60;
    const tau = Math.max(0.01, Math.min(1, inp.timeToExpirySec / horizon));

    // inventory term: shift reservation away from fair based on inventory
    const reservation = inp.fair - inp.inventorySkew * gamma * sigma * sigma * tau;

    const spread = gamma * sigma * sigma * tau + (2 / gamma) * Math.log(1 + gamma / k);
    const halfSpread = spread / 2;

    // enforce min/max spread
    const minSpreadProb = this.cfg.avSpreadMinBps / 10_000;
    const maxSpreadProb = this.cfg.avSpreadMaxBps / 10_000;
    const clampedSpread = clamp(spread, minSpreadProb, maxSpreadProb);
    const clampedHalf = clampedSpread / 2;

    const bid = clampProb(reservation - clampedHalf);
    const ask = clampProb(reservation + clampedHalf);

    return {
      reservationPrice: clampProb(reservation),
      optimalSpread: clampedSpread,
      halfSpread: clampedHalf,
      bid,
      ask,
      clamped: spread !== clampedSpread,
    };
  }
}
