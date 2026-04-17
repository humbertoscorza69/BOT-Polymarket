import EventEmitter from 'eventemitter3';
import { ActiveOrder, Fill, Regime, Mode } from '../types';
import { ClobDriver } from './clobDriver';
import { getLogger } from '../utils/logger';
import { newFillId } from '../utils/ids';

const log = getLogger('live-fill-detector');

export interface LiveFillDetectorOpts {
  clob: ClobDriver;
  pollMs?: number;
  getActiveOrders: () => ActiveOrder[];
  getContext: () => {
    conditionId: string;
    asset: string;
    interval: string;
    regime: Regime;
    fair: number;
    mid: number;
    runId: string;
  } | null;
}

/**
 * Polls the exchange for open orders and detects fills by comparing
 * with OrderManager's active order map. When a tracked order disappears
 * from the exchange without being cancelled by us, it was filled.
 *
 * Emits 'fill' with (Fill, ActiveOrder) matching OrderManager's signature.
 */
export class LiveFillDetector extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeenIds = new Set<string>(); // exchangeOrderIds seen on previous poll
  private recentlyCancelled = new Map<string, number>(); // exchangeOrderId -> ts
  private polling = false;
  private pollCount = 0;
  private fillsDetected = 0;
  private lastTradeCheckTs = 0; // Fix 2: timestamp of last trade history check
  private processedTradeIds = new Set<string>(); // Fix 2: avoid double-counting trades

  constructor(private readonly opts: LiveFillDetectorOpts) {
    super();
  }

  /** Call when OrderManager cancels an order so we don't false-detect it as a fill. */
  notifyCancelled(exchangeOrderId: string): void {
    if (exchangeOrderId) {
      this.recentlyCancelled.set(exchangeOrderId, Date.now());
    }
  }

  start(): void {
    if (this.timer) return;
    const ms = this.opts.pollMs ?? 5000;
    log.info('[FILL-DETECT] starting live fill detector', { pollMs: ms });
    // First poll after a short delay to let bootstrap settle
    setTimeout(() => this.poll(), 2000);
    this.timer = setInterval(() => this.poll(), ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // skip if previous poll still in flight
    this.polling = true;
    try {
      if (!this.opts.clob.isAvailable) return;

      const exchangeOrders = await this.opts.clob.fetchOpenOrders();
      const exchangeIds = new Set<string>();
      for (const eo of exchangeOrders) {
        const id = String(eo.id ?? eo.orderID ?? eo.order_id ?? '');
        if (id) exchangeIds.add(id);
      }

      this.pollCount++;

      // Prune stale cancelled entries (older than 30s)
      const now = Date.now();
      for (const [id, ts] of this.recentlyCancelled) {
        if (now - ts > 30_000) this.recentlyCancelled.delete(id);
      }

      // On first poll, just establish baseline
      if (this.pollCount === 1) {
        this.lastSeenIds = exchangeIds;
        log.info('[FILL-DETECT] baseline established', { openOrders: exchangeIds.size });
        return;
      }

      // Check each active order: if it has an exchangeOrderId that was seen
      // on the previous poll but is now gone, it was filled.
      const activeOrders = this.opts.getActiveOrders();
      for (const order of activeOrders) {
        if (!order.exchangeOrderId) continue;
        const eid = order.exchangeOrderId;

        // Still on exchange — no fill
        if (exchangeIds.has(eid)) continue;

        // Not on exchange. Was it seen last poll?
        if (!this.lastSeenIds.has(eid)) continue;

        // Was it recently cancelled by us?
        if (this.recentlyCancelled.has(eid)) {
          this.recentlyCancelled.delete(eid);
          continue;
        }

        // Fill detected
        this.fillsDetected++;
        const ctx = this.opts.getContext();
        const fill = this.buildFill(order, ctx);
        log.info('[FILL-DETECT] live fill detected', {
          orderId: order.quoteId,
          exchangeOrderId: eid,
          side: order.side,
          token: order.token,
          price: order.price.toFixed(4),
          size: order.sizeShares.toFixed(2),
          totalDetected: this.fillsDetected,
        });
        this.emit('fill', fill, order);
      }

      this.lastSeenIds = exchangeIds;

      // Fix 2: Supplement with CLOB trade history to catch fills between polls
      try {
        const trades = await this.opts.clob.fetchTradeHistory();
        const activeOrders = this.opts.getActiveOrders();
        const activeByExId = new Map<string, ActiveOrder>();
        for (const o of activeOrders) {
          if (o.exchangeOrderId) activeByExId.set(o.exchangeOrderId, o);
        }

        for (const trade of trades) {
          const tradeId = String(trade.id ?? trade.tradeId ?? trade.trade_id ?? '');
          if (!tradeId || this.processedTradeIds.has(tradeId)) continue;

          const tradeTs = Number(trade.timestamp ?? trade.ts ?? trade.createdAt ?? 0);
          // Only process trades newer than our last check
          if (tradeTs > 0 && tradeTs < this.lastTradeCheckTs) continue;

          // Match trade to an active order by maker_order_id or taker_order_id
          const makerOrderId = String(trade.maker_order_id ?? trade.makerOrderId ?? '');
          const takerOrderId = String(trade.taker_order_id ?? trade.takerOrderId ?? '');

          const matchedOrder = activeByExId.get(makerOrderId) || activeByExId.get(takerOrderId);
          if (!matchedOrder) continue;

          this.processedTradeIds.add(tradeId);
          this.fillsDetected++;
          const ctx = this.opts.getContext();

          const tradeSize = Number(trade.size ?? trade.amount ?? 0);
          const tradePrice = Number(trade.price ?? 0);
          const fill = this.buildFillFromTrade(matchedOrder, tradeSize, tradePrice, ctx);

          log.info('[FILL-DETECT] trade-history fill detected', {
            tradeId,
            orderId: matchedOrder.quoteId,
            exchangeOrderId: matchedOrder.exchangeOrderId,
            side: matchedOrder.side,
            price: tradePrice.toFixed(4),
            size: tradeSize.toFixed(2),
            source: 'trade_history',
            totalDetected: this.fillsDetected,
          });
          this.emit('fill', fill, matchedOrder);
        }
        this.lastTradeCheckTs = Date.now();

        // Prune processed trade IDs to avoid unbounded growth
        if (this.processedTradeIds.size > 500) {
          const arr = [...this.processedTradeIds];
          this.processedTradeIds = new Set(arr.slice(-200));
        }
      } catch (e) {
        log.warn('[FILL-DETECT] trade history check failed (non-fatal)', { err: String(e) });
      }
    } catch (e) {
      log.warn('[FILL-DETECT] poll error (non-fatal)', { err: String(e) });
    } finally {
      this.polling = false;
    }
  }

  private buildFillFromTrade(
    order: ActiveOrder,
    tradeSize: number,
    tradePrice: number,
    ctx: { conditionId: string; asset: string; interval: string; regime: Regime; fair: number; mid: number; runId: string } | null,
  ): Fill {
    const size = tradeSize > 0 ? tradeSize : order.sizeShares - order.filledSize;
    const price = tradePrice > 0 ? tradePrice : order.price;
    return {
      id: newFillId(),
      ts: Date.now(),
      orderId: order.quoteId,
      conditionId: ctx?.conditionId ?? '',
      asset: ctx?.asset ?? '',
      interval: ctx?.interval ?? '',
      token: order.token,
      side: order.side,
      price,
      size,
      notional: price * size,
      feeUsdc: 0,
      regime: ctx?.regime ?? 'medium_vol',
      fairAtFill: ctx?.fair ?? price,
      midAtFill: ctx?.mid ?? price,
      isMaker: true,
      latencyMs: 0,
      mode: 'live' as Mode,
      runId: ctx?.runId ?? '',
    };
  }

  private buildFill(
    order: ActiveOrder,
    ctx: { conditionId: string; asset: string; interval: string; regime: Regime; fair: number; mid: number; runId: string } | null,
  ): Fill {
    const fillSize = order.sizeShares - order.filledSize; // remaining = filled amount
    const notional = order.price * fillSize;
    return {
      id: newFillId(),
      ts: Date.now(),
      orderId: order.quoteId,
      conditionId: ctx?.conditionId ?? '',
      asset: ctx?.asset ?? '',
      interval: ctx?.interval ?? '',
      token: order.token,
      side: order.side,
      price: order.price,
      size: fillSize,
      notional,
      feeUsdc: 0, // maker fee = 0 on Polymarket
      regime: ctx?.regime ?? 'medium_vol',
      fairAtFill: ctx?.fair ?? order.price,
      midAtFill: ctx?.mid ?? order.price,
      isMaker: true,
      latencyMs: 0,
      mode: 'live' as Mode,
      runId: ctx?.runId ?? '',
    };
  }
}
