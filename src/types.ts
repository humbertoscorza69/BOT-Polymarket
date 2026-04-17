// Shared type definitions across the entire bot.

export type Side = 'YES' | 'NO';
export type OrderSide = 'BUY' | 'SELL';

export type Mode = 'dry_run' | 'paper' | 'live';
export type DataSource = 'real' | 'sim';

export type Regime =
  | 'low_vol_balanced'
  | 'low_vol_directional'
  | 'medium_vol'
  | 'high_vol_chop'
  | 'high_vol_trend';

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNSAFE';
export type RiskState = 'NORMAL' | 'THROTTLED' | 'HALTED' | 'EMERGENCY';

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: BookLevel[]; // descending by price
  asks: BookLevel[]; // ascending by price
  ts: number;
}

export interface PolymarketMarket {
  conditionId: string;
  questionId?: string;
  slug: string;
  question: string;
  category?: string;
  tags?: string[];
  yesTokenId: string;
  noTokenId: string;
  // epoch seconds
  endDateTs: number;
  /** Window start time in epoch seconds. Derived from slug when present,
   *  used to reject future-window markets that haven't started yet. */
  windowStartTs?: number;
  active: boolean;
  closed: boolean;
  // numeric proxy for liquidity; may be missing
  liquidityNum?: number;
  volumeNum?: number;
  // outcome prices from API (yes price, no price)
  outcomePriceYes?: number;
  outcomePriceNo?: number;
  // event grouping info
  groupItemTitle?: string;
  // discovery metadata
  raw?: unknown;
}

export interface PolySnapshot {
  market: PolymarketMarket;
  yesBook: OrderBook;
  noBook: OrderBook;
  bestBidYes: number | null;
  bestAskYes: number | null;
  midYes: number | null;
  microYes: number | null;
  spreadYes: number | null;
  topImbalance: number; // -1..1 (bid-heavy positive)
  depthImbalance: number; // -1..1 top-5
  feedAgeMs: number;
  lastUpdateTs: number;
  stale: boolean;
}

export interface BinanceSnapshot {
  symbol: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  bookImbalance: number; // -1..1
  aggressorRatio: number; // -1..1 (buy-aggressor positive)
  priceVelocityBps: number; // per 1s window
  volumeRatio: number; // 1 = baseline
  bidWall: number | null;
  askWall: number | null;
  lastTradeTs: number;
  feedAgeMs: number;
  stale: boolean;
  available: boolean;
}

export interface FeatureSnapshot {
  // timing / identity
  ts: number;
  asset: string;
  interval: string;
  conditionId: string;

  // prices (all in YES probability space 0..1)
  midYes: number | null;
  microYes: number | null;
  bestBidYes: number | null;
  bestAskYes: number | null;
  spreadYes: number | null;
  fairYes: number | null;

  // movement
  moveBps: number;
  volBps: number;
  velocityBps: number;

  // imbalances
  polyBookImbalance: number;
  binanceBookImbalance: number;
  binanceAggressorRatio: number;
  binancePriceVelocityBps: number;

  // composite
  crossPressure: number; // -1..1
  confirm: number; // -1..1

  // walls / volumes
  volumeRatio: number;
  wallSupport: number; // -1..1 proxy (bid walls positive)
  wallResistance: number;

  // market state
  timeToExpirySec: number;
  timeToExpiryFactor: number; // 0..1 decay
  staleFactor: number; // 0..1 penalty
  spreadRegime: 'tight' | 'normal' | 'wide' | 'pathological';
  liquidityScore: number; // 0..1
  bookSparsity: number; // 0..1 (high = thin book)

  // quant add-ons
  emaFair: number | null;
  zMove: number;
  realizedVolEma: number;
  quoteChurnRate: number;
  depthAsymmetry: number;
  liquidityResilience: number;
  momentumPersistence: number;
  entropyScore: number;
  toxicFlowProxy: number;
  microTrendSlope: number;
  shortReversionScore: number;
  participationScore: number;
  fillOpportunityScore: number;
}

export interface QuoteResult {
  yesBid: number | null;
  yesAsk: number | null;
  yesBidSize: number;
  yesAskSize: number;
  noBid: number | null;
  noAsk: number | null;
  noBidSize: number;
  noAskSize: number;
  mode: 'two_sided' | 'one_sided_bid' | 'one_sided_ask' | 'blocked';
  blockedReason: string | null;
  inventorySkew: number;
  internalFair: number;
  cautionScore: number;
  reservationPrice: number;
  optimalSpread: number;
  sizingMultiplier: number;
}

export interface QuoteIntent {
  side: OrderSide;
  token: 'YES' | 'NO';
  price: number; // 0..1
  sizeShares: number; // share count (USDC notional / price)
  tokenId: string;
  postOnly: boolean;
  quoteId: string;
  createdAt: number;
}

export interface ActiveOrder extends QuoteIntent {
  exchangeOrderId?: string;
  filledSize: number;
  status: 'pending' | 'live' | 'partial' | 'filled' | 'cancelled' | 'rejected' | 'expired';
  lastUpdate: number;
}

export interface Fill {
  id: string;
  ts: number;
  orderId: string;
  conditionId: string;
  asset: string;
  interval: string;
  token: 'YES' | 'NO';
  side: OrderSide;
  price: number;
  size: number;
  notional: number;
  feeUsdc: number;
  regime: Regime;
  fairAtFill: number;
  midAtFill: number;
  isMaker: boolean;
  latencyMs: number;
  mode: Mode;
  runId: string;
}

export interface AdverseSelectionSample {
  fillId: string;
  fairAtFill: number;
  mid1sLater: number | null;
  mid5sLater: number | null;
  score: number; // bps adverse
  ts: number;
  regime: Regime;
  asset: string;
  side: OrderSide;
}

export interface InventoryState {
  freeUsdc: number;
  yesPosition: number; // # of shares
  noPosition: number;
  yesAvgCost: number;
  noAvgCost: number;
  realizedPnl: number;
  unrealizedPnl: number;
  markToMarketPnl: number;
  normalizedSkew: number; // -1..1
  lastUpdate: number;
}

export interface RiskEvent {
  ts: number;
  state: RiskState;
  reason: string;
  code: string;
  severity: 'info' | 'warn' | 'error';
  pnl?: number;
  drawdown?: number;
}

export interface HealthSnapshot {
  state: HealthState;
  score: number; // 0..1
  reasons: string[];
  codes: string[];
  sizingPenalty: number; // multiplier in [0,1]
  spreadPenalty: number; // additive bps
}

export interface RegimeSnapshot {
  current: Regime;
  candidate: Regime;
  ageMs: number;
  candidateAgeMs: number;
  confidence: number;
  reason: string;
}

export interface DiscoveryCandidate {
  market: PolymarketMarket;
  score: number;
  components: Record<string, number>;
  reasons: string[];
}

export interface DiscoveryReport {
  ts: number;
  selected: PolymarketMarket | null;
  next: PolymarketMarket | null;
  candidates: DiscoveryCandidate[];
  rotations: Array<{ ts: number; from: string | null; to: string }>;
}

export interface SessionSummary {
  runId: string;
  start: number;
  end: number;
  durationMs: number;
  mode: Mode;
  totalFills: number;
  grossPnl: number;
  netPnl: number;
  realizedPnl: number;
  drawdown: number;
  regimeBreakdown: Record<Regime, { fills: number; pnl: number; winRate: number }>;
  riskEvents: RiskEvent[];
  adverseEmaFinal: number;
  params: Record<string, number>;
}
