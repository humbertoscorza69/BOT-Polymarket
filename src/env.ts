import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

dotenvConfig();

const csv = (v: string | undefined, def: string[]): string[] =>
  v && v.trim().length > 0 ? v.split(',').map((s) => s.trim()).filter(Boolean) : def;

const num = (v: string | undefined, def: number): number => {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in env: ${v}`);
  return n;
};

const bool = (v: string | undefined, def: boolean): boolean => {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase());
};

const str = (v: string | undefined, def: string): string => (v && v.length > 0 ? v : def);

export const ModeSchema = z.enum(['dry_run', 'paper', 'live']);
export type Mode = z.infer<typeof ModeSchema>;

export const DataSourceSchema = z.enum(['real', 'sim']);
export type DataSource = z.infer<typeof DataSourceSchema>;

export interface SymbolMap {
  [asset: string]: string;
}

function parseSymbolMap(raw: string | undefined): SymbolMap {
  const def: SymbolMap = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT',
    DOGE: 'DOGEUSDT',
    XRP: 'XRPUSDT',
    BNB: 'BNBUSDT',
    HYPE: 'HYPEUSDT',
  };
  if (!raw) return def;
  const m: SymbolMap = {};
  for (const part of raw.split(',')) {
    const [a, b] = part.split(':').map((s) => s.trim());
    if (a && b) m[a.toUpperCase()] = b.toUpperCase();
  }
  return Object.keys(m).length > 0 ? m : def;
}

export interface EnvConfig {
  mode: Mode;
  dataSource: DataSource;
  liveApiEnabled: boolean;

  bankrollUsdc: number;
  minOrderSizeUsdc: number;
  maxOrderSizeUsdc: number;
  defaultQuoteSizeUsdc: number;

  targetAssets: string[];
  targetIntervals: string[];
  discoveryPollMs: number;
  discoveryMinLiquidityScore: number;
  discoveryPrewarmSecs: number;

  polymarketHttp: string;
  polymarketWs: string;
  polymarketGamma: string;
  polyFeedStaleMs: number;
  polyReconnectMinMs: number;
  polyReconnectMaxMs: number;

  binanceWs: string;
  binanceEnabled: boolean;
  binanceFeedStaleMs: number;
  binanceSymbolMap: SymbolMap;

  avGamma: number;
  avK: number;
  avSigmaFloor: number;
  avSpreadMinBps: number;
  avSpreadMaxBps: number;
  avMinEdgeBps: number;

  wMicroprice: number;
  wPolyImbalance: number;
  wBinanceImbalance: number;
  wBinanceAggressor: number;
  wBinanceMomentum: number;

  paperFillProbBase: number;
  paperPartialFillProb: number;
  paperMakerFeeBps: number;
  paperTakerFeeBps: number;
  paperLatencyMs: number;
  paperToxicityBaseline: number;
  paperSlippageBps: number;

  riskSessionLossCapUsdc: number;
  riskDrawdownCapUsdc: number;
  riskConsecutiveLossCap: number;
  riskApiErrorCap: number;
  riskToxicFlowEmaCap: number;
  riskMaxInventoryUsdc: number;

  advSample1sMs: number;
  advSample5sMs: number;
  advEmaAlpha: number;

  autohealIntervalMs: number;
  autohealMinFills: number;
  autohealSpreadStepBps: number;
  autohealSizeStep: number;

  orderMaxAgeMs: number;
  orderReplaceDriftBps: number;
  orderPostOnly: boolean;
  rateLimitOrdersPerSec: number;
  rateLimitBurst: number;

  cancelVelocityBpsTrigger: number;
  cancelAggressorTrigger: number;
  cancelFreezeMs: number;

  tickMs: number;

  polyPrivateKey: string;
  polyFunderAddress: string;
  polyApiKey: string;
  polyApiSecret: string;
  polyApiPassphrase: string;
  polyChainId: number;

  dashboardHost: string;
  dashboardPort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  discordWebhookUrl: string;
}

export function loadEnv(): EnvConfig {
  const e = process.env;

  const mode = ModeSchema.parse(str(e.MODE, 'dry_run'));
  const dataSource = DataSourceSchema.parse(str(e.DATA_SOURCE, 'real'));

  const cfg: EnvConfig = {
    mode,
    dataSource,
    liveApiEnabled: bool(e.LIVE_API_ENABLED, false),

    bankrollUsdc: num(e.BANKROLL_USDC, 500),
    minOrderSizeUsdc: num(e.MIN_ORDER_SIZE_USDC, 5),
    maxOrderSizeUsdc: num(e.MAX_ORDER_SIZE_USDC, 50),
    defaultQuoteSizeUsdc: num(e.DEFAULT_QUOTE_SIZE_USDC, 15),

    targetAssets: csv(e.TARGET_ASSETS, ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'BNB', 'HYPE']).map((x) => x.toUpperCase()),
    targetIntervals: csv(e.TARGET_INTERVALS, ['5m', '15m']).map((x) => x.toLowerCase()),
    discoveryPollMs: num(e.DISCOVERY_POLL_MS, 30_000),
    discoveryMinLiquidityScore: num(e.DISCOVERY_MIN_LIQUIDITY_SCORE, 0.15),
    discoveryPrewarmSecs: num(e.DISCOVERY_PREWARM_SECS, 60),

    polymarketHttp: str(e.POLYMARKET_HTTP, 'https://clob.polymarket.com'),
    polymarketWs: str(e.POLYMARKET_WS, 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),
    polymarketGamma: str(e.POLYMARKET_GAMMA, 'https://gamma-api.polymarket.com'),
    polyFeedStaleMs: num(e.POLY_FEED_STALE_MS, 7000),
    polyReconnectMinMs: num(e.POLY_RECONNECT_MIN_MS, 1000),
    polyReconnectMaxMs: num(e.POLY_RECONNECT_MAX_MS, 30000),

    binanceWs: str(e.BINANCE_WS, 'wss://stream.binance.com:9443/stream'),
    binanceEnabled: bool(e.BINANCE_ENABLED, true),
    binanceFeedStaleMs: num(e.BINANCE_FEED_STALE_MS, 4000),
    binanceSymbolMap: parseSymbolMap(e.BINANCE_SYMBOL_MAP),

    avGamma: num(e.AV_GAMMA, 0.8),
    avK: num(e.AV_K, 1.5),
    avSigmaFloor: num(e.AV_SIGMA_FLOOR, 0.004),
    avSpreadMinBps: num(e.AV_SPREAD_MIN_BPS, 40),
    avSpreadMaxBps: num(e.AV_SPREAD_MAX_BPS, 400),
    avMinEdgeBps: num(e.AV_MIN_EDGE_BPS, 18),

    wMicroprice: num(e.W_MICROPRICE, 0.45),
    wPolyImbalance: num(e.W_POLY_IMBALANCE, 0.15),
    wBinanceImbalance: num(e.W_BINANCE_IMBALANCE, 0.2),
    wBinanceAggressor: num(e.W_BINANCE_AGGRESSOR, 0.1),
    wBinanceMomentum: num(e.W_BINANCE_MOMENTUM, 0.1),

    paperFillProbBase: num(e.PAPER_FILL_PROB_BASE, 0.22),
    paperPartialFillProb: num(e.PAPER_PARTIAL_FILL_PROB, 0.3),
    paperMakerFeeBps: num(e.PAPER_MAKER_FEE_BPS, 0),
    paperTakerFeeBps: num(e.PAPER_TAKER_FEE_BPS, 20),
    paperLatencyMs: num(e.PAPER_LATENCY_MS, 140),
    paperToxicityBaseline: num(e.PAPER_TOXICITY_BASELINE, 0.18),
    paperSlippageBps: num(e.PAPER_SLIPPAGE_BPS, 4),

    riskSessionLossCapUsdc: num(e.RISK_SESSION_LOSS_CAP_USDC, 100),
    riskDrawdownCapUsdc: num(e.RISK_DRAWDOWN_CAP_USDC, 60),
    riskConsecutiveLossCap: num(e.RISK_CONSECUTIVE_LOSS_CAP, 6),
    riskApiErrorCap: num(e.RISK_API_ERROR_CAP, 25),
    riskToxicFlowEmaCap: num(e.RISK_TOXIC_FLOW_EMA_CAP, 0.55),
    riskMaxInventoryUsdc: num(e.RISK_MAX_INVENTORY_USDC, 200),

    advSample1sMs: num(e.ADV_SAMPLE_1S_MS, 1000),
    advSample5sMs: num(e.ADV_SAMPLE_5S_MS, 5000),
    advEmaAlpha: num(e.ADV_EMA_ALPHA, 0.08),

    autohealIntervalMs: num(e.AUTOHEAL_INTERVAL_MS, 180_000),
    autohealMinFills: num(e.AUTOHEAL_MIN_FILLS, 8),
    autohealSpreadStepBps: num(e.AUTOHEAL_SPREAD_STEP_BPS, 5),
    autohealSizeStep: num(e.AUTOHEAL_SIZE_STEP, 0.1),

    orderMaxAgeMs: num(e.ORDER_MAX_AGE_MS, 15_000),
    orderReplaceDriftBps: num(e.ORDER_REPLACE_DRIFT_BPS, 18),
    orderPostOnly: bool(e.ORDER_POST_ONLY, true),
    rateLimitOrdersPerSec: num(e.RATE_LIMIT_ORDERS_PER_SEC, 4),
    rateLimitBurst: num(e.RATE_LIMIT_BURST, 8),

    cancelVelocityBpsTrigger: num(e.CANCEL_VELOCITY_BPS_TRIGGER, 12),
    cancelAggressorTrigger: num(e.CANCEL_AGGRESSOR_TRIGGER, 0.55),
    cancelFreezeMs: num(e.CANCEL_FREEZE_MS, 1200),

    tickMs: num(e.TICK_MS, 500),

    polyPrivateKey: str(e.POLY_PRIVATE_KEY, ''),
    polyFunderAddress: str(e.POLY_FUNDER_ADDRESS, ''),
    polyApiKey: str(e.POLY_API_KEY, ''),
    polyApiSecret: str(e.POLY_API_SECRET, ''),
    polyApiPassphrase: str(e.POLY_API_PASSPHRASE, ''),
    polyChainId: num(e.POLY_CHAIN_ID, 137),

    dashboardHost: str(e.DASHBOARD_HOST, '127.0.0.1'),
    dashboardPort: num(e.DASHBOARD_PORT, 8787),
    logLevel: (str(e.LOG_LEVEL, 'info') as EnvConfig['logLevel']),

    discordWebhookUrl: str(e.DISCORD_WEBHOOK_URL, ''),
  };

  validateSanity(cfg);
  return cfg;
}

export function validateSanity(cfg: EnvConfig): void {
  if (cfg.minOrderSizeUsdc <= 0) throw new Error('MIN_ORDER_SIZE_USDC must be > 0');
  if (cfg.maxOrderSizeUsdc < cfg.minOrderSizeUsdc)
    throw new Error('MAX_ORDER_SIZE_USDC must be >= MIN_ORDER_SIZE_USDC');
  if (cfg.defaultQuoteSizeUsdc < cfg.minOrderSizeUsdc)
    throw new Error('DEFAULT_QUOTE_SIZE_USDC must be >= MIN_ORDER_SIZE_USDC');
  if (cfg.avSpreadMaxBps < cfg.avSpreadMinBps)
    throw new Error('AV_SPREAD_MAX_BPS must be >= AV_SPREAD_MIN_BPS');
  if (cfg.avGamma <= 0) throw new Error('AV_GAMMA must be > 0');
  if (cfg.avK <= 0) throw new Error('AV_K must be > 0');
  if (cfg.targetAssets.length === 0) throw new Error('TARGET_ASSETS cannot be empty');
  if (cfg.mode === 'live' && !cfg.liveApiEnabled) {
    throw new Error('MODE=live requires LIVE_API_ENABLED=true as an explicit safety flag');
  }
  if (cfg.mode === 'live') {
    if (!cfg.polyPrivateKey || !cfg.polyFunderAddress) {
      throw new Error('MODE=live requires POLY_PRIVATE_KEY and POLY_FUNDER_ADDRESS');
    }
  }
}
