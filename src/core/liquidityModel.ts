import { OrderBook } from '../types';
import { clamp01 } from '../utils/math';

/**
 * Liquidity quality scoring and book-sparsity/fake-stability detection.
 */
export class LiquidityModel {
  /** 0..1 quality; higher = better */
  qualityScore(book: OrderBook): number {
    const bids = book.bids.slice(0, 5);
    const asks = book.asks.slice(0, 5);
    if (bids.length === 0 || asks.length === 0) return 0;
    const topDepth = (bids[0]?.size ?? 0) + (asks[0]?.size ?? 0);
    const totalDepth = bids.reduce((s, l) => s + l.size, 0) + asks.reduce((s, l) => s + l.size, 0);
    const depthScore = clamp01(Math.log10(1 + totalDepth) / 4);
    const spread = asks[0].price - bids[0].price;
    const spreadScore = clamp01(1 - spread / 0.04);
    const balance = topDepth > 0 ? 1 - Math.abs(bids[0].size - asks[0].size) / topDepth : 0;
    return clamp01(0.5 * depthScore + 0.3 * spreadScore + 0.2 * balance);
  }

  isSparse(book: OrderBook): boolean {
    const bids = book.bids.slice(0, 3);
    const asks = book.asks.slice(0, 3);
    if (bids.length < 2 || asks.length < 2) return true;
    const totalDepth = bids.reduce((s, l) => s + l.size, 0) + asks.reduce((s, l) => s + l.size, 0);
    return totalDepth < 50;
  }

  /** detect "fake stability": price moving with near-zero visible size */
  fakeStability(book: OrderBook, recentMoveBps: number): boolean {
    const total = book.bids.slice(0, 3).reduce((s, l) => s + l.size, 0) + book.asks.slice(0, 3).reduce((s, l) => s + l.size, 0);
    return Math.abs(recentMoveBps) > 20 && total < 20;
  }
}
