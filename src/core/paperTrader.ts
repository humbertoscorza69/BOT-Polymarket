import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import {
  ActiveOrder,
  FeatureSnapshot,
  Fill,
  PolySnapshot,
  QuoteIntent,
  QuoteResult,
  Regime,
} from '../types';
import { getLogger } from '../utils/logger';
import { clamp01 } from '../utils/math';
import { newFillId, newOrderId } from '../utils/ids';

const log = getLogger('paper');

interface SimOrder extends ActiveOrder {
  submittedAt: number;
  visibleAfter: number;
  simQueuePos: number;
}

/**
 * Realistic paper trader. Models:
 *  - fill probability scaled by regime, distance to mid, toxicity
 *  - missed fills
 *  - partial fills
 *  - slippage on fill price
 *  - maker fees
 *  - informed flow (adverse moves after fill)
 *  - latency on place/cancel
 */
export class PaperTrader extends EventEmitter {
  private orders: Map<string, SimOrder> = new Map();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastPoly: PolySnapshot | null = null;
  private lastFeatures: FeatureSnapshot | null = null;
  private currentRegime: Regime = 'low_vol_balanced';

  constructor(private readonly cfg: BotConfig) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.step(), 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  onPoly(p: PolySnapshot): void {
    this.lastPoly = p;
  }

  onFeatures(f: FeatureSnapshot, regime: Regime): void {
    this.lastFeatures = f;
    this.currentRegime = regime;
  }

  submit(intent: QuoteIntent): SimOrder {
    const latency = this.cfg.paperLatencyMs;
    const now = Date.now();
    const order: SimOrder = {
      ...intent,
      filledSize: 0,
      status: 'pending',
      lastUpdate: now,
      submittedAt: now,
      visibleAfter: now + latency,
      simQueuePos: 1 + Math.random() * 3, // fictional queue position
    };
    this.orders.set(intent.quoteId, order);
    this.emit('submitted', order);
    return order;
  }

  cancel(quoteId: string): boolean {
    const o = this.orders.get(quoteId);
    if (!o) return false;
    o.status = 'cancelled';
    o.lastUpdate = Date.now();
    this.orders.delete(quoteId);
    this.emit('cancelled', o);
    return true;
  }

  cancelAll(): number {
    let n = 0;
    for (const o of [...this.orders.values()]) {
      this.cancel(o.quoteId);
      n++;
    }
    return n;
  }

  activeOrders(): SimOrder[] {
    return [...this.orders.values()];
  }

  private step(): void {
    if (!this.lastPoly || !this.lastFeatures) return;
    const now = Date.now();
    const f = this.lastFeatures;
    for (const o of [...this.orders.values()]) {
      if (now < o.visibleAfter) continue;
      if (o.status !== 'pending' && o.status !== 'live' && o.status !== 'partial') continue;
      o.status = o.status === 'pending' ? 'live' : o.status;

      // expiry
      if (now - o.submittedAt > this.cfg.orderMaxAgeMs * 3) {
        o.status = 'expired';
        o.lastUpdate = now;
        this.orders.delete(o.quoteId);
        this.emit('expired', o);
        continue;
      }

      const fillProb = this.computeFillProb(o, f);
      if (Math.random() < fillProb) {
        const remaining = o.sizeUsdc - o.filledSize;
        const partial = Math.random() < this.cfg.paperPartialFillProb;
        const fillSize = partial ? remaining * (0.2 + Math.random() * 0.6) : remaining;
        const slippageBps = this.cfg.paperSlippageBps * (0.5 + Math.random());
        const slippage = slippageBps / 10_000;
        // slippage penalizes the fill price against us
        const signedSlip = o.side === 'BUY' ? slippage : -slippage;
        const filledPrice = Math.max(0.01, Math.min(0.99, o.price + signedSlip));
        const fee = (fillSize * filledPrice * this.cfg.paperMakerFeeBps) / 10_000;
        o.filledSize += fillSize;
        const fill: Fill = {
          id: newFillId(),
          ts: Date.now(),
          orderId: o.exchangeOrderId ?? o.quoteId,
          conditionId: f.conditionId,
          asset: f.asset,
          interval: f.interval,
          token: o.token,
          side: o.side,
          price: filledPrice,
          size: fillSize,
          notional: fillSize * filledPrice,
          feeUsdc: fee,
          regime: this.currentRegime,
          fairAtFill: f.fairYes ?? f.midYes ?? filledPrice,
          midAtFill: f.midYes ?? filledPrice,
          isMaker: true,
          latencyMs: this.cfg.paperLatencyMs,
          mode: 'paper',
        };
        if (o.filledSize + 0.01 >= o.sizeUsdc) {
          o.status = 'filled';
          this.orders.delete(o.quoteId);
        } else {
          o.status = 'partial';
        }
        o.lastUpdate = Date.now();
        this.emit('fill', fill, o);
      }
    }
  }

  private computeFillProb(o: SimOrder, f: FeatureSnapshot): number {
    const base = this.cfg.paperFillProbBase;
    // regime multipliers
    const rm: Record<Regime, number> = {
      low_vol_balanced: 1.0,
      low_vol_directional: 1.2,
      medium_vol: 1.4,
      high_vol_chop: 1.6,
      high_vol_trend: 2.0,
    };
    const regMul = rm[this.currentRegime] ?? 1;

    // distance to mid (favorable = closer to being touched)
    const mid = f.midYes ?? 0.5;
    const dist = Math.abs(o.price - mid);
    const distBps = dist * 10_000;

    // If on bid, we fill when market moves down to us; closer distance = more likely.
    const distPenalty = Math.exp(-distBps / 60); // 60bps scale

    // toxicity multiplier: informed flow preferentially fills us at worse prices
    const toxMul = 1 + 0.8 * (f.toxicFlowProxy - this.cfg.paperToxicityBaseline);

    // liquidity mult: thin book => more unpredictable fills
    const liqMul = 0.6 + 0.8 * clamp01(f.liquidityScore);

    // queue position penalty
    const queueMul = 1 / (0.5 + o.simQueuePos);

    // convert to per-250ms prob
    const perTickBase = 1 - Math.pow(1 - base * regMul * distPenalty * toxMul * liqMul * queueMul, 0.25);
    return Math.min(0.5, Math.max(0, perTickBase));
  }
}
