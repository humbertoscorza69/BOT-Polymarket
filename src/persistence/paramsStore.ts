import { readJson, writeJsonAtomic } from './jsonStore';

export interface AdaptiveParams {
  spreadBias: number; // additive bps on top of Avellaneda
  sizeMultiplier: number; // 0..1+
  gamma: number;
  k: number;
  advPauseThreshold: number;
  perRegime: Record<
    string,
    {
      spreadBias: number;
      sizeMultiplier: number;
      fills: number;
      pnl: number;
      winRate: number;
      toxicity: number;
      updatedAt: number;
    }
  >;
  version: number;
  updatedAt: number;
}

export function defaultAdaptiveParams(gamma: number, k: number): AdaptiveParams {
  return {
    spreadBias: 0,
    sizeMultiplier: 1,
    gamma,
    k,
    advPauseThreshold: 0.55,
    perRegime: {},
    version: 1,
    updatedAt: Date.now(),
  };
}

export class ParamsStore {
  private params: AdaptiveParams;
  constructor(private readonly filePath: string, defaults: AdaptiveParams) {
    this.params = readJson<AdaptiveParams>(filePath, defaults);
  }

  get(): AdaptiveParams {
    return this.params;
  }

  update(partial: Partial<AdaptiveParams>): void {
    this.params = { ...this.params, ...partial, updatedAt: Date.now() };
    this.persist();
  }

  updateRegime(regime: string, patch: Partial<AdaptiveParams['perRegime'][string]>): void {
    const existing = this.params.perRegime[regime] ?? {
      spreadBias: 0,
      sizeMultiplier: 1,
      fills: 0,
      pnl: 0,
      winRate: 0,
      toxicity: 0,
      updatedAt: Date.now(),
    };
    this.params.perRegime[regime] = { ...existing, ...patch, updatedAt: Date.now() };
    this.persist();
  }

  persist(): void {
    writeJsonAtomic(this.filePath, this.params);
  }
}
