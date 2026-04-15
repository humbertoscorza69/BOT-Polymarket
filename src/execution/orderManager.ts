import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import {
  ActiveOrder,
  Fill,
  PolymarketMarket,
  QuoteIntent,
  QuoteResult,
} from '../types';
import { getLogger } from '../utils/logger';
import { newQuoteId } from '../utils/ids';
import { PaperTrader } from '../core/paperTrader';
import { ClobDriver } from './clobDriver';

const log = getLogger('order-manager');

export interface OrderManagerOpts {
  mode: 'dry_run' | 'paper' | 'live';
  cfg: BotConfig;
  paper?: PaperTrader;
  clob?: ClobDriver;
}

/**
 * OrderManager is the single place where quotes become orders.
 * Tracks active order map, drift, age, partial fills, duplicate protection,
 * and integrates with the preemptive cancel coordinator.
 */
export class OrderManager extends EventEmitter {
  private active: Map<string, ActiveOrder> = new Map();
  private rejections = 0;
  private replaceCount = 0;
  private market: PolymarketMarket | null = null;

  constructor(private readonly opts: OrderManagerOpts) {
    super();
    if (opts.paper) {
      opts.paper.on('fill', (fill: Fill, order: ActiveOrder) => {
        const existing = this.active.get(order.quoteId);
        if (existing) {
          existing.filledSize = order.filledSize;
          existing.status = order.status as ActiveOrder['status'];
          existing.lastUpdate = Date.now();
        }
        this.emit('fill', fill, order);
      });
      opts.paper.on('cancelled', (order: ActiveOrder) => {
        this.active.delete(order.quoteId);
        this.emit('cancelled', order);
      });
      opts.paper.on('expired', (order: ActiveOrder) => {
        this.active.delete(order.quoteId);
        this.emit('expired', order);
      });
    }
  }

  setMarket(m: PolymarketMarket | null): void {
    if (this.market?.conditionId !== m?.conditionId) {
      this.cancelAll('market_rotation').catch(() => { /* ignore */ });
    }
    this.market = m;
  }

  getActive(): ActiveOrder[] {
    return [...this.active.values()];
  }

  getRejectionsCount(): number {
    return this.rejections;
  }

  getReplaceCount(): number {
    return this.replaceCount;
  }

  async applyQuote(q: QuoteResult): Promise<void> {
    if (!this.market) return;
    if (q.mode === 'blocked') {
      // cancel everything since we can't quote
      await this.cancelAll(q.blockedReason ?? 'blocked');
      return;
    }

    const want: Array<{ side: 'BUY' | 'SELL'; token: 'YES' | 'NO'; price: number; sizeUsdc: number; tokenId: string }> = [];
    if (q.yesBid !== null && q.yesBidSize > 0) {
      want.push({ side: 'BUY', token: 'YES', price: q.yesBid, sizeUsdc: q.yesBidSize, tokenId: this.market.yesTokenId });
    }
    if (q.yesAsk !== null && q.yesAskSize > 0) {
      want.push({ side: 'SELL', token: 'YES', price: q.yesAsk, sizeUsdc: q.yesAskSize, tokenId: this.market.yesTokenId });
    }
    if (q.noBid !== null && q.noBidSize > 0) {
      want.push({ side: 'BUY', token: 'NO', price: q.noBid, sizeUsdc: q.noBidSize, tokenId: this.market.noTokenId });
    }
    if (q.noAsk !== null && q.noAskSize > 0) {
      want.push({ side: 'SELL', token: 'NO', price: q.noAsk, sizeUsdc: q.noAskSize, tokenId: this.market.noTokenId });
    }

    // match existing orders by (token, side); either keep, replace, or cancel
    const existingBySide = new Map<string, ActiveOrder>();
    for (const o of this.active.values()) {
      existingBySide.set(`${o.token}:${o.side}`, o);
    }

    // cancel any existing that aren't wanted
    const wantedKeys = new Set(want.map((w) => `${w.token}:${w.side}`));
    for (const [k, o] of existingBySide.entries()) {
      if (!wantedKeys.has(k)) await this.cancel(o.quoteId, 'no_longer_wanted');
    }

    // place or replace for each wanted
    for (const w of want) {
      const key = `${w.token}:${w.side}`;
      const existing = existingBySide.get(key);
      if (!existing) {
        await this.place(w);
        continue;
      }
      const driftBps = Math.abs(existing.price - w.price) * 10_000;
      const ageMs = Date.now() - existing.createdAt;
      if (driftBps > this.opts.cfg.orderReplaceDriftBps || ageMs > this.opts.cfg.orderMaxAgeMs) {
        await this.cancel(existing.quoteId, 'replace');
        await this.place(w);
        this.replaceCount += 1;
      }
    }
  }

  private async place(w: {
    side: 'BUY' | 'SELL';
    token: 'YES' | 'NO';
    price: number;
    sizeUsdc: number;
    tokenId: string;
  }): Promise<void> {
    const intent: QuoteIntent = {
      side: w.side,
      token: w.token,
      price: w.price,
      sizeUsdc: w.sizeUsdc,
      tokenId: w.tokenId,
      postOnly: this.opts.cfg.orderPostOnly,
      quoteId: newQuoteId(),
      createdAt: Date.now(),
    };

    try {
      if (this.opts.mode === 'paper' || this.opts.mode === 'dry_run') {
        if (!this.opts.paper) throw new Error('paper trader missing');
        const active = this.opts.paper.submit(intent);
        this.active.set(intent.quoteId, active);
        this.emit('placed', active);
      } else if (this.opts.mode === 'live') {
        if (!this.opts.clob || !this.opts.clob.isAvailable) throw new Error('clob driver unavailable');
        const shares = w.sizeUsdc / Math.max(0.02, w.price);
        const r = await this.opts.clob.placeOrder({
          tokenId: w.tokenId,
          side: w.side,
          price: w.price,
          size: shares,
          postOnly: this.opts.cfg.orderPostOnly,
        });
        if (!r.success) {
          this.rejections += 1;
          log.warn('order rejected', { err: r.errorMsg });
          return;
        }
        const active: ActiveOrder = {
          ...intent,
          exchangeOrderId: r.orderId,
          filledSize: 0,
          status: 'live',
          lastUpdate: Date.now(),
        };
        this.active.set(intent.quoteId, active);
        this.emit('placed', active);
      }
    } catch (e) {
      log.warn('place failed', { err: String(e) });
      this.rejections += 1;
    }
  }

  async cancel(quoteId: string, reason: string): Promise<boolean> {
    const o = this.active.get(quoteId);
    if (!o) return false;
    try {
      if (this.opts.mode === 'paper' || this.opts.mode === 'dry_run') {
        if (this.opts.paper) this.opts.paper.cancel(quoteId);
      } else if (this.opts.mode === 'live') {
        if (this.opts.clob && o.exchangeOrderId) await this.opts.clob.cancelOrder(o.exchangeOrderId);
      }
      this.active.delete(quoteId);
      this.emit('cancelled', o, reason);
      return true;
    } catch (e) {
      log.warn('cancel failed', { err: String(e), quoteId });
      return false;
    }
  }

  async cancelAll(reason: string): Promise<number> {
    let n = 0;
    for (const o of [...this.active.values()]) {
      const ok = await this.cancel(o.quoteId, reason);
      if (ok) n += 1;
    }
    if (this.opts.mode === 'live' && this.opts.clob?.isAvailable) {
      try {
        await this.opts.clob.cancelAll();
      } catch (e) {
        log.warn('live cancelAll failed', { err: String(e) });
      }
    }
    return n;
  }
}
