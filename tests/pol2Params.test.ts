import { describe, it, expect } from 'vitest';
import { POL2_RANGES, validatePol2Ranges, getPol2Params } from '../src/env';
import type { EnvConfig } from '../src/env';

function makeCfg(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    mode: 'dry_run',
    dataSource: 'real',
    liveApiEnabled: false,
    bankrollUsdc: 500,
    minOrderSizeUsdc: 5,
    maxOrderSizeUsdc: 50,
    defaultQuoteSizeUsdc: 15,
    targetAssets: ['BTC'],
    targetIntervals: ['5m'],
    discoveryPollMs: 30000,
    discoveryMinLiquidityScore: 0.15,
    discoveryPrewarmSecs: 60,
    polymarketHttp: 'https://clob.polymarket.com',
    polymarketWs: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    polymarketGamma: 'https://gamma-api.polymarket.com',
    polyFeedStaleMs: 7000,
    polyReconnectMinMs: 1000,
    polyReconnectMaxMs: 30000,
    binanceWs: 'wss://stream.binance.com:9443/stream',
    binanceEnabled: true,
    binanceFeedStaleMs: 4000,
    binanceSymbolMap: { BTC: 'BTCUSDT' },
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
    paperFillProbBase: 0.22,
    paperPartialFillProb: 0.3,
    paperMakerFeeBps: 0,
    paperTakerFeeBps: 20,
    paperLatencyMs: 140,
    paperToxicityBaseline: 0.18,
    paperSlippageBps: 4,
    riskSessionLossCapUsdc: 100,
    riskDrawdownCapUsdc: 60,
    riskConsecutiveLossCap: 6,
    riskApiErrorCap: 25,
    riskToxicFlowEmaCap: 0.55,
    riskMaxInventoryUsdc: 200,
    advSample1sMs: 1000,
    advSample5sMs: 5000,
    advEmaAlpha: 0.08,
    autohealIntervalMs: 180000,
    autohealMinFills: 8,
    autohealSpreadStepBps: 5,
    autohealSizeStep: 0.1,
    orderMaxAgeMs: 15000,
    orderReplaceDriftBps: 18,
    orderPostOnly: true,
    rateLimitOrdersPerSec: 4,
    rateLimitBurst: 8,
    cancelVelocityBpsTrigger: 12,
    cancelAggressorTrigger: 0.55,
    cancelFreezeMs: 1200,
    tickMs: 500,
    polyPrivateKey: '',
    polyFunderAddress: '',
    polyApiKey: '',
    polyApiSecret: '',
    polyApiPassphrase: '',
    polyChainId: 137,
    dashboardHost: '127.0.0.1',
    dashboardPort: 8787,
    logLevel: 'info',
    discordWebhookUrl: '',
    quoteBaseHalfSpreadBps: 150,
    quoteSkewFactor: 2.0,
    quoteTtrWeight: 1.0,
    quoteRegimeSensitivity: 1.0,
    inventoryMaxShares: 1000,
    inventoryEmergencyThresholdPct: 80,
    discoveryMinVolumeUsdc: 10000,
    discoveryMaxInitialSpreadBps: 200,
    discoveryMinTtrHours: 12,
    discoveryMaxTtrDays: 30,
    freshnessPolyMaxStaleMs: 5000,
    freshnessBinanceMaxStaleMs: 15000,
    freshnessMinOrderbookDepth: 3,
    ...overrides,
  } as EnvConfig;
}

describe('POL-2 Parameter Validation', () => {
  it('accepts all defaults without error', () => {
    expect(() => validatePol2Ranges(makeCfg())).not.toThrow();
  });

  it('returns all 17 params from getPol2Params', () => {
    const params = getPol2Params(makeCfg());
    expect(Object.keys(params)).toHaveLength(17);
  });

  for (const [name, rule] of Object.entries(POL2_RANGES)) {
    describe(name, () => {
      it(`rejects value below min (${rule.min})`, () => {
        const cfg = makeCfgWithPol2(name, rule.min - (rule.min >= 1 ? 1 : 0.01));
        expect(() => validatePol2Ranges(cfg)).toThrow(name);
      });

      it(`rejects value above max (${rule.max})`, () => {
        const cfg = makeCfgWithPol2(name, rule.max + (rule.max >= 1 ? 1 : 0.01));
        expect(() => validatePol2Ranges(cfg)).toThrow(name);
      });

      it(`accepts min value (${rule.min})`, () => {
        const cfg = makeCfgWithPol2(name, rule.min);
        expect(() => validatePol2Ranges(cfg)).not.toThrow();
      });

      it(`accepts max value (${rule.max})`, () => {
        const cfg = makeCfgWithPol2(name, rule.max);
        expect(() => validatePol2Ranges(cfg)).not.toThrow();
      });
    });
  }
});

function makeCfgWithPol2(name: string, val: number): EnvConfig {
  const mapping: Record<string, keyof EnvConfig> = {
    QUOTE_BASE_HALF_SPREAD_BPS: 'quoteBaseHalfSpreadBps',
    QUOTE_SKEW_FACTOR: 'quoteSkewFactor',
    QUOTE_TTR_WEIGHT: 'quoteTtrWeight',
    QUOTE_REGIME_SENSITIVITY: 'quoteRegimeSensitivity',
    INVENTORY_MAX_SHARES: 'inventoryMaxShares',
    INVENTORY_EMERGENCY_THRESHOLD_PCT: 'inventoryEmergencyThresholdPct',
    DISCOVERY_MIN_VOLUME_USDC: 'discoveryMinVolumeUsdc',
    DISCOVERY_MAX_INITIAL_SPREAD_BPS: 'discoveryMaxInitialSpreadBps',
    DISCOVERY_MIN_TTR_HOURS: 'discoveryMinTtrHours',
    DISCOVERY_MAX_TTR_DAYS: 'discoveryMaxTtrDays',
    FRESHNESS_POLY_MAX_STALE_MS: 'freshnessPolyMaxStaleMs',
    FRESHNESS_BINANCE_MAX_STALE_MS: 'freshnessBinanceMaxStaleMs',
    FRESHNESS_MIN_ORDERBOOK_DEPTH: 'freshnessMinOrderbookDepth',
    RISK_CANCEL_VELOCITY_BPS_TRIGGER: 'cancelVelocityBpsTrigger',
    RISK_CANCEL_AGGRESSOR_THRESHOLD: 'cancelAggressorTrigger',
    RISK_CANCEL_FREEZE_MS: 'cancelFreezeMs',
    CONTROL_TICK_MS: 'tickMs',
  };
  const key = mapping[name];
  if (!key) throw new Error(`unknown POL-2 param: ${name}`);
  return makeCfg({ [key]: val } as Partial<EnvConfig>);
}
