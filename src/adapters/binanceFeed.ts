import EventEmitter from 'eventemitter3';
import WebSocket from 'ws';
import { BotConfig } from '../config';
import { BinanceSnapshot } from '../types';
import { getLogger } from '../utils/logger';
import { Backoff, sleep } from '../utils/retry';
import { RollingWindow, Ema } from '../utils/stats';
import { clamp01, safeDivide } from '../utils/math';

const log = getLogger('binance.feed');

interface BookTickerMsg {
  s: string;
  b: string; // best bid
  B: string; // best bid qty
  a: string; // best ask
  A: string; // best ask qty
}

interface AggTradeMsg {
  s: string;
  p: string;
  q: string;
  m: boolean; // market maker flag; if true, buyer is maker = seller aggressor
}

interface DepthMsg {
  s?: string;
  bids?: string[][];
  asks?: string[][];
}

interface MultiplexMsg {
  stream: string;
  data: BookTickerMsg | AggTradeMsg | DepthMsg | Record<string, unknown>;
}

export class BinanceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private running = false;
  private symbol: string | null = null;
  private backoff: Backoff;
  private reconnectCount = 0;

  // state
  private bestBid: number | null = null;
  private bestAsk: number | null = null;
  private lastBookUpdate = 0;
  private lastTradeUpdate = 0;

  private priceHistory = new RollingWindow(60);
  private tradeWindow: Array<{ ts: number; price: number; qty: number; buyerMaker: boolean }> = [];
  private volumeEma = new Ema(0.08);
  private aggressorEma = new Ema(0.2);
  private velocityEma = new Ema(0.25);

  private depthBids: Array<[number, number]> = [];
  private depthAsks: Array<[number, number]> = [];

  private available = true;
  private reconnectStorm = 0;

  private lastSnapshot: BinanceSnapshot | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: BotConfig) {
    super();
    this.backoff = new Backoff(500, 15_000);
  }

  start(): void {
    if (!this.cfg.binanceEnabled) {
      log.info('binance disabled by config');
      this.available = false;
      return;
    }
    if (this.running) return;
    this.running = true;
    this.loop().catch((e) => log.error('loop fatal', { err: String(e) }));
    this.pollTimer = setInterval(() => this.recompute(), 500);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  setAsset(asset: string): void {
    const sym = this.cfg.binanceSymbolMap[asset.toUpperCase()];
    if (!sym) {
      log.warn('no binance symbol for asset', { asset });
      this.symbol = null;
      this.available = false;
      return;
    }
    if (this.symbol === sym) return;
    log.info('binance setAsset', { asset, symbol: sym });
    this.symbol = sym;
    this.available = true;
    // reset state
    this.bestBid = null;
    this.bestAsk = null;
    this.priceHistory.clear();
    this.tradeWindow = [];
    this.volumeEma.reset();
    this.aggressorEma.reset();
    this.velocityEma.reset();
    this.depthBids = [];
    this.depthAsks = [];
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  get reconnects(): number {
    return this.reconnectCount;
  }

  getSnapshot(): BinanceSnapshot | null {
    return this.lastSnapshot;
  }

  isAvailable(): boolean {
    return this.available && !!this.symbol;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.symbol) {
          await sleep(500);
          continue;
        }
        await this.connect();
      } catch (e) {
        log.warn('binance ws loop error', { err: String(e) });
      }
      if (!this.running) break;
      this.reconnectStorm += 1;
      if (this.reconnectStorm > 5) {
        log.warn('reconnect storm; cooldown 30s');
        await sleep(30_000);
        this.reconnectStorm = 0;
      }
      const wait = this.backoff.next();
      await sleep(wait);
    }
  }

  private async connect(): Promise<void> {
    if (!this.symbol) return;
    const s = this.symbol.toLowerCase();
    const streams = [`${s}@bookTicker`, `${s}@depth10@100ms`, `${s}@aggTrade`].join('/');
    const url = `${this.cfg.binanceWs}?streams=${streams}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('binance ws timeout'));
      }, 10_000);

      ws.on('open', () => {
        clearTimeout(timer);
        this.backoff.reset();
        log.info('binance ws open', { symbol: this.symbol });
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as MultiplexMsg;
          this.handle(msg);
        } catch {
          /* ignore */
        }
      });

      ws.on('error', (err) => log.warn('binance ws error', { err: String(err) }));
      ws.on('close', () => {
        this.reconnectCount += 1;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handle(msg: MultiplexMsg): void {
    if (!msg?.stream) return;
    if (msg.stream.endsWith('@bookTicker')) {
      const d = msg.data as BookTickerMsg;
      const bb = parseFloat(d.b);
      const ba = parseFloat(d.a);
      if (Number.isFinite(bb) && Number.isFinite(ba)) {
        this.bestBid = bb;
        this.bestAsk = ba;
        this.lastBookUpdate = Date.now();
      }
    } else if (msg.stream.includes('@depth')) {
      const d = msg.data as DepthMsg;
      if (Array.isArray(d.bids)) this.depthBids = d.bids.map((x) => [parseFloat(x[0]), parseFloat(x[1])]);
      if (Array.isArray(d.asks)) this.depthAsks = d.asks.map((x) => [parseFloat(x[0]), parseFloat(x[1])]);
      this.lastBookUpdate = Date.now();
    } else if (msg.stream.endsWith('@aggTrade')) {
      const d = msg.data as AggTradeMsg;
      const p = parseFloat(d.p);
      const q = parseFloat(d.q);
      if (Number.isFinite(p) && Number.isFinite(q)) {
        const now = Date.now();
        this.tradeWindow.push({ ts: now, price: p, qty: q, buyerMaker: Boolean(d.m) });
        // drop older than 10s
        const cutoff = now - 10_000;
        while (this.tradeWindow.length > 0 && this.tradeWindow[0].ts < cutoff) this.tradeWindow.shift();
        this.lastTradeUpdate = now;
        this.priceHistory.push(p);
      }
    }
  }

  private recompute(): void {
    if (!this.symbol) return;
    const mid =
      this.bestBid !== null && this.bestAsk !== null
        ? (this.bestBid + this.bestAsk) / 2
        : null;

    // book imbalance from depth
    const sumBids = this.depthBids.slice(0, 10).reduce((s, l) => s + l[1], 0);
    const sumAsks = this.depthAsks.slice(0, 10).reduce((s, l) => s + l[1], 0);
    const bookImbal = safeDivide(sumBids - sumAsks, sumBids + sumAsks, 0);

    // aggressor ratio
    let buyVol = 0;
    let sellVol = 0;
    for (const t of this.tradeWindow) {
      if (t.buyerMaker) sellVol += t.qty; // buyer is maker => seller aggressor
      else buyVol += t.qty;
    }
    const aggressorRatio = safeDivide(buyVol - sellVol, buyVol + sellVol, 0);
    this.aggressorEma.update(aggressorRatio);

    // volume EMA
    const recentVolume = this.tradeWindow.reduce((s, t) => s + t.qty, 0);
    this.volumeEma.update(recentVolume);
    const volumeRatio = safeDivide(recentVolume, Math.max(1e-9, this.volumeEma.value), 1);

    // walls: find levels with outsize size
    const bidWall = this.findWall(this.depthBids, sumBids);
    const askWall = this.findWall(this.depthAsks, sumAsks);

    // price velocity (bps per second)
    const hist = this.priceHistory.values();
    let velocityBps = 0;
    if (hist.length >= 3 && mid && mid > 0) {
      const first = hist[0];
      const last = hist[hist.length - 1];
      const secs = Math.max(1, this.tradeWindow.length > 0 ? (Date.now() - this.tradeWindow[0].ts) / 1000 : 1);
      velocityBps = ((last - first) / mid) * 10_000 / secs;
    }
    this.velocityEma.update(velocityBps);

    const now = Date.now();
    const tradeAge = now - this.lastTradeUpdate;
    const bookAge = now - this.lastBookUpdate;
    const age = Math.max(tradeAge, bookAge);
    const stale = age > this.cfg.binanceFeedStaleMs;

    const snap: BinanceSnapshot = {
      symbol: this.symbol,
      bestBid: this.bestBid,
      bestAsk: this.bestAsk,
      mid,
      bookImbalance: clamp01(bookImbal * 0.5 + 0.5) * 2 - 1,
      aggressorRatio: this.aggressorEma.value,
      priceVelocityBps: this.velocityEma.value,
      volumeRatio,
      bidWall,
      askWall,
      lastTradeTs: this.lastTradeUpdate,
      feedAgeMs: age,
      stale,
      available: this.available && !stale && this.bestBid !== null,
    };
    this.lastSnapshot = snap;
    this.emit('snapshot', snap);
  }

  private findWall(levels: Array<[number, number]>, total: number): number | null {
    if (!levels || levels.length === 0 || total <= 0) return null;
    let bestPrice: number | null = null;
    let bestSize = 0;
    for (const [p, s] of levels) {
      if (s > bestSize && s / total > 0.35) {
        bestSize = s;
        bestPrice = p;
      }
    }
    return bestPrice;
  }
}
