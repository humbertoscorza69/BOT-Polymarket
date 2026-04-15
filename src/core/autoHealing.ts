import { BotConfig } from '../config';
import { Fill, Regime } from '../types';
import { ParamsStore, AdaptiveParams } from '../persistence/paramsStore';
import { getLogger } from '../utils/logger';
import { clamp } from '../utils/math';

const log = getLogger('autoheal');

interface RegimeStats {
  fills: number;
  wins: number;
  pnl: number;
  toxicSum: number;
}

export class AutoHealing {
  private stats: Record<Regime, RegimeStats> = {
    low_vol_balanced: { fills: 0, wins: 0, pnl: 0, toxicSum: 0 },
    low_vol_directional: { fills: 0, wins: 0, pnl: 0, toxicSum: 0 },
    medium_vol: { fills: 0, wins: 0, pnl: 0, toxicSum: 0 },
    high_vol_chop: { fills: 0, wins: 0, pnl: 0, toxicSum: 0 },
    high_vol_trend: { fills: 0, wins: 0, pnl: 0, toxicSum: 0 },
  };
  private timer: NodeJS.Timeout | null = null;
  private lastChanges: Array<{ ts: number; note: string }> = [];

  constructor(
    private readonly cfg: BotConfig,
    private readonly params: ParamsStore,
    private readonly getAdverseEma: () => number,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.run(), this.cfg.autohealIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onFill(fill: Fill, pnlDelta: number, toxic: number): void {
    const s = this.stats[fill.regime];
    s.fills += 1;
    s.pnl += pnlDelta;
    if (pnlDelta > 0) s.wins += 1;
    s.toxicSum += toxic;
    this.params.updateRegime(fill.regime, {
      fills: s.fills,
      pnl: s.pnl,
      winRate: s.fills > 0 ? s.wins / s.fills : 0,
      toxicity: s.fills > 0 ? s.toxicSum / s.fills : 0,
    });
  }

  recentChanges(): Array<{ ts: number; note: string }> {
    return this.lastChanges.slice(-30);
  }

  private run(): void {
    const p = this.params.get();
    let changed = false;
    const notes: string[] = [];

    const advEma = this.getAdverseEma();

    // If toxicity is high, widen globally and shrink size
    if (advEma > 0.4) {
      const next: Partial<AdaptiveParams> = {
        spreadBias: clamp(p.spreadBias + this.cfg.autohealSpreadStepBps, -20, 80),
        sizeMultiplier: clamp(p.sizeMultiplier - this.cfg.autohealSizeStep, 0.2, 1.5),
      };
      this.params.update(next);
      notes.push(`toxic=${advEma.toFixed(2)} -> widen+shrink`);
      changed = true;
    } else if (advEma < 0.15) {
      // Tighten gradually if toxicity is low and we have meaningful sample size
      const sample = this.totalFills();
      if (sample >= this.cfg.autohealMinFills) {
        const next: Partial<AdaptiveParams> = {
          spreadBias: clamp(p.spreadBias - this.cfg.autohealSpreadStepBps * 0.5, -20, 80),
          sizeMultiplier: clamp(p.sizeMultiplier + this.cfg.autohealSizeStep * 0.5, 0.2, 1.5),
        };
        this.params.update(next);
        notes.push(`low-toxic n=${sample} -> tighten`);
        changed = true;
      }
    }

    // Per-regime tuning
    for (const r of Object.keys(this.stats) as Regime[]) {
      const s = this.stats[r];
      if (s.fills < this.cfg.autohealMinFills) continue;
      const winRate = s.wins / s.fills;
      const avgPnl = s.pnl / s.fills;
      const avgTox = s.toxicSum / s.fills;
      const reg = p.perRegime[r] ?? { spreadBias: 0, sizeMultiplier: 1, fills: 0, pnl: 0, winRate: 0, toxicity: 0, updatedAt: 0 };
      const next: Partial<typeof reg> = {};
      if (winRate < 0.4 || avgPnl < 0 || avgTox > 0.35) {
        next.spreadBias = clamp(reg.spreadBias + this.cfg.autohealSpreadStepBps, -20, 120);
        next.sizeMultiplier = clamp(reg.sizeMultiplier - this.cfg.autohealSizeStep, 0.2, 1.5);
        notes.push(`${r} poor -> widen/shrink`);
        changed = true;
      } else if (winRate > 0.6 && avgPnl > 0 && avgTox < 0.2) {
        next.spreadBias = clamp(reg.spreadBias - this.cfg.autohealSpreadStepBps * 0.5, -20, 120);
        next.sizeMultiplier = clamp(reg.sizeMultiplier + this.cfg.autohealSizeStep * 0.5, 0.2, 1.5);
        notes.push(`${r} strong -> tighten`);
        changed = true;
      }
      if (Object.keys(next).length > 0) this.params.updateRegime(r, next);
    }

    if (changed) {
      log.info('autoheal adjusted', { notes });
      this.lastChanges.push({ ts: Date.now(), note: notes.join('; ') });
      if (this.lastChanges.length > 100) this.lastChanges.shift();
    }
  }

  private totalFills(): number {
    let n = 0;
    for (const r of Object.values(this.stats)) n += r.fills;
    return n;
  }
}
