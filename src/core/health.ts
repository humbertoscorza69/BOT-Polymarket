import { BotConfig } from '../config';
import {
  BinanceSnapshot,
  FeatureSnapshot,
  HealthSnapshot,
  HealthState,
  PolySnapshot,
} from '../types';
import { clamp01 } from '../utils/math';

export interface HealthInputs {
  poly: PolySnapshot | null;
  bin: BinanceSnapshot | null;
  features: FeatureSnapshot | null;
  apiErrorRate: number;
  adverseSelectionEma: number;
  orderRejectionRate: number;
  polyReconnects: number;
  binReconnects: number;
}

export class HealthEngine {
  private last: HealthSnapshot = {
    state: 'HEALTHY',
    score: 1,
    reasons: [],
    codes: [],
    sizingPenalty: 1,
    spreadPenalty: 0,
  };

  constructor(private readonly cfg: BotConfig) {}

  evaluate(inp: HealthInputs): HealthSnapshot {
    const reasons: string[] = [];
    const codes: string[] = [];
    let score = 1;
    let sizingPenalty = 1;
    let spreadPenalty = 0;

    if (!inp.poly) {
      reasons.push('poly feed missing');
      codes.push('POLY_MISSING');
      score -= 0.5;
      sizingPenalty *= 0.3;
      spreadPenalty += 30;
    } else if (inp.poly.stale) {
      reasons.push('poly feed stale');
      codes.push('POLY_STALE');
      score -= 0.3;
      sizingPenalty *= 0.5;
      spreadPenalty += 20;
    }

    if (this.cfg.binanceEnabled) {
      if (!inp.bin || !inp.bin.available) {
        reasons.push('binance feed unavailable');
        codes.push('BIN_UNAVAILABLE');
        score -= 0.15;
        sizingPenalty *= 0.85;
        spreadPenalty += 10;
      } else if (inp.bin.stale) {
        reasons.push('binance feed stale');
        codes.push('BIN_STALE');
        score -= 0.1;
        sizingPenalty *= 0.9;
        spreadPenalty += 5;
      }
    }

    if (inp.features) {
      if (inp.features.spreadRegime === 'pathological') {
        reasons.push('pathological spread');
        codes.push('PATHOLOGICAL_SPREAD');
        score -= 0.3;
        sizingPenalty *= 0.5;
        spreadPenalty += 30;
      }
      if (inp.features.realizedVolEma > 160) {
        reasons.push('vol spike');
        codes.push('VOL_SPIKE');
        score -= 0.15;
        sizingPenalty *= 0.7;
        spreadPenalty += 15;
      }
      if (inp.features.liquidityScore < 0.15) {
        reasons.push('thin liquidity');
        codes.push('THIN_BOOK');
        score -= 0.15;
        sizingPenalty *= 0.7;
        spreadPenalty += 10;
      }
      if (inp.features.bookSparsity > 0.85) {
        reasons.push('sparse book');
        codes.push('SPARSE_BOOK');
        score -= 0.1;
        sizingPenalty *= 0.8;
      }
    }

    if (inp.adverseSelectionEma > this.cfg.riskToxicFlowEmaCap * 0.7) {
      reasons.push('adverse selection elevated');
      codes.push('ADV_ELEVATED');
      score -= 0.15;
      sizingPenalty *= 0.7;
      spreadPenalty += 10;
    }

    if (inp.apiErrorRate > 0.2) {
      reasons.push('high API error rate');
      codes.push('API_ERR_HIGH');
      score -= 0.2;
      sizingPenalty *= 0.5;
    }

    if (inp.orderRejectionRate > 0.25) {
      reasons.push('order rejection bursts');
      codes.push('REJ_BURST');
      score -= 0.15;
      sizingPenalty *= 0.7;
    }

    if (inp.polyReconnects > 10 || inp.binReconnects > 10) {
      reasons.push('reconnect storm');
      codes.push('RECONNECT_STORM');
      score -= 0.1;
    }

    score = clamp01(score);
    sizingPenalty = clamp01(sizingPenalty);

    let state: HealthState = 'HEALTHY';
    if (score < 0.35) state = 'UNSAFE';
    else if (score < 0.7) state = 'DEGRADED';

    this.last = { state, score, reasons, codes, sizingPenalty, spreadPenalty };
    return this.last;
  }

  getLast(): HealthSnapshot {
    return this.last;
  }
}
