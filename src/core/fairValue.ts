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

    // Weights (from config)
    const W = {
      micro: this.cfg.wMicroprice,
      polyImbal: this.cfg.wPolyImbalance,
      binImbal: this.cfg.wBinanceImbalance,
      binAggr: this.cfg.wBinanceAggressor,
      binMomentum: this.cfg.wBinanceMomentum,
    };

    // Nudge scale — convert signal to probability space nudge.
    // Each signal is in [-1, 1] and we convert to a small probability offset.
    const scale = 0.015; // 150 bps max per signal before clamping

    // poly imbalance nudge
    const polyN = f.polyBookImbalance * scale * 0.7;
    // binance book imbalance
    const binN = f.binanceBookImbalance * scale;
    // aggressor
    const aggrN = f.binanceAggressorRatio * scale * 0.8;
    // momentum (persistence * sign of velocity)
    const momSign = Math.sign(f.binancePriceVelocityBps);
    const momN = momSign * f.momentumPersistence * scale * 0.9;

    // confirm amplifier
    const confirmMul = 1 + clamp01(f.confirm) * 0.4;

    // blend center: micro + EMA mixing
    const anchor = 0.65 * base + 0.35 * ema;

    // raw fair
    let raw =
      anchor +
      (W.polyImbal * polyN + W.binImbal * binN + W.binAggr * aggrN + W.binMomentum * momN) * confirmMul;

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
