import EventEmitter from 'eventemitter3';
import { getLogger } from '../utils/logger';

const logger = getLogger('kill-monitor');
import { PaperTradingMetrics, KillThresholds, DEFAULT_KILL_THRESHOLDS } from './metricsCalculator';

/**
 * POL-14: Kill Threshold Monitor
 * Auto-stops bot and alerts if kill thresholds are breached
 * Prevents hypotheses from running past known failure points
 */

export enum KillAlert {
  KILL_IMMEDIATELY = 'KILL_IMMEDIATELY',
  WARNING = 'WARNING',
  PASS = 'PASS',
}

export interface KillThresholdEvent {
  timestamp: number;
  alert: KillAlert;
  metric: string;
  currentValue: number | string;
  threshold: number | string;
  message: string;
}

export class KillThresholdMonitor extends EventEmitter {
  private lastAlertTime = 0;
  private alertCooldownMs = 5000; // Don't spam alerts
  private thresholds: KillThresholds;

  constructor(thresholds: KillThresholds = DEFAULT_KILL_THRESHOLDS) {
    super();
    this.thresholds = thresholds;
  }

  /**
   * Check metrics against kill thresholds
   * Emits KillThresholdEvent if threshold breached
   * Returns true if session should stop immediately
   */
  checkMetrics(metrics: PaperTradingMetrics): boolean {
    if (metrics.killThresholdBreached) {
      return this.handleKillCondition(metrics.killThresholdBreached, metrics.timestamp);
    }

    // Check warnings (not immediate kill, but concerning)
    this.checkWarnings(metrics);

    return false;
  }

  private handleKillCondition(message: string, timestamp: number): boolean {
    const now = Date.now();
    if (now - this.lastAlertTime < this.alertCooldownMs) {
      return true; // Still in cooldown, but we should kill
    }

    this.lastAlertTime = now;

    const event: KillThresholdEvent = {
      timestamp,
      alert: KillAlert.KILL_IMMEDIATELY,
      metric: 'HYPOTHESIS_FAILURE',
      currentValue: 'MULTIPLE_FAILURES',
      threshold: 'ALL_LIMITS',
      message,
    };

    logger.error(`[KILL-ALERT] ${message}`);
    logger.error('[KILL-ALERT] Stopping bot immediately to prevent losses');

    this.emit('kill', event);

    return true;
  }

  private checkWarnings(metrics: PaperTradingMetrics): void {
    const warnings: KillThresholdEvent[] = [];

    // Warning 1: Spread approaching minimum
    if (
      metrics.spreadMetrics.realizedSpreadBps > 0 &&
      metrics.spreadMetrics.realizedSpreadBps < this.thresholds.spreadBpsMin * 1.5
    ) {
      warnings.push({
        timestamp: metrics.timestamp,
        alert: KillAlert.WARNING,
        metric: 'SPREAD_LOW',
        currentValue: metrics.spreadMetrics.realizedSpreadBps,
        threshold: this.thresholds.spreadBpsMin,
        message: `Realized spread ${metrics.spreadMetrics.realizedSpreadBps} bps approaching kill threshold`,
      });
    }

    // Warning 2: Adverse selection trending high
    if (
      metrics.adverseSelectionMetrics.avgAdverseSelectionBps > this.thresholds.adverseSelectionBpsMax * 0.7
    ) {
      warnings.push({
        timestamp: metrics.timestamp,
        alert: KillAlert.WARNING,
        metric: 'ADVERSE_SELECTION_HIGH',
        currentValue: metrics.adverseSelectionMetrics.avgAdverseSelectionBps,
        threshold: this.thresholds.adverseSelectionBpsMax,
        message: `Adverse selection ${metrics.adverseSelectionMetrics.avgAdverseSelectionBps} bps approaching limit`,
      });
    }

    // Warning 3: Emergency mode triggered
    if (metrics.inventoryMetrics.emergencyModeTriggerCount > 5) {
      warnings.push({
        timestamp: metrics.timestamp,
        alert: KillAlert.WARNING,
        metric: 'INVENTORY_UNSTABLE',
        currentValue: metrics.inventoryMetrics.emergencyModeTriggerCount,
        threshold: 5,
        message: `Emergency mode triggered ${metrics.inventoryMetrics.emergencyModeTriggerCount} times, inventory is unstable`,
      });
    }

    // Warning 4: High taker execution rate
    if (metrics.takerExecutionMetrics.takerFillRate > this.thresholds.takerExecutionRateMax * 0.7) {
      warnings.push({
        timestamp: metrics.timestamp,
        alert: KillAlert.WARNING,
        metric: 'TAKER_EXECUTION_HIGH',
        currentValue: (metrics.takerExecutionMetrics.takerFillRate * 100).toFixed(1) + '%',
        threshold: (this.thresholds.takerExecutionRateMax * 100).toFixed(1) + '%',
        message: `Taker execution rate ${(metrics.takerExecutionMetrics.takerFillRate * 100).toFixed(1)}% approaching limit, post-only protection may be failing`,
      });
    }

    warnings.forEach((w) => {
      logger.warn(`[WARNING] ${w.message}`);
      this.emit('warning', w);
    });
  }

  /**
   * Decision logic: should we pivot to H2 or kill the session?
   */
  decidePivotOrKill(metrics: PaperTradingMetrics, hoursElapsed: number): 'continue' | 'pivot_h2' | 'kill' {
    const killMessage = metrics.killThresholdBreached;

    // Immediate kill conditions
    if (killMessage) {
      return 'kill';
    }

    // Early decision gates (after 4-12 hours)
    if (hoursElapsed >= 4 && hoursElapsed < 12) {
      // Check if realized spread is too low too early
      if (metrics.spreadMetrics.realizedSpreadBps < this.thresholds.spreadBpsMin * 2) {
        logger.info('[DECISION] After 4 hours: realized spread too low, pivoting to H2');
        return 'pivot_h2';
      }
    }

    // After 12 hours, make a decision
    if (hoursElapsed >= 12) {
      // If we haven't generated positive PnL by 12 hours, pivot
      if (metrics.pnlMetrics.netRealizedPnlBps <= 0 && hoursElapsed < 24) {
        logger.info('[DECISION] After 12 hours: no edge detected, pivoting to H2');
        return 'pivot_h2';
      }
    }

    // Default: continue
    return 'continue';
  }
}
