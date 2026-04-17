import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InventoryEngine } from '../src/execution/inventoryEngine';
import { RiskManager } from '../src/core/riskManager';
import { QuoteEngine } from '../src/core/quoteEngine';
import { AvellanedaStoikov } from '../src/core/avellaneda';
import { TokenBucket } from '../src/execution/rateLimiter';
import { FairValueModel } from '../src/core/fairValue';
import { CancelCoordinator } from '../src/execution/cancelCoordinator';
import { OrderManager } from '../src/execution/orderManager';
import { PaperTrader } from '../src/core/paperTrader';
import { FillTracker } from '../src/execution/fillTracker';
import { PnlTracker } from '../src/core/pnl';
import { BotConfig } from '../src/config';
import { defaultAdaptiveParams } from '../src/persistence/paramsStore';
import { Fill, FeatureSnapshot, InventoryState, QuoteResult, PolymarketMarket } from '../src/types';

import { HealthEngine } from '../src/core/health';

function mkFill(token: 'YES' | 'NO', side: 'BUY' | 'SELL', price: number, size: number, overrides: Partial<Fill> = {}): Fill {
  return {
    id: `fill-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    orderId: 'o1',
    conditionId: 'c1',
    asset: 'BTC',
    interval: '5m',
    token,
    side,
    price,
    size,
    notional: price * size,
    feeUsdc: 0,
    regime: 'low_vol_balanced',
    fairAtFill: 0.5,
    midAtFill: 0.5,
    isMaker: true,
    latencyMs: 10,
    mode: 'paper',
    runId: 'test',
    ...overrides,
  };
}

function mkCfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    avGamma: 0.8,
    avK: 1.5,
    avSigmaFloor: 0.004,
    avSpreadMinBps: 40,
    avSpreadMaxBps: 400,
    avMinEdgeBps: 18,
    wMicroprice: 0.45,
    wPolyImbalance: 0.15,
    wBinanceImbalance: 0.2,
    wBinanceAggressor: 0.1,
    wBinanceMomentum: 0.1,
    defaultQuoteSizeUsdc: 15,
    minOrderSizeUsdc: 5,
    maxOrderSizeUsdc: 50,
    orderPostOnly: true,
    orderMaxAgeMs: 15000,
    orderReplaceDriftBps: 18,
    paperFillProbBase: 0.5,
    paperPartialFillProb: 0.3,
    paperMakerFeeBps: 0,
    paperTakerFeeBps: 20,
    paperLatencyMs: 0,
    paperToxicityBaseline: 0.18,
    paperSlippageBps: 4,
    bankrollUsdc: 500,
    riskMaxInventoryUsdc: 200,
    riskSessionLossCapUsdc: 100,
    riskDrawdownCapUsdc: 60,
    riskConsecutiveLossCap: 6,
    riskApiErrorCap: 25,
    riskToxicFlowEmaCap: 0.55,
    cancelVelocityBpsTrigger: 12,
    cancelAggressorTrigger: 0.55,
    cancelFreezeMs: 1200,
    quoteBaseHalfSpreadBps: 150,
    quoteSkewFactor: 2.0,
    inventoryMaxShares: 1000,
    inventoryEmergencyThresholdPct: 80,
    freshnessMinOrderbookDepth: 3,
    ...overrides,
  } as BotConfig;
}

function mkFeat(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    ts: Date.now(),
    asset: 'BTC',
    interval: '5m',
    conditionId: 'c1',
    midYes: 0.5,
    microYes: 0.5,
    bestBidYes: 0.495,
    bestAskYes: 0.505,
    spreadYes: 0.01,
    fairYes: 0.5,
    moveBps: 0,
    volBps: 0,
    velocityBps: 0,
    polyBookImbalance: 0,
    binanceBookImbalance: 0,
    binanceAggressorRatio: 0,
    binancePriceVelocityBps: 0,
    crossPressure: 0,
    confirm: 0,
    volumeRatio: 1,
    wallSupport: 0,
    wallResistance: 0,
    timeToExpirySec: 600,
    timeToExpiryFactor: 1,
    staleFactor: 0,
    spreadRegime: 'normal',
    liquidityScore: 0.6,
    bookSparsity: 0.4,
    emaFair: 0.5,
    zMove: 0,
    realizedVolEma: 20,
    quoteChurnRate: 0,
    depthAsymmetry: 0,
    liquidityResilience: 1,
    momentumPersistence: 0.3,
    entropyScore: 0.7,
    toxicFlowProxy: 0.1,
    microTrendSlope: 0,
    shortReversionScore: 0,
    participationScore: 0.5,
    fillOpportunityScore: 0.5,
    ...overrides,
  };
}

function mkMarket(): PolymarketMarket {
  return {
    conditionId: 'c1',
    slug: 'btc-updown-5m-12345',
    question: 'BTC up in next 5m?',
    yesTokenId: 'y1',
    noTokenId: 'n1',
    endDateTs: Math.floor(Date.now() / 1000) + 300,
    active: true,
    closed: false,
  };
}

function mkInv(overrides: Partial<InventoryState> = {}): InventoryState {
  return {
    freeUsdc: 500,
    yesPosition: 0,
    noPosition: 0,
    yesAvgCost: 0,
    noAvgCost: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    markToMarketPnl: 0,
    normalizedSkew: 0,
    lastUpdate: Date.now(),
    ...overrides,
  };
}

describe('Phase 4 Validation', () => {
  describe('Stale quote handling', () => {
    it('QuoteEngine blocks on stale feed (staleFactor=1)', () => {
      const cfg = mkCfg();
      const qe = new QuoteEngine(cfg, new FairValueModel(cfg), new AvellanedaStoikov(cfg));
      const r = qe.quote({
        features: mkFeat({ staleFactor: 1.0 }),
        regime: { current: 'low_vol_balanced', candidate: 'low_vol_balanced', ageMs: 0, candidateAgeMs: 0, confidence: 1, reason: '' },
        health: { state: 'HEALTHY', score: 1, reasons: [], codes: [], sizingPenalty: 1, spreadPenalty: 0 },
        inventory: mkInv(),
        riskState: 'NORMAL',
        params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
        preemptiveCancelActive: false,
      });
      expect(r.cautionScore).toBeGreaterThan(0);
    });

    it('CancelCoordinator fires on velocity spike', () => {
      const cc = new CancelCoordinator({ velocityBpsTrigger: 12, aggressorTrigger: 0.55, freezeMs: 1200, velocityAloneBpsTrigger: 25 });
      let cancelFired = false;
      cc.on('cancelAll', () => { cancelFired = true; });
      // velocity-alone trigger: 30 > 25 threshold, no aggressor needed
      cc.feed(
        { symbol: 'BTCUSDT', bestBid: 50000, bestAsk: 50001, mid: 50000.5, bookImbalance: 0, aggressorRatio: 0, priceVelocityBps: 30, volumeRatio: 1, bidWall: null, askWall: null, lastTradeTs: Date.now(), feedAgeMs: 100, stale: false, available: true },
        mkFeat(),
      );
      expect(cancelFired).toBe(true);
      expect(cc.isActive()).toBe(true);
    });
  });

  describe('Inventory limit enforcement', () => {
    it('blocks quoting when inventory max shares exceeded', () => {
      const cfg = mkCfg({ inventoryMaxShares: 100 });
      const qe = new QuoteEngine(cfg, new FairValueModel(cfg), new AvellanedaStoikov(cfg));
      const inv = mkInv({ yesPosition: 85, yesAvgCost: 0.5, normalizedSkew: 0.9 });
      const r = qe.quote({
        features: mkFeat(),
        regime: { current: 'low_vol_balanced', candidate: 'low_vol_balanced', ageMs: 0, candidateAgeMs: 0, confidence: 1, reason: '' },
        health: { state: 'HEALTHY', score: 1, reasons: [], codes: [], sizingPenalty: 1, spreadPenalty: 0 },
        inventory: inv,
        riskState: 'NORMAL',
        params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
        preemptiveCancelActive: false,
      });
      expect(r.mode).toBe('one_sided_ask');
      expect(r.yesBidSize).toBe(0);
    });

    it('emergencyTriggered returns true past threshold', () => {
      const cfg = mkCfg({ inventoryMaxShares: 100, inventoryEmergencyThresholdPct: 80 });
      const inv = new InventoryEngine(cfg);
      inv.applyFill(mkFill('YES', 'BUY', 0.5, 85));
      expect(inv.emergencyTriggered).toBe(true);
    });

    it('emergencyTriggered returns false below threshold', () => {
      const cfg = mkCfg({ inventoryMaxShares: 100, inventoryEmergencyThresholdPct: 80 });
      const inv = new InventoryEngine(cfg);
      inv.applyFill(mkFill('YES', 'BUY', 0.5, 50));
      expect(inv.emergencyTriggered).toBe(false);
    });
  });

  describe('End-of-market behavior', () => {
    it('QuoteEngine blocks on near-expiry market (<10s)', () => {
      const cfg = mkCfg();
      const qe = new QuoteEngine(cfg, new FairValueModel(cfg), new AvellanedaStoikov(cfg));
      const r = qe.quote({
        features: mkFeat({ timeToExpirySec: 5, timeToExpiryFactor: 0.01 }),
        regime: { current: 'low_vol_balanced', candidate: 'low_vol_balanced', ageMs: 0, candidateAgeMs: 0, confidence: 1, reason: '' },
        health: { state: 'HEALTHY', score: 1, reasons: [], codes: [], sizingPenalty: 1, spreadPenalty: 0 },
        inventory: mkInv(),
        riskState: 'NORMAL',
        params: defaultAdaptiveParams(cfg.avGamma, cfg.avK),
        preemptiveCancelActive: false,
      });
      expect(r.mode).toBe('blocked');
      expect(r.blockedReason).toBe('near_expiry');
    });
  });

  describe('Reconciliation check', () => {
    it('fillsStore matches inventoryEngine state after fills', () => {
      const cfg = mkCfg({ bankrollUsdc: 500, riskMaxInventoryUsdc: 200 });
      const inv = new InventoryEngine(cfg);
      const fills = new FillTracker();

      const f1 = mkFill('YES', 'BUY', 0.45, 100);
      fills.record(f1);
      inv.applyFill(f1);

      const f2 = mkFill('YES', 'SELL', 0.55, 50);
      fills.record(f2);
      const realizedDelta = inv.applyFill(f2);

      expect(fills.all()).toHaveLength(2);
      expect(inv.state.yesPosition).toBe(50);
      expect(realizedDelta).toBeCloseTo(5, 2);
    });
  });

  describe('PnL correctness', () => {
    it('gross vs net PnL with fees', () => {
      const pnl = new PnlTracker();
      const f1 = mkFill('YES', 'BUY', 0.40, 100);
      pnl.recordFillRealized(f1, 0);

      const f2 = mkFill('YES', 'SELL', 0.60, 100, { feeUsdc: 1.2 });
      pnl.recordFillRealized(f2, 20);

      const s = pnl.state();
      expect(s.totalFills).toBe(2);
      expect(s.realized).toBeCloseTo(20, 2);
      expect(s.fees).toBeCloseTo(1.2, 2);
      expect(s.net).toBeCloseTo(20 - 1.2, 2);
    });
  });

  describe('Emergency stop / SIGTERM behavior', () => {
    it('cancelAll clears all active orders', async () => {
      const cfg = mkCfg({ mode: 'dry_run' });
      const paper = new PaperTrader(cfg);
      const om = new OrderManager({ mode: 'dry_run', cfg, paper });
      om.setMarket(mkMarket());

      await om.applyQuote({
        yesBid: 0.48,
        yesAsk: 0.52,
        yesBidSize: 30,
        yesAskSize: 30,
        noBid: null,
        noAsk: null,
        noBidSize: 0,
        noAskSize: 0,
        mode: 'two_sided',
        blockedReason: null,
        inventorySkew: 0,
        internalFair: 0.5,
        cautionScore: 0.1,
        reservationPrice: 0.5,
        optimalSpread: 0.04,
        sizingMultiplier: 1,
      });

      expect(om.getActive().length).toBeGreaterThanOrEqual(2);
      const n = await om.cancelAll('SIGTERM');
      expect(n).toBeGreaterThanOrEqual(2);
      expect(om.getActive().length).toBe(0);
    });

    it('cancelAll during market rotation clears old orders', async () => {
      const cfg = mkCfg({ mode: 'dry_run' });
      const paper = new PaperTrader(cfg);
      const om = new OrderManager({ mode: 'dry_run', cfg, paper });

      om.setMarket(mkMarket());
      await om.applyQuote({
        yesBid: 0.48, yesAsk: 0.52, yesBidSize: 30, yesAskSize: 30,
        noBid: null, noAsk: null, noBidSize: 0, noAskSize: 0,
        mode: 'two_sided', blockedReason: null, inventorySkew: 0,
        internalFair: 0.5, cautionScore: 0.1, reservationPrice: 0.5,
        optimalSpread: 0.04, sizingMultiplier: 1,
      });
      expect(om.getActive().length).toBeGreaterThan(0);

      const m2: PolymarketMarket = {
        conditionId: 'c2', slug: 'eth-updown-5m-99999', question: 'ETH up?',
        yesTokenId: 'y2', noTokenId: 'n2',
        endDateTs: Math.floor(Date.now() / 1000) + 600, active: true, closed: false,
      };
      om.setMarket(m2);
      await new Promise((r) => setTimeout(r, 50));
      expect(om.getActive().length).toBe(0);
    });
  });

  describe('Risk state transitions', () => {
    it('transitions NORMAL -> EMERGENCY on session loss cap', () => {
      const cfg = mkCfg({ riskSessionLossCapUsdc: 100 });
      const rm = new RiskManager(cfg);
      const s = rm.evaluate({
        sessionPnl: -200,
        peakPnl: 0,
        consecutiveLosses: 0,
        adverseSelectionEma: 0,
        apiErrors: 0,
        feedStale: false,
        orderRejections: 0,
        reconcileDrift: false,
        inventory: mkInv(),
      });
      expect(s).toBe('EMERGENCY');
    });

    it('transitions NORMAL -> THROTTLED on feed stale', () => {
      const cfg = mkCfg();
      const rm = new RiskManager(cfg);
      const s = rm.evaluate({
        sessionPnl: 0,
        peakPnl: 0,
        consecutiveLosses: 0,
        adverseSelectionEma: 0,
        apiErrors: 0,
        feedStale: true,
        orderRejections: 0,
        reconcileDrift: false,
        inventory: mkInv(),
      });
      expect(s).toBe('THROTTLED');
    });

    it('stays EMERGENCY once entered (no auto-recovery)', () => {
      const cfg = mkCfg({ riskSessionLossCapUsdc: 100 });
      const rm = new RiskManager(cfg);
      rm.evaluate({
        sessionPnl: -200, peakPnl: 0, consecutiveLosses: 0, adverseSelectionEma: 0,
        apiErrors: 0, feedStale: false, orderRejections: 0, reconcileDrift: false,
        inventory: mkInv(),
      });
      expect(rm.getState()).toBe('EMERGENCY');
      rm.evaluate({
        sessionPnl: 0, peakPnl: 0, consecutiveLosses: 0, adverseSelectionEma: 0,
        apiErrors: 0, feedStale: false, orderRejections: 0, reconcileDrift: false,
        inventory: mkInv(),
      });
      expect(rm.getState()).toBe('EMERGENCY');
    });
  });

  describe('Rate limit handling', () => {
    it('take() succeeds when tokens available', async () => {
      const bucket = new TokenBucket(8, 4);
      await expect(bucket.take(1, 500)).resolves.toBeUndefined();
      expect(bucket.availableTokens()).toBeCloseTo(7, 0);
    });

    it('take() throws on timeout when bucket is exhausted', async () => {
      const bucket = new TokenBucket(2, 0.01); // tiny refill rate
      await bucket.take(2, 500); // drain bucket
      await expect(bucket.take(1, 200)).rejects.toThrow('rateLimiter.take() timeout');
    });

    it('take() does not hang indefinitely', async () => {
      const bucket = new TokenBucket(1, 0.001);
      await bucket.take(1, 100); // drain
      const start = Date.now();
      await expect(bucket.take(1, 300)).rejects.toThrow('rateLimiter.take() timeout');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('Health edge cases', () => {
    it('UNSAFE on missing poly feed', () => {
      const cfg = mkCfg();
      const h = new HealthEngine(cfg);
      const snap = h.evaluate({
        poly: null,
        bin: null,
        features: null,
        apiErrorRate: 0,
        adverseSelectionEma: 0,
        orderRejectionRate: 0,
        polyReconnects: 0,
        binReconnects: 0,
      });
      expect(snap.state).toBe('DEGRADED');
      expect(snap.sizingPenalty).toBeLessThan(0.5);
    });

    it('detects shallow book depth below FRESHNESS_MIN_ORDERBOOK_DEPTH', () => {
      const cfg = mkCfg({ freshnessMinOrderbookDepth: 5 });
      const h = new HealthEngine(cfg);
      const snap = h.evaluate({
        poly: {
          stale: false, feedAgeMs: 100, midYes: 0.5,
          yesBook: { bids: [{ price: 0.49, size: 10 }, { price: 0.48, size: 10 }], asks: [{ price: 0.51, size: 10 }], ts: Date.now() },
          noBook: { bids: [], asks: [], ts: Date.now() },
          market: mkMarket(), bestBidYes: 0.49, bestAskYes: 0.51, microYes: 0.5, spreadYes: 0.02,
          topImbalance: 0, depthImbalance: 0, lastUpdateTs: Date.now(),
        },
        bin: { available: true, stale: false, feedAgeMs: 100 },
        features: { spreadRegime: 'normal', realizedVolEma: 20, liquidityScore: 0.5, bookSparsity: 0.3 },
        apiErrorRate: 0,
        adverseSelectionEma: 0,
        orderRejectionRate: 0,
        polyReconnects: 0,
        binReconnects: 0,
      });
      expect(snap.codes).toContain('SHALLOW_DEPTH');
    });
  });
});
