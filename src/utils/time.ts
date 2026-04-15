export const now = (): number => Date.now();

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export const isoNow = (): string => new Date().toISOString();

export function ageMs(tsMs: number): number {
  return Date.now() - tsMs;
}

export function ageSec(tsMs: number): number {
  return Math.floor((Date.now() - tsMs) / 1000);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
