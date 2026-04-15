export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  async take(n = 1): Promise<void> {
    while (!this.tryTake(n)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
  }
}
