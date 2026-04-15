import { clamp } from './math';

export const PROB_MIN = 0.01;
export const PROB_MAX = 0.99;

export const clampProb = (p: number): number => clamp(p, PROB_MIN, PROB_MAX);

export const clampSize = (s: number, min: number, max: number): number =>
  clamp(Math.round(s), Math.round(min), Math.round(max));

export const clampBps = (x: number, minBps: number, maxBps: number): number =>
  clamp(x, minBps, maxBps);
