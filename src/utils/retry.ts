export interface RetryOptions {
  retries: number;
  minMs: number;
  maxMs: number;
  factor: number;
  jitter: boolean;
  onAttempt?: (attempt: number, err: unknown) => void;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const o: RetryOptions = {
    retries: opts.retries ?? 4,
    minMs: opts.minMs ?? 250,
    maxMs: opts.maxMs ?? 4000,
    factor: opts.factor ?? 2,
    jitter: opts.jitter ?? true,
    onAttempt: opts.onAttempt,
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (o.onAttempt) o.onAttempt(attempt, err);
      if (attempt === o.retries) break;
      const backoff = Math.min(o.maxMs, o.minMs * Math.pow(o.factor, attempt));
      const delay = o.jitter ? Math.floor(backoff * (0.5 + Math.random())) : backoff;
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'op',
): Promise<T> {
  let to: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    to = setTimeout(() => reject(new Error(`timeout:${label}:${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (to) clearTimeout(to);
  }
}

export class Backoff {
  private attempt = 0;
  constructor(
    private readonly minMs: number,
    private readonly maxMs: number,
    private readonly factor = 2,
  ) {}

  next(): number {
    const v = Math.min(this.maxMs, this.minMs * Math.pow(this.factor, this.attempt));
    this.attempt += 1;
    return Math.floor(v * (0.5 + Math.random()));
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
