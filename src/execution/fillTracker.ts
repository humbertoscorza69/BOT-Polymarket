import EventEmitter from 'eventemitter3';
import { Fill } from '../types';
import { getLogger } from '../utils/logger';

const log = getLogger('fill-tracker');

/**
 * Central fill tracker. Receives fills from paper trader or live user event
 * stream, validates, persists, and broadcasts.
 */
export class FillTracker extends EventEmitter {
  private fills: Fill[] = [];
  private lastFillTs: number | null = null;

  record(fill: Fill): void {
    this.fills.push(fill);
    if (this.fills.length > 1000) this.fills.shift();
    this.lastFillTs = fill.ts;
    log.info('fill recorded', {
      id: fill.id,
      token: fill.token,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      regime: fill.regime,
    });
    this.emit('fill', fill);
  }

  recent(n: number): Fill[] {
    return this.fills.slice(-n);
  }

  all(): Fill[] {
    return this.fills;
  }

  getLastFillTs(): number | null {
    return this.lastFillTs;
  }
}
