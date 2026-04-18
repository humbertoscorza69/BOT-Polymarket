import { getLogger } from '../utils/logger';

const log = getLogger('latency');

type Stage =
  | 'feedPoly' // Polymarket WS msg → stored
  | 'feedBin' // Binance WS msg → stored
  | 'fv' // feature update → fair value computed
  | 'quote' // fair value → quote produced
  | 'orderPlace' // placeOrder call → exchange confirm
  | 'cancel' // cancelOrder call → confirm
  | 'fillDetect' // poll sees order missing → fill event emit
  | 'e2e'; // external price move → order updated on exchange

interface StageStats {
  count: number;
  sum: number;
  max: number;
  recent: number[]; // rolling last N samples for percentiles
}

/**
 * POL-35-I latency monitoring. Records timings at every critical pipeline
 * stage and periodically logs a summary. Exposes snapshot for dashboard.
 */
export class LatencyTracker {
  private stages: Map<Stage, StageStats> = new Map();
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private readonly windowSize = 200;

  record(stage: Stage, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let s = this.stages.get(stage);
    if (!s) {
      s = { count: 0, sum: 0, max: 0, recent: [] };
      this.stages.set(stage, s);
    }
    s.count += 1;
    s.sum += ms;
    if (ms > s.max) s.max = ms;
    s.recent.push(ms);
    if (s.recent.length > this.windowSize) s.recent.shift();
  }

  /** Convenience: measure an async function. */
  async time<T>(stage: Stage, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.record(stage, Date.now() - t0);
    }
  }

  /** Start periodic log summaries (every `intervalMs`). */
  startLogging(intervalMs = 60_000): void {
    if (this.logTimer) return;
    this.logTimer = setInterval(() => this.logSummary(), intervalMs);
  }

  stopLogging(): void {
    if (this.logTimer) clearInterval(this.logTimer);
    this.logTimer = null;
  }

  logSummary(): void {
    const lines: string[] = [];
    for (const [stage, s] of this.stages) {
      if (s.count === 0) continue;
      const avg = s.sum / s.count;
      const p95 = percentile(s.recent, 0.95);
      lines.push(`${stage}=avg${avg.toFixed(0)}ms p95${p95.toFixed(0)}ms max${s.max.toFixed(0)}ms n=${s.count}`);
    }
    if (lines.length > 0) log.info('[LATENCY] ' + lines.join(' | '));
  }

  snapshot(): Record<string, { avg: number; p95: number; max: number; count: number }> {
    const out: Record<string, { avg: number; p95: number; max: number; count: number }> = {};
    for (const [stage, s] of this.stages) {
      if (s.count === 0) continue;
      out[stage] = {
        avg: s.sum / s.count,
        p95: percentile(s.recent, 0.95),
        max: s.max,
        count: s.count,
      };
    }
    return out;
  }
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}
