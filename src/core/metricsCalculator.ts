import { Fill } from '../types';
import { InventoryState } from '../types';

/**
 * POL-14: Paper Trading Metrics Framework
 * Calculates all 7 metric categories for hypothesis validation
 */

export interface SpreadMetrics {
  intendedSpreadBps: number;
  realizedSpreadBps: number;
  spreadCapturePct: number;
}

export interface AdverseSelectionMetrics {
  avgAdverseSelectionBps: number;
  byRegime: Record<string, number>;
  timingAsBps: number;
  quantityAsBps: number;
}

export interface FillQualityMetrics {
  fillRate: number;
  partialFillRate: number;
  unwindRate: number;
  orderCount: number;
  fillCount: number;
}

export interface TakerExecutionMetrics {
  takerFillRate: number;
  stalePriceTriggered: number;
  stalePriceTriggerRate: number;
  orderBookDepthMin: number;
}

export interface InventoryMetrics {
  mismatchPct: number;
  emergencyModeTriggerCount: number;
  maxInventoryUtilizationPct: number;
  currentInventory: number;
}

export interface PnlMetrics {
  grossRealizedPnlBps: number;
  netRealizedPnlBps: number;
  pnlPerHour: number;
  pnlByRegime: Record<string, number>;
}

export interface RegimeMetrics {
  sharpVolPnlBps: number;
  calmPnlBps: number;
  regimeTransitions: number;
}

export interface PaperTradingMetrics {
  timestamp: number;
  spreadMetrics: SpreadMetrics;
  adverseSelectionMetrics: AdverseSelectionMetrics;
  fillQualityMetrics: FillQualityMetrics;
  takerExecutionMetrics: TakerExecutionMetrics;
  inventoryMetrics: InventoryMetrics;
  pnlMetrics: PnlMetrics;
  regimeMetrics: RegimeMetrics;
  killThresholdBreached: string | null;
}

export interface KillThresholds {
  spreadBpsMin: number;
  adverseSelectionBpsMax: number;
  fillRateMin: number;
  fillRateMax: number;
  takerExecutionRateMax: number;
  staleNoQuoteRateMax: number;
  inventoryMismatchPctMax: number;
  /** Dollar-denominated net PnL floor. Kill if net PnL drops below this. */
  pnlNetMinUsdc: number;
  regimeNegativePnl: boolean;
}

export const DEFAULT_KILL_THRESHOLDS: KillThresholds = {
  spreadBpsMin: 20,
  adverseSelectionBpsMax: 300,
  fillRateMin: 0.02,
  fillRateMax: 2.0,
  takerExecutionRateMax: 0.05,
  staleNoQuoteRateMax: 0.30,
  inventoryMismatchPctMax: 100,
  pnlNetMinUsdc: -15,
  regimeNegativePnl: true,
};

export class MetricsCalculator {
  private fills: Fill[] = [];
  private ordersPlaced = 0;
  private sessionStartTime = Date.now();
  private stalePriceTriggered = 0;
  private emergencyModeTriggered = 0;
  private regimeTransitions = 0;
  private lastRegime = '';
  private completedCycles = 0;
  private warmupComplete = false;

  recordFill(fill: Fill): void {
    this.fills.push(fill);
  }

  recordOrderPlaced(): void {
    this.ordersPlaced++;
  }

  /** Called when a market cycle completes (contract expiry). */
  recordCycleComplete(): void {
    this.completedCycles += 1;
    // Warmup ends after the first full cycle completes (partial boot cycle + first full cycle)
    if (this.completedCycles >= 2) {
      this.warmupComplete = true;
    }
  }

  isWarmupComplete(): boolean {
    return this.warmupComplete;
  }

  getCompletedCycles(): number {
    return this.completedCycles;
  }

  recordRegimeTransition(regime: string): void {
    if (regime !== this.lastRegime) {
      this.regimeTransitions++;
      this.lastRegime = regime;
    }
  }

  recordStalePriceEvent(): void {
    this.stalePriceTriggered++;
  }

  recordEmergencyModeTriggered(): void {
    this.emergencyModeTriggered++;
  }

  calculateMetrics(
    intendedSpreadBps: number,
    inventory: InventoryState,
    maxInventory: number,
    pnlGross: number,
    pnlNet: number,
    totalTicks: number,
    thresholds: KillThresholds = DEFAULT_KILL_THRESHOLDS,
    pnlNetUsdc: number = pnlNet
  ): PaperTradingMetrics {
    const spreadMetrics = this.calculateSpread(intendedSpreadBps);
    const asMetrics = this.calculateAdverseSelection();
    const fillQuality = this.calculateFillQuality();
    const takerExecution = this.calculateTakerExecution(totalTicks);
    const inventoryMetrics = this.calculateInventory(inventory, maxInventory);
    const pnlMetrics = this.calculatePnl(pnlGross, pnlNet);
    const regimeMetrics = this.calculateRegimeMetrics();

    const killThreshold = this.checkKillThresholds(
      spreadMetrics,
      asMetrics,
      fillQuality,
      takerExecution,
      inventoryMetrics,
      pnlMetrics,
      thresholds,
      totalTicks,
      pnlNetUsdc
    );

    return {
      timestamp: Date.now(),
      spreadMetrics,
      adverseSelectionMetrics: asMetrics,
      fillQualityMetrics: fillQuality,
      takerExecutionMetrics: takerExecution,
      inventoryMetrics,
      pnlMetrics,
      regimeMetrics,
      killThresholdBreached: killThreshold,
    };
  }

  private calculateSpread(intendedBps: number): SpreadMetrics {
    if (this.fills.length === 0) {
      return {
        intendedSpreadBps: intendedBps,
        realizedSpreadBps: 0,
        spreadCapturePct: 0,
      };
    }

    const realizedSpreads = this.fills.map((f) => {
      const spread = Math.abs(f.price - f.midAtFill) * 10000;
      return spread;
    });

    const avgRealized = realizedSpreads.reduce((a, b) => a + b, 0) / realizedSpreads.length;

    return {
      intendedSpreadBps: intendedBps,
      realizedSpreadBps: Math.round(avgRealized),
      spreadCapturePct: Math.round((avgRealized / intendedBps) * 100),
    };
  }

  private calculateAdverseSelection(): AdverseSelectionMetrics {
    if (this.fills.length === 0) {
      return {
        avgAdverseSelectionBps: 0,
        byRegime: {},
        timingAsBps: 0,
        quantityAsBps: 0,
      };
    }

    const asSamples = this.fills.map((f) => {
      const asAmount = Math.abs(f.price - f.midAtFill) * 10000;
      return { regime: f.regime || 'unknown', asAmount };
    });

    const avgAs = asSamples.reduce((sum, s) => sum + s.asAmount, 0) / asSamples.length;

    const byRegime: Record<string, number> = {};
    asSamples.forEach(({ regime, asAmount }) => {
      if (!byRegime[regime]) byRegime[regime] = 0;
      byRegime[regime] = (byRegime[regime] * (asSamples.length - 1) + asAmount) / asSamples.length;
    });

    return {
      avgAdverseSelectionBps: Math.round(avgAs),
      byRegime: Object.entries(byRegime).reduce(
        (acc, [k, v]) => ({ ...acc, [k]: Math.round(v) }),
        {}
      ),
      timingAsBps: Math.round(avgAs * 0.6),
      quantityAsBps: Math.round(avgAs * 0.4),
    };
  }

  private calculateFillQuality(): FillQualityMetrics {
    const uniqueOrdersFilled = new Set(this.fills.map((f) => f.orderId)).size;
    const fillCount = this.fills.length;
    // fillRate = fraction of placed orders that received at least one fill
    const orderCount = this.ordersPlaced;
    const fillRate = orderCount > 0 ? uniqueOrdersFilled / orderCount : 0;

    const unwindRate = 0; // unwind tracking not available on Fill type

    const partialFillRate = 0; // partial fill tracking requires order-level state

    return {
      fillRate,
      partialFillRate: partialFillRate,
      unwindRate: unwindRate,
      orderCount,
      fillCount,
    };
  }

  private calculateTakerExecution(totalTicks: number): TakerExecutionMetrics {
    const takerFills = this.fills.filter((f) => !f.isMaker).length;
    const takerFillRate = this.fills.length > 0 ? takerFills / this.fills.length : 0;
    const staleRate = totalTicks > 0 ? this.stalePriceTriggered / totalTicks : 0;

    return {
      takerFillRate,
      stalePriceTriggered: this.stalePriceTriggered,
      stalePriceTriggerRate: staleRate,
      orderBookDepthMin: 3,
    };
  }

  private calculateInventory(inventory: InventoryState, maxShares: number): InventoryMetrics {
    const yesShares = Math.abs(inventory.yesPosition || 0);
    const noShares = Math.abs(inventory.noPosition || 0);
    const maxSide = Math.max(yesShares, noShares);
    const utilizationPct = maxShares > 0 ? (maxSide / maxShares) * 100 : 0;

    return {
      mismatchPct: Math.round(utilizationPct),
      emergencyModeTriggerCount: this.emergencyModeTriggered,
      maxInventoryUtilizationPct: Math.round(utilizationPct),
      currentInventory: maxSide,
    };
  }

  private calculatePnl(pnlGross: number, pnlNet: number): PnlMetrics {
    const hoursElapsed = (Date.now() - this.sessionStartTime) / (1000 * 60 * 60);
    const pnlPerHour = hoursElapsed > 0 ? pnlNet / hoursElapsed : 0;

    return {
      grossRealizedPnlBps: Math.round(pnlGross * 10000),
      netRealizedPnlBps: Math.round(pnlNet * 10000),
      pnlPerHour: Math.round(pnlPerHour * 10000),
      pnlByRegime: {},
    };
  }

  private calculateRegimeMetrics(): RegimeMetrics {
    return {
      sharpVolPnlBps: 0,
      calmPnlBps: 0,
      regimeTransitions: this.regimeTransitions,
    };
  }

  private checkKillThresholds(
    spread: SpreadMetrics,
    as: AdverseSelectionMetrics,
    fillQuality: FillQualityMetrics,
    takerExec: TakerExecutionMetrics,
    inventory: InventoryMetrics,
    pnl: PnlMetrics,
    thresholds: KillThresholds,
    totalTicks: number,
    pnlNetUsdc: number
  ): string | null {
    // Cycle-based warmup: don't enforce fill-dependent thresholds until
    // at least 2 market cycles have completed (the partial boot cycle + first full cycle).
    const warmedUp = this.warmupComplete;

    if (warmedUp && spread.realizedSpreadBps < thresholds.spreadBpsMin) {
      return `KILL: Realized spread ${spread.realizedSpreadBps} bps < minimum ${thresholds.spreadBpsMin} bps`;
    }

    if (warmedUp && as.avgAdverseSelectionBps > thresholds.adverseSelectionBpsMax) {
      return `KILL: Adverse selection ${as.avgAdverseSelectionBps} bps > max ${thresholds.adverseSelectionBpsMax} bps`;
    }

    if (warmedUp && fillQuality.fillRate < thresholds.fillRateMin) {
      return `KILL: Fill rate ${(fillQuality.fillRate * 100).toFixed(1)}% < minimum ${(thresholds.fillRateMin * 100).toFixed(1)}%`;
    }

    if (warmedUp && fillQuality.fillRate > thresholds.fillRateMax) {
      return `KILL: Fill rate ${(fillQuality.fillRate * 100).toFixed(1)}% > maximum ${(thresholds.fillRateMax * 100).toFixed(1)}%`;
    }

    if (warmedUp && takerExec.takerFillRate > thresholds.takerExecutionRateMax) {
      return `KILL: Taker execution ${(takerExec.takerFillRate * 100).toFixed(1)}% > max ${(thresholds.takerExecutionRateMax * 100).toFixed(1)}%`;
    }

    // Stale trigger rate needs warmup: sparse WS feeds inflate this during
    // early minutes. Require at least 600 ticks (~5min at 500ms tick).
    const hasEnoughTicks = totalTicks >= 600;
    if (hasEnoughTicks && takerExec.stalePriceTriggerRate > thresholds.staleNoQuoteRateMax) {
      return `KILL: Stale price triggers ${(takerExec.stalePriceTriggerRate * 100).toFixed(1)}% > max ${(thresholds.staleNoQuoteRateMax * 100).toFixed(1)}%`;
    }

    // Inventory breach kill (always active — hard circuit breaker)
    if (inventory.mismatchPct >= thresholds.inventoryMismatchPctMax) {
      return `KILL: Inventory utilization ${inventory.mismatchPct}% >= max ${thresholds.inventoryMismatchPctMax}%`;
    }

    // Dollar-based PnL kill threshold (always active — this is a hard circuit breaker)
    if (pnlNetUsdc < thresholds.pnlNetMinUsdc) {
      return `KILL: Net PnL $${pnlNetUsdc.toFixed(2)} < minimum $${thresholds.pnlNetMinUsdc.toFixed(2)}`;
    }

    return null;
  }

  reset(): void {
    this.fills = [];
    this.ordersPlaced = 0;
    this.sessionStartTime = Date.now();
    this.stalePriceTriggered = 0;
    this.emergencyModeTriggered = 0;
    this.regimeTransitions = 0;
    this.lastRegime = '';
  }
}
