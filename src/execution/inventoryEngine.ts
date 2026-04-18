import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import { Fill, InventoryState } from '../types';
import { clamp } from '../utils/math';
import { getLogger } from '../utils/logger';

const log = getLogger('inventory');

export class InventoryEngine extends EventEmitter {
  private s: InventoryState;
  constructor(private readonly cfg: BotConfig) {
    super();
    this.s = {
      freeUsdc: cfg.bankrollUsdc,
      yesPosition: 0,
      noPosition: 0,
      yesAvgCost: 0,
      noAvgCost: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      markToMarketPnl: 0,
      normalizedSkew: 0,
      lastUpdate: Date.now(),
    };
  }

  get state(): InventoryState {
    return this.s;
  }

  forceBalance(usdc: number): void {
    this.s.freeUsdc = usdc;
    this.s.lastUpdate = Date.now();
    this.emit('update', this.s);
  }

  /** Force share positions to exchange truth */
  forceSharePositions(yesPos: number, noPos: number): void {
    this.s.yesPosition = yesPos;
    this.s.noPosition = noPos;
    this.s.lastUpdate = Date.now();
    this.emit('update', this.s);
  }

  /** Reset inventory for market rotation. Logs residual if non-trivial. */
  reset(): { residualUsdc: number } {
    const yUsdc = this.s.yesPosition * (this.s.yesAvgCost || 0.5);
    const nUsdc = this.s.noPosition * (this.s.noAvgCost || 0.5);
    const residual = yUsdc - nUsdc;
    this.s.yesPosition = 0;
    this.s.noPosition = 0;
    this.s.yesAvgCost = 0;
    this.s.noAvgCost = 0;
    this.s.unrealizedPnl = 0;
    this.s.normalizedSkew = 0;
    this.s.lastUpdate = Date.now();
    this.emit('update', this.s);
    return { residualUsdc: residual };
  }

  /**
   * Apply a fill. Returns realized pnl delta produced by this fill.
   */
  applyFill(fill: Fill): number {
    const token = fill.token;
    const side = fill.side;
    const price = fill.price;
    const size = fill.size;
    const notional = price * size;
    let realized = 0;

    if (token === 'YES') {
      if (side === 'BUY') {
        const newPos = this.s.yesPosition + size;
        const newCost = newPos > 0 ? (this.s.yesAvgCost * this.s.yesPosition + notional) / newPos : 0;
        this.s.yesPosition = newPos;
        this.s.yesAvgCost = newCost;
        this.s.freeUsdc -= notional;
      } else {
        // SELL YES = reduce YES long, realize vs avg cost
        const reduce = Math.min(this.s.yesPosition, size);
        realized += reduce * (price - this.s.yesAvgCost);
        this.s.yesPosition -= reduce;
        this.s.freeUsdc += reduce * price;
        if (size > reduce) {
          const excess = size - reduce;
          log.warn('short YES rejected; excess shares dropped', { excess, price, size, position: this.s.yesPosition });
        }
      }
    } else {
      if (side === 'BUY') {
        const newPos = this.s.noPosition + size;
        const newCost = newPos > 0 ? (this.s.noAvgCost * this.s.noPosition + notional) / newPos : 0;
        this.s.noPosition = newPos;
        this.s.noAvgCost = newCost;
        this.s.freeUsdc -= notional;
      } else {
        const reduce = Math.min(this.s.noPosition, size);
        realized += reduce * (price - this.s.noAvgCost);
        this.s.noPosition -= reduce;
        this.s.freeUsdc += reduce * price;
      }
    }

    this.s.freeUsdc -= fill.feeUsdc;
    this.s.realizedPnl += realized;
    this.recomputeSkew();
    this.s.lastUpdate = Date.now();
    this.emit('update', this.s);
    return realized;
  }

  markToMarket(midYes: number | null): void {
    if (midYes === null) return;
    const yesUnreal = this.s.yesPosition * (midYes - this.s.yesAvgCost);
    const noMid = 1 - midYes;
    const noUnreal = this.s.noPosition * (noMid - this.s.noAvgCost);
    this.s.unrealizedPnl = yesUnreal + noUnreal;
    this.s.markToMarketPnl = this.s.realizedPnl + this.s.unrealizedPnl;
    this.recomputeSkew(midYes);
    this.s.lastUpdate = Date.now();
  }

  private recomputeSkew(midYes: number | null = null): void {
    // normalized skew considers notional YES exposure minus NO exposure / max cap
    const y = this.s.yesPosition * ((midYes ?? this.s.yesAvgCost) ?? 0.5);
    const n = this.s.noPosition * ((midYes !== null ? 1 - midYes : this.s.noAvgCost) ?? 0.5);
    const cap = Math.max(1, this.cfg.riskMaxInventoryUsdc);
    this.s.normalizedSkew = clamp((y - n) / cap, -1, 1);
  }

  /** Check if we can accumulate more notional on a given side */
  canAccumulate(token: 'YES' | 'NO', sizeUsdc: number, sizeShares: number = 0): boolean {
    const currentYesUsdc = this.s.yesPosition * (this.s.yesAvgCost || 0.5);
    const currentNoUsdc = this.s.noPosition * (this.s.noAvgCost || 0.5);
    const cap = this.cfg.riskMaxInventoryUsdc;
    // USDC notional cap (existing belt)
    if (token === 'YES' && currentYesUsdc + sizeUsdc > cap) return false;
    if (token === 'NO' && currentNoUsdc + sizeUsdc > cap) return false;
    // Per-side share cap (suspenders)
    const maxShares = this.cfg.inventoryMaxShares;
    if (token === 'YES' && this.s.yesPosition + sizeShares > maxShares) return false;
    if (token === 'NO' && this.s.noPosition + sizeShares > maxShares) return false;
    return true;
  }

  get emergencyTriggered(): boolean {
    const maxShares = this.cfg.inventoryMaxShares;
    const threshold = this.cfg.inventoryEmergencyThresholdPct / 100;
    return this.s.yesPosition > maxShares * threshold || this.s.noPosition > maxShares * threshold;
  }
}
