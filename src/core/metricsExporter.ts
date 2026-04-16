import * as fs from 'fs';
import * as path from 'path';
import { PaperTradingMetrics } from './metricsCalculator';

/**
 * POL-14: Metrics CSV Exporter
 * Exports paper trading metrics to CSV for analysis and CEO review
 */

export class MetricsExporter {
  private csvPath: string;
  private headerWritten = false;

  constructor(outputDir: string = './data/metrics') {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.csvPath = path.join(outputDir, `paper-trading-metrics-${timestamp}.csv`);
  }

  exportMetrics(metrics: PaperTradingMetrics): void {
    const row = this.flattenMetrics(metrics);

    if (!this.headerWritten) {
      const header = Object.keys(row).join(',');
      fs.appendFileSync(this.csvPath, header + '\n');
      this.headerWritten = true;
    }

    const values = Object.values(row).map((v) => {
      if (typeof v === 'string' && v.includes(',')) {
        return `"${v}"`;
      }
      return v;
    });

    fs.appendFileSync(this.csvPath, values.join(',') + '\n');
  }

  private flattenMetrics(m: PaperTradingMetrics): Record<string, any> {
    const timestamp = new Date(m.timestamp).toISOString();

    return {
      timestamp,
      // Spread
      intended_spread_bps: m.spreadMetrics.intendedSpreadBps,
      realized_spread_bps: m.spreadMetrics.realizedSpreadBps,
      spread_capture_pct: m.spreadMetrics.spreadCapturePct,
      // Adverse Selection
      avg_adverse_selection_bps: m.adverseSelectionMetrics.avgAdverseSelectionBps,
      timing_as_bps: m.adverseSelectionMetrics.timingAsBps,
      quantity_as_bps: m.adverseSelectionMetrics.quantityAsBps,
      // Fill Quality
      fill_rate: (m.fillQualityMetrics.fillRate * 100).toFixed(2),
      partial_fill_rate: (m.fillQualityMetrics.partialFillRate * 100).toFixed(2),
      unwind_rate: (m.fillQualityMetrics.unwindRate * 100).toFixed(2),
      order_count: m.fillQualityMetrics.orderCount,
      fill_count: m.fillQualityMetrics.fillCount,
      // Taker Execution
      taker_fill_rate: (m.takerExecutionMetrics.takerFillRate * 100).toFixed(2),
      stale_price_triggered_count: m.takerExecutionMetrics.stalePriceTriggered,
      stale_price_trigger_rate: (m.takerExecutionMetrics.stalePriceTriggerRate * 100).toFixed(2),
      // Inventory
      emergency_mode_trigger_count: m.inventoryMetrics.emergencyModeTriggerCount,
      max_inventory_utilization_pct: m.inventoryMetrics.maxInventoryUtilizationPct,
      current_inventory: m.inventoryMetrics.currentInventory,
      // PnL
      gross_realized_pnl_bps: m.pnlMetrics.grossRealizedPnlBps,
      net_realized_pnl_bps: m.pnlMetrics.netRealizedPnlBps,
      pnl_per_hour: m.pnlMetrics.pnlPerHour,
      // Regime
      regime_transitions: m.regimeMetrics.regimeTransitions,
      // Kill Status
      kill_threshold_breached: m.killThresholdBreached || 'PASS',
    };
  }

  generateDailySummary(metricsHistory: PaperTradingMetrics[]): string {
    if (metricsHistory.length === 0) {
      return 'No metrics available for summary';
    }

    const latest = metricsHistory[metricsHistory.length - 1];
    const avgSpreadRealized = (
      metricsHistory.reduce((sum, m) => sum + m.spreadMetrics.realizedSpreadBps, 0) /
      metricsHistory.length
    ).toFixed(0);
    const avgAdverseSelection = (
      metricsHistory.reduce((sum, m) => sum + m.adverseSelectionMetrics.avgAdverseSelectionBps, 0) /
      metricsHistory.length
    ).toFixed(0);

    const killCount = metricsHistory.filter((m) => m.killThresholdBreached).length;
    const killRate = ((killCount / metricsHistory.length) * 100).toFixed(1);

    const summary = `
=============================================================
         PAPER TRADING DAILY SUMMARY - POL-14
=============================================================

Timestamp: ${new Date(latest.timestamp).toISOString()}
Total Samples: ${metricsHistory.length}

SPREAD METRICS
--------------
- Avg Realized Spread: ${avgSpreadRealized} bps
- Spread Capture: ${latest.spreadMetrics.spreadCapturePct}%
- Expected: 100-200 bps (${latest.spreadMetrics.spreadCapturePct < 50 ? 'BELOW TARGET' : 'ON TARGET'})

ADVERSE SELECTION
-----------------
- Avg AS: ${avgAdverseSelection} bps
- Timing AS: ${latest.adverseSelectionMetrics.timingAsBps} bps
- Quantity AS: ${latest.adverseSelectionMetrics.quantityAsBps} bps
- Expected: 15-30 bps (${latest.adverseSelectionMetrics.avgAdverseSelectionBps > 50 ? 'ABOVE TARGET' : 'ON TARGET'})

FILL QUALITY
------------
- Fill Rate: ${(latest.fillQualityMetrics.fillRate * 100).toFixed(1)}%
- Expected: 5-15% (${latest.fillQualityMetrics.fillRate < 0.05 ? 'TOO LOW' : 'OK'})
- Total Fills: ${latest.fillQualityMetrics.fillCount}
- Order Count: ${latest.fillQualityMetrics.orderCount}

TAKER EXECUTION RISK
--------------------
- Taker Fill Rate: ${(latest.takerExecutionMetrics.takerFillRate * 100).toFixed(1)}%
- Stale Price Triggers: ${latest.takerExecutionMetrics.stalePriceTriggered} (${(latest.takerExecutionMetrics.stalePriceTriggerRate * 100).toFixed(1)}% of ticks)
- Expected: <5% taker, <1% stale (${latest.takerExecutionMetrics.takerFillRate > 0.05 ? 'POST-ONLY AT RISK' : 'GOOD'})

INVENTORY
---------
- Current Inventory: ${latest.inventoryMetrics.currentInventory} shares
- Max Utilization: ${latest.inventoryMetrics.maxInventoryUtilizationPct}%
- Emergency Triggers: ${latest.inventoryMetrics.emergencyModeTriggerCount}
- Expected: 40-70% util (${latest.inventoryMetrics.maxInventoryUtilizationPct > 80 ? 'TOO HIGH' : 'OK'})

PNL
---
- Gross PnL: ${latest.pnlMetrics.grossRealizedPnlBps} bps
- Net PnL: ${latest.pnlMetrics.netRealizedPnlBps} bps
- PnL per Hour: ${latest.pnlMetrics.pnlPerHour} bps
- Status: ${latest.pnlMetrics.netRealizedPnlBps > 0 ? 'PROFITABLE' : 'UNPROFITABLE'}

KILL THRESHOLD STATUS
---------------------
- Pass Rate: ${(100 - parseFloat(killRate)).toFixed(1)}%
- Latest Status: ${latest.killThresholdBreached || 'PASS'}
- Action: ${latest.killThresholdBreached ? 'STOP IMMEDIATELY' : 'CONTINUE MONITORING'}

CSV Export: ${this.csvPath}
=============================================================
    `;

    return summary;
  }

  getPath(): string {
    return this.csvPath;
  }
}
