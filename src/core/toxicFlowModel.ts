import { Ema } from '../utils/stats';
import { clamp01 } from '../utils/math';
import { AdverseSelectionSample, Regime } from '../types';

/**
 * Breaks out toxicity decomposition: fees / adverse / slippage / inventory-drag.
 * Useful for operator review.
 */
export class ToxicFlowModel {
  feeSum = 0;
  adverseSum = 0;
  slippageSum = 0;
  inventoryDragSum = 0;
  sampleEma = new Ema(0.08);
  byRegime: Record<Regime, number> = {
    low_vol_balanced: 0,
    low_vol_directional: 0,
    medium_vol: 0,
    high_vol_chop: 0,
    high_vol_trend: 0,
  };

  addSample(s: AdverseSelectionSample, feeUsdc: number, slippageUsdc: number, dragUsdc: number): void {
    this.sampleEma.update(s.score);
    this.byRegime[s.regime] = (this.byRegime[s.regime] ?? 0) * 0.9 + s.score * 0.1;
    this.feeSum += feeUsdc;
    this.adverseSum += s.score;
    this.slippageSum += slippageUsdc;
    this.inventoryDragSum += dragUsdc;
  }

  decompose(): { fees: number; adverse: number; slippage: number; inventoryDrag: number } {
    return {
      fees: this.feeSum,
      adverse: this.adverseSum,
      slippage: this.slippageSum,
      inventoryDrag: this.inventoryDragSum,
    };
  }

  score(): number {
    return clamp01(this.sampleEma.value);
  }
}
