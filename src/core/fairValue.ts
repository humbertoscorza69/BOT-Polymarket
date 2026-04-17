import { BotConfig } from '../config';
import { FeatureSnapshot } from '../types';
import { clamp, clamp01 } from '../utils/math';
import { clampProb } from '../utils/clamps';

/**
 * Composite internal fair value generator.
 * Blends Polymarket microprice with external signals in a smoothing,
 * risk-averse way. Robust against noisy inputs and missing Binance.
 */
export class FairValueModel {
  constructor(private readonly cfg: BotConfig) {}

  compute(f: FeatureSnapshot): number {
    const base = f.microYes ?? f.midYes ?? 0.5;
    const ema = f.emaFair ?? base;

    // Weights from config — W_MICROPRICE controls anchor blend,
    // remaining weights control signal nudge magnitudes.
    const wMicro = this.cfg.wMicroprice;
    const wPolyImbal = this.cfg.wPolyImbalance;
    const wBinImbal = this.cfg.wBinanceImbalance;
    const wBinAggr = this.cfg.wBinanceAggressor;
    const wBinMom = this.cfg.wBinanceMomentum;

    // Signal scale — converts [-1,1] signals to probability-space nudges.
    // At scale=0.03, a weight=1.0 max-strength signal shifts fair by ±3 cents.
    const scale = 0.03;

    // Compute signal nudges (each in [-scale, +scale])
    const polyImbalNudge = clamp(f.polyBookImbalance, -1, 1) * scale;
    const binImbalNudge = clamp(f.binanceBookImbalance, -1, 1) * scale;
    const aggrNudge = clamp(f.binanceAggressorRatio, -1, 1) * scale;
    const momSign = Math.sign(f.binancePriceVelocityBps);
    const momNudge = momSign * clamp01(f.momentumPersistence) * scale;

    // Confirm amplifier — correlated signals strengthen the move
    const confirmMul = 1 + clamp01(f.confirm) * 0.4;

    // Anchor: blend microprice with EMA. wMicro controls how much
    // weight goes to fresh microprice vs smoothed EMA.
    const anchor = wMicro * base + (1 - wMicro) * ema;

    // Raw fair = anchor + weighted signal nudges
    let raw =
      anchor +
      (wPolyImbal * polyImbalNudge +
       wBinImbal * binImbalNudge +
       wBinAggr * aggrNudge +
       wBinMom * momNudge) * confirmMul;

    // volatility penalty: shrink toward anchor under high vol
    const volDrag = clamp01(f.realizedVolEma / 200); // 200bps rolling move => heavy drag
    raw = anchor * volDrag + raw * (1 - volDrag);

    // stale penalty: shrink to mid
    if (f.staleFactor > 0) {
      const shrink = clamp01(f.staleFactor);
      raw = (f.midYes ?? raw) * shrink + raw * (1 - shrink);
    }

    // time-to-expiry decay: very close to expiry, anchor hard
    if (f.timeToExpiryFactor < 0.2) {
      raw = anchor * (1 - f.timeToExpiryFactor / 0.2) + raw * (f.timeToExpiryFactor / 0.2);
    }

    // clamp to a safe band around the book
    if (f.bestBidYes !== null && f.bestAskYes !== null) {
      const pad = 0.02;
      raw = clamp(raw, Math.max(0.005, f.bestBidYes - pad), Math.min(0.995, f.bestAskYes + pad));
    }
    return clampProb(raw);
  }
}
