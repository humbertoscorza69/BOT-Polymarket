export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const clamp01 = (x: number): number => clamp(x, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);

export const bpsToProb = (bps: number): number => bps / 10_000;

export const probToBps = (p: number): number => p * 10_000;

export const tickRound = (x: number, tick: number): number => Math.round(x / tick) * tick;

export const safeDivide = (a: number, b: number, fallback = 0): number =>
  b === 0 || !Number.isFinite(b) ? fallback : a / b;

export const isNum = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export const mean = (xs: number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);

export const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

export const softmaxTwo = (a: number, b: number): number => {
  const ea = Math.exp(a);
  const eb = Math.exp(b);
  const s = ea + eb;
  return s === 0 ? 0.5 : ea / s;
};

export function normalize(x: number, floor: number, ceil: number): number {
  if (ceil <= floor) return 0;
  return clamp01((x - floor) / (ceil - floor));
}

export function logistic(x: number, k = 1): number {
  return 1 / (1 + Math.exp(-k * x));
}
