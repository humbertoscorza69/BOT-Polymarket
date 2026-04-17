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
import { InventoryEngine } from './inventoryEngine';

const log = getLogger('order-manager');

export interface OrderManagerOpts {
  mode: 'dry_run' | 'paper' | 'live';
  cfg: BotConfig;
  paper?: PaperTrader;
  clob?: ClobDriver;
  inventory?: InventoryEngine;
  getPolySnapshot?: () => import('../types').PolySnapshot | null;
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
  private cancelling = false;

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
      // B2: Reset inventory on market rotation
      if (this.opts.inventory && this.market) {
        const { residualUsdc } = this.opts.inventory.reset();
        if (Math.abs(residualUsdc) > 0.5) {
          log.warn('[ROTATION] residual position from old market — not tracked post-rotation', { residualUsdc: residualUsdc.toFixed(2) });
        }
        log.info('[ROTATION] inventory reset — old market positions zeroed');
      }
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
    if (this.cancelling) return;
    if (!this.market) return;
    if (q.mode === 'blocked') {
      await this.cancelAll(q.blockedReason ?? 'blocked');
      return;
    }

    const want: Array<{ side: 'BUY' | 'SELL'; token: 'YES' | 'NO'; price: number; sizeShares: number; tokenId: string }> = [];
    if (q.yesBid !== null && q.yesBidSize > 0) {
      want.push({ side: 'BUY', token: 'YES', price: q.yesBid, sizeShares: q.yesBidSize, tokenId: this.market.yesTokenId });
    }
    if (q.yesAsk !== null && q.yesAskSize > 0) {
      want.push({ side: 'SELL', token: 'YES', price: q.yesAsk, sizeShares: q.yesAskSize, tokenId: this.market.yesTokenId });
    }
    if (q.noBid !== null && q.noBidSize > 0) {
      want.push({ side: 'BUY', token: 'NO', price: q.noBid, sizeShares: q.noBidSize, tokenId: this.market.noTokenId });
    }
    if (q.noAsk !== null && q.noAskSize > 0) {
      want.push({ side: 'SELL', token: 'NO', price: q.noAsk, sizeShares: q.noAskSize, tokenId: this.market.noTokenId });
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
    sizeShares: number;
    tokenId: string;
  }): Promise<void> {
    // B1: Pre-trade inventory cap check (USDC notional + per-side share cap)
    if (this.opts.inventory && w.side === 'BUY') {
      const sizeUsdc = w.price * w.sizeShares;
      if (!this.opts.inventory.canAccumulate(w.token, sizeUsdc, w.sizeShares)) {
        log.warn('[INVENTORY] blocked order — would exceed cap', { side: w.side, token: w.token, sizeUsdc: sizeUsdc.toFixed(2), sizeShares: w.sizeShares });
        return;
      }
    }

    // SELL gate: block or clamp SELL orders against current position
    if (this.opts.inventory && w.side === 'SELL') {
      const pos = w.token === 'YES'
        ? this.opts.inventory.state.yesPosition
        : this.opts.inventory.state.noPosition;
      if (pos <= 0) {
        log.warn('[INVENTORY] blocked SELL — no position to sell', { token: w.token, position: pos });
        return;
      }
      if (w.sizeShares > pos) {
        log.info('[INVENTORY] clamped SELL size to current position', {
          token: w.token, from: w.sizeShares.toFixed(4), to: pos.toFixed(4),
        });
        w.sizeShares = pos;
      }
    }

    // H3: Post-only guard — prevent crossing the book
    if (this.opts.getPolySnapshot) {
      const snap = this.opts.getPolySnapshot();
      if (snap) {
        const book = w.token === 'YES' ? snap.yesBook : snap.noBook;
        if (w.side === 'BUY' && book.asks.length > 0 && w.price >= book.asks[0].price) {
          log.warn('[POST-ONLY] buy would cross ask — skipping', { buyPrice: w.price, bestAsk: book.asks[0].price, token: w.token });
          return;
        }
        if (w.side === 'SELL' && book.bids.length > 0 && w.price <= book.bids[0].price) {
          log.warn('[POST-ONLY] sell would cross bid — skipping', { sellPrice: w.price, bestBid: book.bids[0].price, token: w.token });
          return;
        }
      }
    }

    const intent: QuoteIntent = {
      side: w.side,
      token: w.token,
      price: w.price,
      sizeShares: w.sizeShares,
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
        const r = await this.opts.clob.placeOrder({
          tokenId: w.tokenId,
          side: w.side,
          price: w.price,
          size: w.sizeShares,
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
    this.cancelling = true;
    try {
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
    } finally {
      this.cancelling = false;
    }
  }
}
