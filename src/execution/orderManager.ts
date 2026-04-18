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
  /** Invoked with exchangeOrderId BEFORE the cancel API request is sent,
   *  so the fill detector doesn't mis-classify a cancel as a fill
   *  between the API call and the 'cancelled' event emission. */
  onBeforeCancel?: (exchangeOrderId: string) => void;
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
  private lastSellBlockLogTs = 0;

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
      // Reset inventory on market rotation
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

  /** Remove an order from the active map (e.g., after live fill detection). */
  removeActive(quoteId: string): void {
    this.active.delete(quoteId);
  }

  /**
   * POL-35-K tick rounding. Exposed so pair-edge validation can use the
   * POST-round prices (what actually reaches the exchange), not the raw
   * computed prices. Direction:
   *   - Maker BUY: floor (stays below ask → remains maker)
   *   - Maker SELL: ceil (stays above bid → remains maker)
   *   - Taker/flatten: nearest (accept either direction)
   * Then clamps to [tick, 1-tick] and snaps to 4 decimals for float safety.
   */
  private roundToTick(price: number, side: 'BUY' | 'SELL', taker: boolean): number {
    const tick = this.opts.cfg.tickSize;
    // Guard explicitly for undefined/NaN — `NaN <= 0` is false so a naive
    // `tick <= 0` check falls through and the arithmetic below produces NaN.
    if (!Number.isFinite(tick) || tick <= 0) return price;
    // Integer-tick math with epsilon. Division like `0.46 / 0.01` yields
    // 45.99999... in IEEE 754, so `Math.floor` would drop a full tick down
    // to 0.45. Multiplying by an integer tick count (100 for tick=0.01) plus
    // a tiny epsilon snaps near-integer artifacts onto the right cell.
    const ticksPerUnit = Math.round(1 / tick);
    const scaled = price * ticksPerUnit;
    const EPS = 1e-9;
    let tickIdx: number;
    if (taker) tickIdx = Math.round(scaled);
    else if (side === 'BUY') tickIdx = Math.floor(scaled + EPS);
    else tickIdx = Math.ceil(scaled - EPS);
    let rounded = tickIdx / ticksPerUnit;
    rounded = Math.max(tick, Math.min(1 - tick, rounded));
    return Math.round(rounded * 10_000) / 10_000;
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

    // POL-35-L + CHECK-3: Pair-edge validation using POST-ROUND prices.
    // We simulate the tick-rounding that place() will apply (including the
    // SELL→BUY-NO conversion path) so the check validates what actually
    // reaches the exchange — not the pre-round computed values. Without
    // post-round validation, a pair that passes at 210 bps could hit the
    // exchange at 110 bps after both sides round inward by half a tick.
    const inv = this.opts.inventory?.state;
    const buyYesRaw = want.find((w) => w.side === 'BUY' && w.token === 'YES')?.price;
    const buyYesRounded = buyYesRaw !== undefined ? this.roundToTick(buyYesRaw, 'BUY', false) : undefined;

    const directBuyNoRaw = want.find((w) => w.side === 'BUY' && w.token === 'NO')?.price;
    const directBuyNoRounded = directBuyNoRaw !== undefined ? this.roundToTick(directBuyNoRaw, 'BUY', false) : undefined;

    // SELL YES converts to BUY NO at (1 - sellPrice) when yesPosition <= 0.
    // The converted price is then floor-rounded as a BUY.
    const sellYesForConversion = want.find((w) => w.side === 'SELL' && w.token === 'YES');
    const willConvert = sellYesForConversion && (!inv || inv.yesPosition <= 0);
    const convertedBuyNoRounded = willConvert
      ? this.roundToTick(1 - sellYesForConversion.price, 'BUY', false)
      : undefined;

    const effectiveBuyNo = directBuyNoRounded ?? convertedBuyNoRounded;

    if (buyYesRounded !== undefined && effectiveBuyNo !== undefined) {
      const pairSum = buyYesRounded + effectiveBuyNo;
      const pairEdgeBps = (1 - pairSum) * 10_000;
      const minEdgeBps = this.opts.cfg.minPairEdgeBps;
      if (pairEdgeBps < minEdgeBps) {
        log.error('[PAIR-CHECK] post-round edge insufficient — skipping paired BUY YES + BUY NO', {
          yesBuy: buyYesRounded.toFixed(4),
          noBuy: effectiveBuyNo.toFixed(4),
          pairSum: pairSum.toFixed(4),
          edgeBps: pairEdgeBps.toFixed(0),
          minBps: minEdgeBps,
        });
        // Cancel any existing orders on either BUY side so we don't get stuck
        // with stale quotes at the bad pair prices. SELL YES conversion also
        // dropped. Existing SELL YES (when inv>0, no conversion) keeps.
        for (const o of this.active.values()) {
          const isBuyPair = o.side === 'BUY' && (o.token === 'YES' || o.token === 'NO');
          const isConvertingSellYes = o.side === 'SELL' && o.token === 'YES' && (!inv || inv.yesPosition <= 0);
          if (isBuyPair || isConvertingSellYes) {
            await this.cancel(o.quoteId, 'pair_edge_insufficient');
          }
        }
        return;
      }
      log.debug('[PAIR-CHECK] post-round edge ok', {
        pairSum: pairSum.toFixed(4),
        edgeBps: pairEdgeBps.toFixed(0),
      });
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
    bypassPostOnly?: boolean;
    bypassInventoryCap?: boolean;
    bypassSellConversion?: boolean;
  }): Promise<void> {
    // POL-35 VERIFY-3: safety net — refuse orders on markets whose window
    // hasn't started yet. Primary filter is in discovery, this catches any
    // edge case where a future-window market sneaks through.
    if (this.market?.windowStartTs !== undefined && this.market.windowStartTs * 1000 > Date.now()) {
      const waitSec = this.market.windowStartTs - Math.floor(Date.now() / 1000);
      log.error('[ORDER-BLOCKED] refusing order on future market', {
        slug: this.market.slug,
        windowStartsInSec: waitSec,
      });
      return;
    }

    // Pre-trade inventory cap check (USDC notional + per-side share cap)
    if (this.opts.inventory && w.side === 'BUY' && !w.bypassInventoryCap) {
      const sizeUsdc = w.price * w.sizeShares;
      if (!this.opts.inventory.canAccumulate(w.token, sizeUsdc, w.sizeShares)) {
        log.warn('[INVENTORY] blocked order — would exceed cap', { side: w.side, token: w.token, sizeUsdc: sizeUsdc.toFixed(2), sizeShares: w.sizeShares });
        return;
      }
    }

    // SELL gate: convert SELL to BUY-opposite when no position (synthetic sell),
    // or clamp SELL size to current position.
    if (this.opts.inventory && w.side === 'SELL' && !w.bypassSellConversion) {
      const pos = w.token === 'YES'
        ? this.opts.inventory.state.yesPosition
        : this.opts.inventory.state.noPosition;
      if (pos <= 0) {
        // POL-39 Fix B: Convert SELL YES → BUY NO (or SELL NO → BUY YES).
        // On Polymarket, BUY NO at price P is equivalent to SELL YES at (1-P).
        if (this.market) {
          const origToken = w.token;
          w.side = 'BUY';
          w.token = origToken === 'YES' ? 'NO' : 'YES';
          w.tokenId = origToken === 'YES' ? this.market.noTokenId : this.market.yesTokenId;
          w.price = Math.round((1 - w.price) * 100) / 100;
          // Re-check BUY inventory cap for the converted order
          const sizeUsdc = w.price * w.sizeShares;
          if (!this.opts.inventory.canAccumulate(w.token, sizeUsdc, w.sizeShares)) {
            log.warn('[SYNTHETIC] blocked — would exceed cap', { token: w.token, sizeUsdc: sizeUsdc.toFixed(2) });
            return;
          }
          log.info('[SYNTHETIC] converted SELL to BUY opposite', {
            from: `SELL ${origToken}`, to: `BUY ${w.token}`, price: w.price.toFixed(4),
          });
        } else {
          return; // no market context, can't convert
        }
      } else if (w.sizeShares > pos) {
        log.info('[INVENTORY] clamped SELL size to current position', {
          token: w.token, from: w.sizeShares.toFixed(4), to: pos.toFixed(4),
        });
        w.sizeShares = pos;
      }
    }

    // POL-35-K: Tick-size rounding. Polymarket binary markets tick at $0.01
    // by default. Rounds via the shared roundToTick helper so applyQuote's
    // pair check and this place() produce identical post-round prices.
    // Idempotent — rounding an already-rounded value is a no-op.
    w.price = this.roundToTick(w.price, w.side, Boolean(w.bypassPostOnly));

    // Post-only guard — prevent crossing the book (bypassed on flatten
    // since flatten's whole purpose is to aggressively exit).
    if (this.opts.getPolySnapshot && !w.bypassPostOnly) {
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
        // POL-35 VERIFY-1: mark cancelling BEFORE the API call to close the
        // race window where the fill detector poll could see the order
        // removed and mis-identify it as a fill.
        if (this.opts.clob && o.exchangeOrderId) {
          if (this.opts.onBeforeCancel) this.opts.onBeforeCancel(o.exchangeOrderId);
          await this.opts.clob.cancelOrder(o.exchangeOrderId);
        }
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

  /**
   * POL-35 VERIFY-7: aggressive pre-expiry flatten.
   * Stage controls price aggression:
   *   defensive  — sell YES at best-ask / NO at best-ask (passive, stay maker)
   *   aggressive — sell YES at best-bid / NO at best-bid (cross spread = taker)
   *   emergency  — sell at $0.01 (fire sale, any price above zero)
   * Bypasses post-only, inventory-cap, and SELL→BUY-opposite conversion.
   * Caller should rate-limit invocations; we place at most one order per
   * non-zero position per call.
   */
  async flatten(stage: 'defensive' | 'aggressive' | 'emergency'): Promise<number> {
    if (!this.market || !this.opts.inventory) return 0;
    const inv = this.opts.inventory.state;
    const snap = this.opts.getPolySnapshot?.() ?? null;

    const pickPrice = (token: 'YES' | 'NO'): number => {
      if (stage === 'emergency') return 0.01;
      const book = snap ? (token === 'YES' ? snap.yesBook : snap.noBook) : null;
      if (stage === 'aggressive') {
        // Cross the spread: sell at BID price (taker).
        return book?.bids[0]?.price ?? 0.01;
      }
      // Defensive: stay passive at ASK price (maker, hope for fill).
      return book?.asks[0]?.price ?? 0.99;
    };

    let placed = 0;
    if (inv.yesPosition > 0) {
      const price = pickPrice('YES');
      log.warn('[FLATTEN]', { stage, token: 'YES', price: price.toFixed(4), shares: inv.yesPosition.toFixed(2) });
      await this.place({
        side: 'SELL',
        token: 'YES',
        price,
        sizeShares: inv.yesPosition,
        tokenId: this.market.yesTokenId,
        bypassPostOnly: stage !== 'defensive',
        bypassInventoryCap: true,
        bypassSellConversion: true,
      });
      placed += 1;
    }
    if (inv.noPosition > 0) {
      const price = pickPrice('NO');
      log.warn('[FLATTEN]', { stage, token: 'NO', price: price.toFixed(4), shares: inv.noPosition.toFixed(2) });
      await this.place({
        side: 'SELL',
        token: 'NO',
        price,
        sizeShares: inv.noPosition,
        tokenId: this.market.noTokenId,
        bypassPostOnly: stage !== 'defensive',
        bypassInventoryCap: true,
        bypassSellConversion: true,
      });
      placed += 1;
    }
    return placed;
  }
}
