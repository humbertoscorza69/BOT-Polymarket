import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import {
  BinanceSnapshot,
  OrderBook,
  PolySnapshot,
  PolymarketMarket,
} from '../types';
import { getLogger } from '../utils/logger';
import { clamp } from '../utils/math';

const log = getLogger('sim.feed');

/**
 * Synthetic feed for DATA_SOURCE=sim. Generates a drifting mean-reverting
 * probability process plus a Binance-like underlying.
 */
export class SimFeed extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private market: PolymarketMarket | null = null;
  private prob = 0.5;
  private bin = 50000;
  private vol = 0.0005;
  private tick = 500;
  private lastTs = Date.now();

  constructor(private readonly cfg: BotConfig) {
    super();
  }

  setMarket(m: PolymarketMarket): void {
    this.market = m;
    this.prob = 0.48 + Math.random() * 0.04;
    log.info('sim feed set market', { slug: m.slug });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tickStep(), this.tick);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tickStep(): void {
    if (!this.market) return;
    // mean-reverting random walk around 0.5
    const drift = (0.5 - this.prob) * 0.02;
    const shock = (Math.random() - 0.5) * this.vol * 50;
    this.prob = clamp(this.prob + drift + shock, 0.02, 0.98);

    const spreadHalf = 0.004 + Math.random() * 0.003;
    const bb = clamp(this.prob - spreadHalf, 0.01, 0.99);
    const ba = clamp(this.prob + spreadHalf, 0.01, 0.99);
    const bbSize = 50 + Math.random() * 200;
    const baSize = 50 + Math.random() * 200;

    const yesBook: OrderBook = {
      bids: [
        { price: bb, size: bbSize },
        { price: bb - 0.005, size: bbSize * 1.2 },
        { price: bb - 0.01, size: bbSize * 2 },
      ],
      asks: [
        { price: ba, size: baSize },
        { price: ba + 0.005, size: baSize * 1.2 },
        { price: ba + 0.01, size: baSize * 2 },
      ],
      ts: Date.now(),
    };
    const noBook: OrderBook = {
      bids: yesBook.asks.map((l) => ({ price: 1 - l.price, size: l.size })),
      asks: yesBook.bids.map((l) => ({ price: 1 - l.price, size: l.size })),
      ts: Date.now(),
    };

    const mid = (bb + ba) / 2;
    const micro = (bb * baSize + ba * bbSize) / (bbSize + baSize);

    const snap: PolySnapshot = {
      market: this.market,
      yesBook,
      noBook,
      bestBidYes: bb,
      bestAskYes: ba,
      midYes: mid,
      microYes: micro,
      spreadYes: ba - bb,
      topImbalance: (bbSize - baSize) / (bbSize + baSize),
      depthImbalance: 0.05 * (Math.random() - 0.5),
      feedAgeMs: 0,
      lastUpdateTs: Date.now(),
      stale: false,
    };

    this.emit('polySnapshot', snap);

    // binance sim
    this.bin *= 1 + (Math.random() - 0.5) * 0.0008;
    const bSnap: BinanceSnapshot = {
      symbol: 'SIMUSDT',
      bestBid: this.bin - 0.5,
      bestAsk: this.bin + 0.5,
      mid: this.bin,
      bookImbalance: (Math.random() - 0.5) * 0.4,
      aggressorRatio: (Math.random() - 0.5) * 0.3,
      priceVelocityBps: (Math.random() - 0.5) * 8,
      volumeRatio: 0.8 + Math.random() * 0.6,
      bidWall: null,
      askWall: null,
      lastTradeTs: Date.now(),
      feedAgeMs: 0,
      stale: false,
      available: true,
    };
    this.emit('binanceSnapshot', bSnap);
    this.lastTs = Date.now();
  }
}
