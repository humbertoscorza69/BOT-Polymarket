import { BotConfig } from '../config';
import {
  FeatureSnapshot,
  HealthSnapshot,
  InventoryState,
  QuoteResult,
  RegimeSnapshot,
  RiskState,
} from '../types';
import { AvellanedaStoikov } from './avellaneda';
import { FairValueModel } from './fairValue';
import { clamp, clamp01 } from '../utils/math';
import { clampProb, clampSize } from '../utils/clamps';
import { AdaptiveParams } from '../persistence/paramsStore';

export interface QuoteEngineInputs {
  features: FeatureSnapshot;
  regime: RegimeSnapshot;
  health: HealthSnapshot;
  inventory: InventoryState;
  riskState: RiskState;
  params: AdaptiveParams;
  preemptiveCancelActive: boolean;
}

export class QuoteEngine {
  constructor(
    private readonly cfg: BotConfig,
    private readonly fair: FairValueModel,
    private readonly avellaneda: AvellanedaStoikov,
  ) {}

  quote(inp: QuoteEngineInputs): QuoteResult {
    const { features, regime, health, inventory, riskState, params, preemptiveCancelActive } = inp;

    // Baseline blocked response
    const blocked = (reason: string, fair = features.midYes ?? 0.5): QuoteResult => ({
      yesBid: null,
      yesAsk: null,
      yesBidSize: 0,
      yesAskSize: 0,
      noBid: null,
      noAsk: null,
      noBidSize: 0,
      noAskSize: 0,
      mode: 'blocked',
      blockedReason: reason,
      inventorySkew: inventory.normalizedSkew,
      internalFair: fair,
      cautionScore: 1,
      reservationPrice: fair,
      optimalSpread: 0,
      sizingMultiplier: 0,
    });

    if (riskState === 'HALTED' || riskState === 'EMERGENCY') {
      return blocked(`risk:${riskState}`);
    }
    if (preemptiveCancelActive) {
      return blocked('preemptive_cancel_active');
    }
    if (health.state === 'UNSAFE') {
      return blocked(`health:${health.state}`);
    }
    if (features.spreadRegime === 'pathological') {
      return blocked('pathological_spread');
    }
    if (features.liquidityScore < 0.08) {
      return blocked('thin_book');
    }
    if (features.timeToExpirySec < 10) {
      return blocked('near_expiry');
    }
    if (features.bestBidYes === null || features.bestAskYes === null) {
      return blocked('empty_book');
    }

    const fairYes = this.fair.compute(features);
    const fairEnriched: FeatureSnapshot = { ...features, fairYes };

    // inventory skew in -1..1
    const invSkew = inventory.normalizedSkew;

    // sigma in probability space from volBps
    const sigma = Math.max(this.cfg.avSigmaFloor, features.realizedVolEma / 10_000);

    const av = this.avellaneda.compute({
      fair: fairYes,
      sigma,
      gamma: params.gamma,
      k: params.k,
      inventorySkew: invSkew,
      timeToExpirySec: features.timeToExpirySec,
    });

    // Apply health + regime adjustments to spread
    const extraSpreadBps =
      health.spreadPenalty + params.spreadBias + this.regimeSpreadAdd(regime) + this.adverseSpreadAdd(features.toxicFlowProxy);
    const extraSpreadProb = extraSpreadBps / 10_000;

    const baseHalfSpreadProb = this.cfg.quoteBaseHalfSpreadBps / 10_000;
    const minEdgeProb = this.cfg.avMinEdgeBps / 10_000;
    const halfSpread = Math.max(minEdgeProb, baseHalfSpreadProb, av.halfSpread + extraSpreadProb / 2);

    let yesBid = clampProb(av.reservationPrice - halfSpread);
    let yesAsk = clampProb(av.reservationPrice + halfSpread);

    // do not cross current market
    if (features.bestAskYes !== null && yesBid >= features.bestAskYes - 0.001) {
      yesBid = features.bestAskYes - 0.001;
    }
    if (features.bestBidYes !== null && yesAsk <= features.bestBidYes + 0.001) {
      yesAsk = features.bestBidYes + 0.001;
    }
    if (yesBid >= yesAsk) {
      return blocked('degenerate_spread', fairYes);
    }

    // post-only + maker quality guard: prefer to be inside the spread but not cross
    if (this.cfg.orderPostOnly) {
      if (features.bestAskYes !== null) yesBid = Math.min(yesBid, features.bestAskYes - 0.001);
      if (features.bestBidYes !== null) yesAsk = Math.max(yesAsk, features.bestBidYes + 0.001);
    }

    // NO side mirrors YES
    const noBid = clampProb(1 - yesAsk);
    const noAsk = clampProb(1 - yesBid);

    // Sizing
    const baseSize = this.cfg.defaultQuoteSizeUsdc;
    const riskMul = riskState === 'THROTTLED' ? 0.5 : 1;
    const sizeMul = health.sizingPenalty * params.sizeMultiplier * riskMul;

    const yesBidSizeUsdc = baseSize * sizeMul;
    const yesAskSizeUsdc = baseSize * sizeMul;

    // Convert USDC notional to shares (divide by price)
    const yesBidShares = yesBidSizeUsdc / Math.max(0.02, yesBid);
    const yesAskShares = yesAskSizeUsdc / Math.max(0.02, 1 - yesAsk);

    // inventory adjustments: if we're long YES, reduce YES bid / boost YES ask
    let yBidSize = clampSize(yesBidShares, this.cfg.minOrderSizeUsdc / yesBid, this.cfg.maxOrderSizeUsdc / yesBid);
    let yAskSize = clampSize(yesAskShares, this.cfg.minOrderSizeUsdc / (1 - yesAsk), this.cfg.maxOrderSizeUsdc / (1 - yesAsk));

    if (invSkew > 0.5) {
      yBidSize = Math.floor(yBidSize * (1 - clamp01(invSkew * this.cfg.quoteSkewFactor)));
    } else if (invSkew < -0.5) {
      yAskSize = Math.floor(yAskSize * (1 - clamp01(-invSkew * this.cfg.quoteSkewFactor)));
    }

    // one-sided logic
    let mode: QuoteResult['mode'] = 'two_sided';
    if (invSkew > 0.85) mode = 'one_sided_ask';
    else if (invSkew < -0.85) mode = 'one_sided_bid';

    if (mode === 'one_sided_ask') yBidSize = 0;
    if (mode === 'one_sided_bid') yAskSize = 0;

    // block if below minimum
    const minShares = this.cfg.minOrderSizeUsdc / 0.99;
    if (yBidSize < minShares) yBidSize = 0;
    if (yAskSize < minShares) yAskSize = 0;
    if (yBidSize === 0 && yAskSize === 0) {
      return blocked('sub_minimum_size', fairYes);
    }
    if (yBidSize === 0 && mode === 'two_sided') mode = 'one_sided_ask';
    if (yAskSize === 0 && mode === 'two_sided') mode = 'one_sided_bid';

    // caution score: higher = more caution was applied
    const cautionScore = clamp01(
      0.4 * (1 - health.sizingPenalty) + 0.3 * features.toxicFlowProxy + 0.3 * features.staleFactor,
    );

    const nBidSize = mode === 'one_sided_ask' ? Math.floor(yAskSize / 2) : 0; // mirror later if needed
    const nAskSize = mode === 'one_sided_bid' ? Math.floor(yBidSize / 2) : 0;

    return {
      yesBid: yBidSize > 0 ? yesBid : null,
      yesAsk: yAskSize > 0 ? yesAsk : null,
      yesBidSize: yBidSize,
      yesAskSize: yAskSize,
      noBid: nBidSize > 0 ? noBid : null,
      noAsk: nAskSize > 0 ? noAsk : null,
      noBidSize: nBidSize,
      noAskSize: nAskSize,
      mode,
      blockedReason: null,
      inventorySkew: invSkew,
      internalFair: fairYes,
      cautionScore,
      reservationPrice: av.reservationPrice,
      optimalSpread: av.optimalSpread,
      sizingMultiplier: sizeMul,
    };
  }

  private regimeSpreadAdd(r: RegimeSnapshot): number {
    switch (r.current) {
      case 'low_vol_balanced':
        return 0;
      case 'low_vol_directional':
        return 5;
      case 'medium_vol':
        return 10;
      case 'high_vol_chop':
        return 25;
      case 'high_vol_trend':
        return 40;
      default:
        return 0;
    }
  }

  private adverseSpreadAdd(toxic: number): number {
    return clamp(toxic * 60, 0, 80);
  }
}
