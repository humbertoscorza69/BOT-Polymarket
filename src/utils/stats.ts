import { isNum } from './math';

export class RollingWindow {
  private buf: number[] = [];
  constructor(private readonly maxLen: number) {}

  push(x: number): void {
    if (!isNum(x)) return;
    this.buf.push(x);
    if (this.buf.length > this.maxLen) this.buf.shift();
  }

  values(): number[] {
    return this.buf.slice();
  }

  size(): number {
    return this.buf.length;
  }

  last(): number | null {
    return this.buf.length === 0 ? null : this.buf[this.buf.length - 1];
  }

  first(): number | null {
    return this.buf.length === 0 ? null : this.buf[0];
  }

  mean(): number {
    if (this.buf.length === 0) return 0;
    let s = 0;
    for (const v of this.buf) s += v;
    return s / this.buf.length;
  }

  std(): number {
    if (this.buf.length < 2) return 0;
    const m = this.mean();
    let acc = 0;
    for (const v of this.buf) acc += (v - m) * (v - m);
    return Math.sqrt(acc / (this.buf.length - 1));
  }

  range(): number {
    if (this.buf.length === 0) return 0;
    let lo = this.buf[0];
    let hi = this.buf[0];
    for (const v of this.buf) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  }

  sum(): number {
    let s = 0;
    for (const v of this.buf) s += v;
    return s;
  }

  percentile(p: number): number {
    if (this.buf.length === 0) return 0;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[idx];
  }

  clear(): void {
    this.buf = [];
  }
}

export class Ema {
  private _value: number | null = null;
  constructor(private readonly alpha: number) {}

  update(x: number): number {
    if (!isNum(x)) return this._value ?? 0;
    if (this._value === null) this._value = this.alpha * x;
    else this._value = this.alpha * x + (1 - this.alpha) * this._value;
    return this._value;
  }

  get value(): number {
    return this._value ?? 0;
  }

  set value(v: number) {
    this._value = v;
  }

  reset(): void {
    this._value = null;
  }

  get initialized(): boolean {
    return this._value !== null;
  }
}

export function zscore(x: number, mean: number, std: number): number {
  if (std <= 1e-9) return 0;
  return (x - mean) / std;
}
