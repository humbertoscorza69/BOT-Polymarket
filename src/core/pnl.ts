import { Fill, Regime } from '../types';

export interface PnlState {
  gross: number;
  net: number;
  realized: number;
  fees: number;
  peak: number;
  drawdown: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  totalFills: number;
  perRegime: Record<Regime, { fills: number; pnl: number; wins: number }>;
  history: Array<{ ts: number; equity: number }>;
  avgWin: number;
  avgLoss: number;
}

export class PnlTracker {
  private s: PnlState = {
    gross: 0,
    net: 0,
    realized: 0,
    fees: 0,
    peak: 0,
    drawdown: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    totalFills: 0,
    perRegime: {
      low_vol_balanced: { fills: 0, pnl: 0, wins: 0 },
      low_vol_directional: { fills: 0, pnl: 0, wins: 0 },
      medium_vol: { fills: 0, pnl: 0, wins: 0 },
      high_vol_chop: { fills: 0, pnl: 0, wins: 0 },
      high_vol_trend: { fills: 0, pnl: 0, wins: 0 },
    },
    history: [],
    avgWin: 0,
    avgLoss: 0,
  };

  private winTotal = 0;
  private lossTotal = 0;

  state(): PnlState {
    return this.s;
  }

  recordFillRealized(fill: Fill, realizedDelta: number): void {
    this.s.realized += realizedDelta;
    this.s.fees += fill.feeUsdc;
    this.s.gross = this.s.realized;
    this.s.net = this.s.realized - this.s.fees;
    this.s.totalFills += 1;

    if (realizedDelta > 0) {
      this.s.wins += 1;
      this.winTotal += realizedDelta;
      this.s.consecutiveLosses = 0;
    } else if (realizedDelta < 0) {
      this.s.losses += 1;
      this.lossTotal += realizedDelta;
      this.s.consecutiveLosses += 1;
    }

    this.s.avgWin = this.s.wins > 0 ? this.winTotal / this.s.wins : 0;
    this.s.avgLoss = this.s.losses > 0 ? this.lossTotal / this.s.losses : 0;

    const r = this.s.perRegime[fill.regime];
    r.fills += 1;
    r.pnl += realizedDelta;
    if (realizedDelta > 0) r.wins += 1;

    if (this.s.net > this.s.peak) this.s.peak = this.s.net;
    this.s.drawdown = Math.max(0, this.s.peak - this.s.net);
    this.s.history.push({ ts: Date.now(), equity: this.s.net });
    if (this.s.history.length > 2000) this.s.history.shift();
  }

  updateUnrealized(unrealized: number): void {
    // unrealized added to net for display, drawdown, etc.
    const combined = this.s.realized + unrealized;
    if (combined > this.s.peak) this.s.peak = combined;
    this.s.drawdown = Math.max(0, this.s.peak - combined);
  }
}
