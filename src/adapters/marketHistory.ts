import { PolymarketMarket } from '../types';

export interface MarketHistoryEntry {
  ts: number;
  market: PolymarketMarket;
  selectedReason?: string;
}

export class MarketHistory {
  private entries: MarketHistoryEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  record(m: PolymarketMarket, reason?: string): void {
    this.entries.push({ ts: Date.now(), market: m, selectedReason: reason });
    if (this.entries.length > this.maxEntries) this.entries.shift();
  }

  all(): MarketHistoryEntry[] {
    return [...this.entries];
  }

  last(n: number): MarketHistoryEntry[] {
    return this.entries.slice(-n);
  }

  findByCondition(conditionId: string): MarketHistoryEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].market.conditionId === conditionId) return this.entries[i];
    }
    return null;
  }
}
