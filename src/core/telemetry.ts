import EventEmitter from 'eventemitter3';
import {
  ActiveOrder,
  BinanceSnapshot,
  DiscoveryReport,
  FeatureSnapshot,
  Fill,
  HealthSnapshot,
  InventoryState,
  PolySnapshot,
  QuoteResult,
  RegimeSnapshot,
  RiskEvent,
  RiskState,
} from '../types';
import { PnlState } from './pnl';
import { AdaptiveParams } from '../persistence/paramsStore';
import { AdverseSelectionSample } from '../types';

export interface TelemetrySnapshot {
  ts: number;
  runId: string;
  mode: string;
  poly: PolySnapshot | null;
  bin: BinanceSnapshot | null;
  features: FeatureSnapshot | null;
  quote: QuoteResult | null;
  regime: RegimeSnapshot | null;
  health: HealthSnapshot | null;
  inventory: InventoryState | null;
  pnl: PnlState | null;
  risk: { state: RiskState; events: RiskEvent[] };
  discovery: DiscoveryReport | null;
  params: AdaptiveParams | null;
  activeOrders: ActiveOrder[];
  recentFills: Fill[];
  advStats: {
    ema: number;
    byRegime: Record<string, number>;
    bySide: Record<string, number>;
    totalSamples: number;
    recent: AdverseSelectionSample[];
  };
  feedHealth: {
    polyReconnects: number;
    binReconnects: number;
    polyAgeMs: number | null;
    binAgeMs: number | null;
    polyStale: boolean;
    binStale: boolean;
  };
  latencyArb: {
    active: boolean;
    recentCancels: Array<{ ts: number; reason: string }>;
    totalCancels: number;
  };
  /** POL-35-I: per-stage latency averages/p95/max. */
  latencyStats: Record<string, { avg: number; p95: number; max: number; count: number }>;
  autohealChanges: Array<{ ts: number; note: string }>;
  live: {
    enabled: boolean;
    driverHealthy: boolean;
    reconciledOk: boolean;
    openOrderCount: number;
    lastFillTs: number | null;
  };
  exchangeBalance: number | null;
  recentErrors: Array<{ ts: number; msg: string }>;
}

export class TelemetryHub extends EventEmitter {
  private last: Partial<TelemetrySnapshot> = {};

  updatePartial(part: Partial<TelemetrySnapshot>): void {
    this.last = { ...this.last, ...part, ts: Date.now() };
    this.emit('snapshot', this.last);
  }

  getLast(): Partial<TelemetrySnapshot> {
    return this.last;
  }
}
