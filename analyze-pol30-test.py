#!/usr/bin/env python3
"""
POL-30 Test Analysis Framework
Analyzes paper trading fills.jsonl to generate GO/MAYBE/NO-GO recommendation.

Usage:
  python analyze-pol30-test.py data/fills.jsonl [output.md]

Requires: pandas, numpy
"""

import sys
import json
from pathlib import Path
from datetime import datetime
from collections import defaultdict
import statistics

def load_fills(fills_file):
    """Load fills.jsonl and parse into structured data."""
    fills = []
    with open(fills_file, 'r') as f:
        for line in f:
            if line.strip():
                try:
                    fill = json.loads(line)
                    fills.append(fill)
                except json.JSONDecodeError:
                    print(f"Warning: skipped malformed line: {line[:100]}")
    return fills

def extract_timestamp(fill):
    """Extract timestamp from fill record."""
    # Assumes fill has 'filledAt' or 'timestamp' field
    ts_str = fill.get('filledAt') or fill.get('timestamp') or fill.get('createdAt')
    if isinstance(ts_str, str):
        try:
            return datetime.fromisoformat(ts_str.replace('Z', '+00:00')).timestamp()
        except:
            return None
    return None

def calculate_adverse_selection(fill):
    """
    Calculate adverse selection for a single fill.

    Adverse selection = (exit_price - entry_price) * side
    For buys at bid: adverse selection is negative if price moves down after fill
    """
    # This is a placeholder. Actual calculation depends on fill record structure.
    # Typical approach:
    # - If fill is a BUY at price P, check mid price T seconds later
    # - Adverse selection = (later_mid - P) if we're long

    # For now, assume 'adverseSelectionBps' is pre-calculated in the fill
    adv_sel_bps = fill.get('adverseSelectionBps', None)
    return adv_sel_bps

def calculate_pnl_components(fill):
    """Extract PnL components from a fill."""
    return {
        'grossPnl': fill.get('grossPnl', 0),
        'makerFee': fill.get('makerFee', 0),
        'takerFee': fill.get('takerFee', 0),
        'slippage': fill.get('slippage', 0),
        'netPnl': fill.get('netPnl', 0),
    }

def analyze_fills(fills):
    """Run complete analysis on fills."""

    if not fills:
        return None

    # Time-based grouping
    start_ts = min(extract_timestamp(f) for f in fills if extract_timestamp(f))
    end_ts = max(extract_timestamp(f) for f in fills if extract_timestamp(f))
    duration_hours = (end_ts - start_ts) / 3600 if (end_ts and start_ts) else 0

    # Fill statistics
    total_fills = len(fills)
    fill_rate_pct = (total_fills / duration_hours / 60) * 100 if duration_hours > 0 else 0

    # Adverse selection
    adv_sel_values = [calculate_adverse_selection(f) for f in fills if calculate_adverse_selection(f) is not None]
    adv_sel_mean = statistics.mean(adv_sel_values) if adv_sel_values else 0
    adv_sel_min = min(adv_sel_values) if adv_sel_values else 0
    adv_sel_max = max(adv_sel_values) if adv_sel_values else 0
    adv_sel_stdev = statistics.stdev(adv_sel_values) if len(adv_sel_values) > 1 else 0

    # PnL breakdown
    pnl_data = [calculate_pnl_components(f) for f in fills]
    total_gross_pnl = sum(p['grossPnl'] for p in pnl_data)
    total_maker_fees = sum(p['makerFee'] for p in pnl_data)
    total_taker_fees = sum(p['takerFee'] for p in pnl_data)
    total_slippage = sum(p['slippage'] for p in pnl_data)
    total_net_pnl = sum(p['netPnl'] for p in pnl_data)

    net_edge_per_fill_bps = (total_net_pnl / total_fills / 100) if total_fills > 0 else 0

    # Decision logic
    decision = 'UNKNOWN'
    reasoning = []

    if total_fills < 20:
        reasoning.append(f"⚠️  Only {total_fills} fills (sparse data)")

    if fill_rate_pct >= 0.3:
        reasoning.append(f"✅ Fill rate {fill_rate_pct:.2f}% (meets 0.3% target)")
    elif fill_rate_pct >= 0.1:
        reasoning.append(f"⚠️  Fill rate {fill_rate_pct:.2f}% (below 0.3%, marginal)")
    else:
        reasoning.append(f"❌ Fill rate {fill_rate_pct:.2f}% (below 0.1%, too sparse)")

    if 214 <= adv_sel_mean <= 242:
        reasoning.append(f"✅ Adverse selection {adv_sel_mean:.0f} bps (within 214-242 range)")
    elif adv_sel_mean > 280:
        reasoning.append(f"❌ Adverse selection {adv_sel_mean:.0f} bps (>280, deteriorated)")
    else:
        reasoning.append(f"⚠️  Adverse selection {adv_sel_mean:.0f} bps (outside expected range)")

    if total_net_pnl > 0:
        reasoning.append(f"✅ Net PnL ${total_net_pnl:.2f} (positive)")
    else:
        reasoning.append(f"❌ Net PnL ${total_net_pnl:.2f} (negative or break-even)")

    # Decision
    if (fill_rate_pct >= 0.3 and total_net_pnl > 0 and 214 <= adv_sel_mean <= 242):
        decision = 'GO'
    elif (fill_rate_pct >= 0.1 and 0 <= total_net_pnl and 214 <= adv_sel_mean <= 280):
        decision = 'MAYBE'
    else:
        decision = 'NO-GO'

    return {
        'testDuration': {
            'startTs': datetime.fromtimestamp(start_ts) if start_ts else None,
            'endTs': datetime.fromtimestamp(end_ts) if end_ts else None,
            'hours': duration_hours,
        },
        'fillStats': {
            'totalFills': total_fills,
            'fillRatePct': fill_rate_pct,
        },
        'adverseSelection': {
            'meanBps': adv_sel_mean,
            'minBps': adv_sel_min,
            'maxBps': adv_sel_max,
            'stdevBps': adv_sel_stdev,
        },
        'pnl': {
            'grossPnl': total_gross_pnl,
            'makerFees': total_maker_fees,
            'takerFees': total_taker_fees,
            'slippage': total_slippage,
            'netPnl': total_net_pnl,
            'netEdgePerFillBps': net_edge_per_fill_bps,
        },
        'decision': decision,
        'reasoning': reasoning,
    }

def format_report(analysis):
    """Format analysis results as markdown report."""

    report = []
    report.append("# POL-30 Test Analysis Report\n")

    if analysis is None:
        report.append("**ERROR:** No fills found in data file.\n")
        return '\n'.join(report)

    # Test metadata
    test = analysis['testDuration']
    report.append(f"**Test Duration:** {test['hours']:.1f} hours")
    report.append(f"({test['startTs']} to {test['endTs']})\n")

    # Fill statistics
    fills = analysis['fillStats']
    report.append(f"## Fill Rate\n")
    report.append(f"- **Total Fills:** {fills['totalFills']}")
    report.append(f"- **Fill Rate:** {fills['fillRatePct']:.3f}%")
    report.append(f"- **Target:** ≥0.3% (GO) | 0.1–0.3% (MAYBE) | <0.1% (NO-GO)\n")

    # Adverse selection
    adv = analysis['adverseSelection']
    report.append(f"## Adverse Selection\n")
    report.append(f"- **Mean:** {adv['meanBps']:.1f} bps")
    report.append(f"- **Range:** {adv['minBps']:.1f} to {adv['maxBps']:.1f} bps")
    report.append(f"- **Std Dev:** {adv['stdevBps']:.1f} bps")
    report.append(f"- **Target:** 214–242 bps\n")

    # PnL
    pnl = analysis['pnl']
    report.append(f"## PnL Breakdown\n")
    report.append(f"- **Gross PnL:** ${pnl['grossPnl']:.2f}")
    report.append(f"- **Maker Fees:** ${pnl['makerFees']:.2f}")
    report.append(f"- **Taker Fees:** ${pnl['takerFees']:.2f}")
    report.append(f"- **Slippage:** ${pnl['slippage']:.2f}")
    report.append(f"- **Net PnL:** ${pnl['netPnl']:.2f}")
    report.append(f"- **Net Edge per Fill:** {pnl['netEdgePerFillBps']:.1f} bps")
    report.append(f"- **Target:** ≥+73 bps per fill\n")

    # Decision
    report.append(f"## Decision: {analysis['decision']}\n")
    for reason in analysis['reasoning']:
        report.append(f"- {reason}")
    report.append("")

    return '\n'.join(report)

def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze-pol30-test.py <fills.jsonl> [output.md]")
        sys.exit(1)

    fills_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'POL-30-Analysis.md'

    if not Path(fills_file).exists():
        print(f"Error: {fills_file} not found")
        sys.exit(1)

    print(f"Loading fills from {fills_file}...")
    fills = load_fills(fills_file)
    print(f"Loaded {len(fills)} fills")

    print("Running analysis...")
    analysis = analyze_fills(fills)

    report = format_report(analysis)

    with open(output_file, 'w') as f:
        f.write(report)

    print(f"\n{report}")
    print(f"\nReport saved to {output_file}")

    # Exit with decision code
    if analysis:
        decision_code = {'GO': 0, 'MAYBE': 1, 'NO-GO': 2}.get(analysis['decision'], 3)
        sys.exit(decision_code)

if __name__ == '__main__':
    main()
