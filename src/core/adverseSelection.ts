import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import {
  AdverseSelectionSample,
  Fill,
  FeatureSnapshot,
  Regime,
  Side,
} from '../types';
import { Ema } from '../utils/stats';
import { clamp01 } from '../utils/math';
import { getLogger } from '../utils/logger';

const log = getLogger('adverse');

interface PendingSample {
  fill: Fill;
  scheduled1s: number;
  scheduled5s: number;
  fairAtFill: number;
  mid1s: number | null;
  mid5s: number | null;
}

export class AdverseSelectionDetector extends EventEmitter {
  private pending: PendingSample[] = [];
  private samples: AdverseSelectionSample[] = [];
  private ema: Ema;
  private toxicByRegime: Record<string, number> = {};
  private toxicBySide: Record<string, number> = {};
  private currentMid: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: BotConfig) {
    super();
    this.ema = new Ema(cfg.advEmaAlpha);
  }

  start(getMid: () => number | null): void {
    this.timer = setInterval(() => {
      this.currentMid = getMid();
      this.processPending();
    }, 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onFill(fill: Fill, features: FeatureSnapshot | null): void {
    const fair = features?.fairYes ?? fill.fairAtFill;
    const now = Date.now();
    this.pending.push({
      fill,
      scheduled1s: now + this.cfg.advSample1sMs,
      scheduled5s: now + this.cfg.advSample5sMs,
      fairAtFill: fair,
      mid1s: null,
      mid5s: null,
    });
  }

  private processPending(): void {
    const now = Date.now();
    const mid = this.currentMid;
    for (const p of this.pending) {
      if (p.mid1s === null && now >= p.scheduled1s && mid !== null) {
        p.mid1s = mid;
      }
      if (p.mid5s === null && now >= p.scheduled5s && mid !== null) {
        p.mid5s = mid;
      }
    }
    const completed = this.pending.filter((p) => p.mid5s !== null);
    this.pending = this.pending.filter((p) => p.mid5s === null);
    for (const c of completed) this.finalize(c);
  }

  private finalize(p: PendingSample): void {
    // adverse selection score in bps:
    // if we BOUGHT, market moving down is adverse
    // if we SOLD, market moving up is adverse
    const side = p.fill.side;
    const direction = side === 'BUY' ? 1 : -1;
    const mid5 = p.mid5s ?? p.fairAtFill;
    const moveBps = (mid5 - p.fairAtFill) * 10_000;
    const adverseBps = -direction * moveBps; // positive = bad for us

    // normalize: we expect to capture ~spread/2; anything beyond that is toxic
    const norm = clamp01(adverseBps / 80); // 80bps = very bad

    const sample: AdverseSelectionSample = {
      fillId: p.fill.id,
      fairAtFill: p.fairAtFill,
      mid1sLater: p.mid1s,
      mid5sLater: p.mid5s,
      score: norm,
      ts: Date.now(),
      regime: p.fill.regime,
      asset: p.fill.asset,
      side: p.fill.side,
    };

    this.samples.push(sample);
    if (this.samples.length > 500) this.samples.shift();

    const e = this.ema.update(norm);

    const rkey = p.fill.regime;
    this.toxicByRegime[rkey] = (this.toxicByRegime[rkey] ?? 0) * 0.9 + norm * 0.1;
    this.toxicBySide[p.fill.side] = (this.toxicBySide[p.fill.side] ?? 0) * 0.9 + norm * 0.1;

    log.debug('adverse sample', { fill: p.fill.id, score: norm.toFixed(3), ema: e.toFixed(3) });
    this.emit('sample', sample);
  }

  getEma(): number {
    return this.ema.value;
  }

  recent(n: number): AdverseSelectionSample[] {
    return this.samples.slice(-n);
  }

  stats(): {
    ema: number;
    byRegime: Record<string, number>;
    bySide: Record<string, number>;
    totalSamples: number;
  } {
    return {
      ema: this.ema.value,
      byRegime: { ...this.toxicByRegime },
      bySide: { ...this.toxicBySide },
      totalSamples: this.samples.length,
    };
  }
}
