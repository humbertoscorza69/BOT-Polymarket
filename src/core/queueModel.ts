import { BookLevel, QuoteIntent } from '../types';
import { clamp01 } from '../utils/math';

/**
 * Placeholder queue model: estimates position in queue for a given quote
 * based on top-of-book depth. Real implementation would require per-level
 * timestamping from the exchange.
 */
export class QueueModel {
  estimatePosition(intent: QuoteIntent, bookSideLevels: BookLevel[]): number {
    const price = intent.price;
    let queued = 0;
    for (const l of bookSideLevels) {
      if (l.price === price) queued += l.size;
      if (intent.side === 'BUY' && l.price > price) continue;
      if (intent.side === 'SELL' && l.price < price) continue;
    }
    return queued;
  }

  /** Probability that the quote gets the next fill at its level */
  priorityProb(queueAhead: number, typicalFillSize: number): number {
    if (queueAhead <= 0) return 1;
    return clamp01(typicalFillSize / (queueAhead + typicalFillSize));
  }
}
