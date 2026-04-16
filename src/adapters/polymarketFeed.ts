import EventEmitter from 'eventemitter3';
import WebSocket from 'ws';
import { BotConfig } from '../config';
import {
  BookLevel,
  OrderBook,
  PolySnapshot,
  PolymarketMarket,
} from '../types';
import { getLogger } from '../utils/logger';
import { Backoff, sleep } from '../utils/retry';
import { RollingWindow } from '../utils/stats';
import { clamp01, safeDivide } from '../utils/math';
import { nowSec } from '../utils/time';

const log = getLogger('polymarket.feed');

interface RawBookMsg {
  event_type?: string;
  market?: string;
  asset_id?: string;
  hash?: string;
  timestamp?: string;
  buys?: Array<{ price: string; size: string }>;
  sells?: Array<{ price: string; size: string }>;
  changes?: Array<{ asset_id?: string; price: string; side: string; size: string }>;
  price_changes?: Array<{ asset_id?: string; price: string; side: string; size: string; hash?: string; best_bid?: string; best_ask?: string }>;
  price?: string;
  side?: string;
  size?: string;
}

function parseBookLevels(arr: Array<{ price: string; size: string }> | undefined): BookLevel[] {
  if (!arr) return [];
  const out: BookLevel[] = [];
  for (const x of arr) {
    const p = parseFloat(x.price);
    const s = parseFloat(x.size);
    if (Number.isFinite(p) && Number.isFinite(s) && s > 0) out.push({ price: p, size: s });
  }
  return out;
}

function sortBook(book: OrderBook): void {
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
}

function mergeChange(book: OrderBook, side: string, price: number, size: number): void {
  const arr = side === 'BUY' ? book.bids : book.asks;
  const idx = arr.findIndex((l) => l.price === price);
  if (size <= 0) {
    if (idx >= 0) arr.splice(idx, 1);
  } else if (idx >= 0) {
    arr[idx].size = size;
  } else {
    arr.push({ price, size });
  }
  sortBook(book);
}

interface InternalBookState {
  yesBook: OrderBook;
  noBook: OrderBook;
  lastUpdateTs: number;
}

export class PolymarketFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private market: PolymarketMarket | null = null;
  private state: InternalBookState = {
    yesBook: { bids: [], asks: [], ts: 0 },
    noBook: { bids: [], asks: [], ts: 0 },
    lastUpdateTs: 0,
  };
  private running = false;
  private reconnectBackoff: Backoff;
  private reconnectCount = 0;
  private staleTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private midHistory = new RollingWindow(120);
  private lastSnapshot: PolySnapshot | null = null;
  private msgCount = 0;

  constructor(private readonly cfg: BotConfig) {
    super();
    this.reconnectBackoff = new Backoff(cfg.polyReconnectMinMs, cfg.polyReconnectMaxMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop().catch((e) => log.error('loop fatal', { err: String(e) }));
    this.staleTimer = setInterval(() => this.checkStale(), 1000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  setMarket(m: PolymarketMarket | null): void {
    if (!m) {
      this.market = null;
      this.resetBooks();
      return;
    }
    if (this.market && this.market.conditionId === m.conditionId) return;
    log.info('setMarket', { slug: m.slug, cond: m.conditionId });
    this.market = m;
    this.resetBooks();
    // Reconnect websocket to subscribe to new tokens
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private resetBooks(): void {
    this.state = {
      yesBook: { bids: [], asks: [], ts: 0 },
      noBook: { bids: [], asks: [], ts: 0 },
      lastUpdateTs: 0,
    };
    this.midHistory.clear();
  }

  get reconnects(): number {
    return this.reconnectCount;
  }

  getSnapshot(): PolySnapshot | null {
    return this.lastSnapshot;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.market) {
          await sleep(500);
          continue;
        }
        await this.connect();
      } catch (e) {
        log.warn('ws loop error', { err: String(e) });
      }
      if (!this.running) break;
      const wait = this.reconnectBackoff.next();
      log.info('reconnecting', { waitMs: wait });
      await sleep(wait);
    }
  }

  private async connect(): Promise<void> {
    if (!this.market) return;
    const url = this.cfg.polymarketWs;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('ws connect timeout'));
      }, 10_000);

      ws.on('open', () => {
        clearTimeout(timer);
        this.reconnectBackoff.reset();
        try {
          const assetsIds = [this.market!.yesTokenId, this.market!.noTokenId].filter(Boolean);
          const sub = {
            type: 'market',
            assets_ids: assetsIds,
            initial_dump: true,
          };
          ws.send(JSON.stringify(sub));
          log.info('ws subscribed', { assets: assetsIds.length });
        } catch (e) {
          log.warn('ws subscribe failed', { err: String(e) });
        }
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send('PING');
            }
          } catch { /* ignore */ }
        }, 10_000);
      });

      ws.on('message', (data) => {
        try {
          const text = data.toString();
          if (text === 'PONG') return;
          this.msgCount++;
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            for (const msg of parsed) this.handleMessage(msg as RawBookMsg);
          } else {
            this.handleMessage(parsed as RawBookMsg);
          }
          if (this.msgCount <= 3) {
            log.info('ws message', { eventType: parsed?.event_type ?? (Array.isArray(parsed) ? 'array' : 'object'), msgCount: this.msgCount });
          }
        } catch (e) {
          log.debug('bad message', { err: String(e) });
        }
      });

      ws.on('error', (err) => {
        log.warn('ws error', { err: String(err) });
      });

      ws.on('close', () => {
        this.reconnectCount += 1;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleMessage(msg: RawBookMsg): void {
    if (!msg || !this.market) return;
    const t = msg.event_type ?? '';

    if (t === 'book' || msg.buys || msg.sells) {
      const assetId = msg.asset_id ?? '';
      const isYes = assetId === this.market.yesTokenId;
      const isNo = assetId === this.market.noTokenId;
      if (!isYes && !isNo) return;
      const book = isYes ? this.state.yesBook : this.state.noBook;
      const buys = parseBookLevels(msg.buys);
      const sells = parseBookLevels(msg.sells);
      book.bids = buys;
      book.asks = sells;
      sortBook(book);
      book.ts = Date.now();
      this.state.lastUpdateTs = Date.now();
      this.recompute();
    } else if (t === 'price_change') {
      const changes = msg.price_changes ?? msg.changes;
      if (!Array.isArray(changes)) return;
      for (const ch of changes) {
        const assetId = ch.asset_id ?? msg.asset_id ?? '';
        const isYes = assetId === this.market.yesTokenId;
        const isNo = assetId === this.market.noTokenId;
        if (!isYes && !isNo) continue;
        const book = isYes ? this.state.yesBook : this.state.noBook;
        const p = parseFloat(ch.price);
        const s = parseFloat(ch.size);
        const side = (ch.side ?? '').toUpperCase();
        if (Number.isFinite(p)) mergeChange(book, side === 'BUY' ? 'BUY' : 'SELL', p, Number.isFinite(s) ? s : 0);
      }
      this.state.lastUpdateTs = Date.now();
      this.recompute();
    } else if (t === 'tick_size_change') {
    }
  }

  private recompute(): void {
    if (!this.market) return;
    const yes = this.state.yesBook;
    const bestBid = yes.bids[0] ?? null;
    const bestAsk = yes.asks[0] ?? null;

    const mid =
      bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : bestBid ? bestBid.price : bestAsk ? bestAsk.price : null;
    const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : null;

    let micro: number | null = null;
    if (bestBid && bestAsk) {
      const denom = bestBid.size + bestAsk.size;
      micro = denom > 0 ? (bestBid.price * bestAsk.size + bestAsk.price * bestBid.size) / denom : mid;
    } else {
      micro = mid;
    }

    // top level imbalance
    const topImbal =
      bestBid && bestAsk
        ? safeDivide(bestBid.size - bestAsk.size, bestBid.size + bestAsk.size, 0)
        : 0;

    // depth-5 imbalance
    const sumBids = yes.bids.slice(0, 5).reduce((s, l) => s + l.size, 0);
    const sumAsks = yes.asks.slice(0, 5).reduce((s, l) => s + l.size, 0);
    const depthImbal = safeDivide(sumBids - sumAsks, sumBids + sumAsks, 0);

    if (mid !== null) this.midHistory.push(mid);

    const age = Date.now() - this.state.lastUpdateTs;
    const stale = age > this.cfg.freshnessPolyMaxStaleMs;

    const snap: PolySnapshot = {
      market: this.market,
      yesBook: { ...yes, bids: yes.bids.slice(0, 20), asks: yes.asks.slice(0, 20) },
      noBook: { ...this.state.noBook, bids: this.state.noBook.bids.slice(0, 20), asks: this.state.noBook.asks.slice(0, 20) },
      bestBidYes: bestBid?.price ?? null,
      bestAskYes: bestAsk?.price ?? null,
      midYes: mid,
      microYes: micro,
      spreadYes: spread,
      topImbalance: clamp01(topImbal * 0.5 + 0.5) * 2 - 1,
      depthImbalance: clamp01(depthImbal * 0.5 + 0.5) * 2 - 1,
      feedAgeMs: age,
      lastUpdateTs: this.state.lastUpdateTs,
      stale,
    };

    this.lastSnapshot = snap;
    this.emit('snapshot', snap);
  }

  private checkStale(): void {
    if (!this.lastSnapshot) return;
    const age = Date.now() - this.state.lastUpdateTs;
    const stale = age > this.cfg.freshnessPolyMaxStaleMs;
    if (stale !== this.lastSnapshot.stale) {
      this.lastSnapshot = { ...this.lastSnapshot, stale, feedAgeMs: age };
      this.emit('snapshot', this.lastSnapshot);
      if (stale) this.emit('stale');
    }
    // preserve current time info
    if (!stale) {
      this.lastSnapshot = { ...this.lastSnapshot, feedAgeMs: age };
    }
  }

  // expose minute-age helper for health
  midHistorySize(): number {
    return this.midHistory.size();
  }

  // compute rolling volatility in bps on the probability mid (1 unit = 1.0)
  volBps(): number {
    const vals = this.midHistory.values();
    if (vals.length < 5) return 0;
    let sumAbs = 0;
    for (let i = 1; i < vals.length; i++) sumAbs += Math.abs(vals[i] - vals[i - 1]);
    const avgMove = sumAbs / (vals.length - 1);
    return avgMove * 10_000;
  }

  moveBps(): number {
    const last = this.midHistory.last();
    const first = this.midHistory.first();
    if (last === null || first === null) return 0;
    return (last - first) * 10_000;
  }

  // expose expiry countdown convenience
  timeToExpirySec(): number {
    if (!this.market) return 0;
    return Math.max(0, this.market.endDateTs - nowSec());
  }
}
