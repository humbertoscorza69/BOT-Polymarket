# POL-30: Option A Test — 600 bps Spread Hypothesis

**Test ID:** POL-30-OptA-600bps  
**Date Created:** 2026-04-17  
**Assigned to:** CTO (Execution), Quant Researcher (Analysis)  
**Priority:** HIGH

---

## Executive Summary

This test validates whether widening the spread to **600 bps** (from 300 bps) can capture enough gross edge to overcome adverse selection (~227 bps midpoint) and remain profitable despite lower fill rates.

**Expected edge:** +73 bps per fill  
**Expected fill rate drop:** 1.14% → 0.3–0.5%  
**Success criterion:** Fill rate ≥ 0.3% AND positive realized PnL

---

## Test Hypothesis

### Current State (300 bps spread)
- Adverse selection: 214–242 bps (structural, latency-driven)
- Gross edge (spread): 150 bps per side
- Net edge after adverse selection: 150 – 227 (midpoint) = **−77 bps** (LOSING)
- Current fill rate: 1.14%

### Proposed Test (600 bps spread)
- **Half-spread:** 300 bps per side (full spread = 600 bps)
- **Adverse selection:** Unchanged (214–242 bps, since latency is unchanged)
- **Expected net edge:** 300 – 227 (midpoint) = **+73 bps per fill** (PROFITABLE)
- **Projected fill rate:** 0.3–0.5% (lower volume, wider spread)
- **Estimated daily PnL:** ~$50–75 on $20k notional (~0.25–0.4% daily return)

### Success Scenarios
- **GO (Proceed to Live):** Fill rate ≥ 0.3% AND net PnL positive AND adverse selection stays in 214–242 bps range
- **MAYBE (Inconclusive):** Fill rate 0.1–0.3% AND marginal positive PnL → escalate to Option B (latency optimization)
- **NO-GO (Proceed to Option B immediately):** Fill rate < 0.1% OR adverse selection > 280 bps OR net PnL negative

---

## Test Configuration

### Parameter Overrides

**Spread adjustment:**
```
QUOTE_BASE_HALF_SPREAD_BPS=300    # (600 bps full spread, was 150 → 300 bps)
```

**All other parameters:** UNCHANGED
- `AV_GAMMA=0.8` (unchanged)
- `AV_K=1.5` (unchanged)
- Fair-value model: unchanged
- Latency: `PAPER_LATENCY_MS=140` (unchanged)
- Risk controls: unchanged

### Environment Setup

```bash
# From BOT-Polymarket directory:
MODE=paper
DATA_SOURCE=real
TARGET_ASSETS=BTC,ETH
TARGET_INTERVALS=5m,15m

# Optional: narrow to single market if needed
# TARGET_ASSETS=BTC
# TARGET_INTERVALS=5m

QUOTE_BASE_HALF_SPREAD_BPS=300
# (all other env vars from .env unchanged)
```

### Test Duration

- **Minimum:** 8 hours continuous
- **Preferred:** 12 hours continuous
- **Rationale:** Need sufficient samples for reliable fill-rate and adverse-selection estimates
  - Expected ~50–70 fills at 0.3–0.5% fill rate (vs. 130+ at 1.14%)
  - Volatility regime rotation may occur over 8–12h; need coverage across regimes

### Test Termination

**Stop early if:**
- Fill rate drops below 0.1% (too sparse to be viable) → escalate to Option B immediately
- Adverse selection breaks out above 280 bps (unexpected deterioration) → investigate and halt
- Bot crashes or feed stalls (require manual restart) → log incident and resume

---

## Monitoring & Metrics

### Real-Time Monitoring (Every 30 minutes)

Log the following snapshot every 30 min (or more frequently if desired):

| Metric | Description | Target | Flag If |
|--------|-------------|--------|---------|
| **Fill Count** | Number of fills in last 30 min | 2–5 | <1 (too sparse) |
| **Fill Rate** | Fills / opportunities (%) | 0.3–0.5% | <0.1% (too low) |
| **Adverse Selection (avg)** | Rolling EMA over window | 214–242 bps | >280 bps |
| **Gross PnL (30m)** | Gross spread capture ($) | Positive | Negative trend |
| **Net PnL (30m)** | After fees + slippage ($) | Positive | Negative |
| **Inventory Skew** | Long/short bias | ±0.5 | >0.85 (extreme) |
| **Health State** | HEALTHY / DEGRADED / UNSAFE | HEALTHY | UNSAFE |
| **Risk State** | NORMAL / THROTTLED / HALTED | NORMAL | HALTED |

### Metrics Collection Points

1. **Dashboard:** Real-time monitoring via `http://127.0.0.1:8787` (telemetry snapshot)
2. **Fills File:** `data/fills.jsonl` (detailed per-fill records)
3. **Session Summary:** `data/sessions/` (aggregated run summary post-test)
4. **Parameters:** `data/params_state.json` (any adaptive parameter drift)

### Post-Test Analysis (Delivered by Quant Researcher)

1. **Fill Rate Distribution**
   - Total fills, fills per hour, fill rate (%)
   - Regime-wise breakdown (if multi-regime)
   - Latency-bucketed fills (0–50ms, 50–100ms, 100–200ms, >200ms)

2. **Adverse Selection Decomposition**
   - Rolling EMA (min, max, mean, std dev)
   - Regime-wise (low-vol vs. trending)
   - Latency impact on adverse selection (correlation)
   - Comparison to baseline 214–242 bps expectation

3. **Edge Realization vs. Theory**
   - Gross edge per fill (theoretical vs. observed)
   - Adverse selection cost per fill
   - Net edge per fill: gross − adverse selection
   - Expected edge: +73 bps; flag if <0 bps

4. **PnL Breakdown**
   - Gross PnL (fill spread capture)
   - Transaction costs (maker fees, taker fees)
   - Slippage (modeled in paper trader)
   - Net PnL (total)
   - Daily PnL annualization (if extrapolating to live)

5. **Health & Risk Observations**
   - Fraction of time in HEALTHY state
   - Any THROTTLED / HALTED events (trigger? duration?)
   - Inventory skew distribution (median, max, events >±0.85)
   - Rate of quote rejections (health penalties)

6. **Tactical Patterns**
   - One-sided quoting frequency (mode breakdowns)
   - Order refresh frequency and reason codes
   - Spread vs. regime mapping (verify no pathological behavior)
   - Auto-heal parameter drift (if any)

---

## Decision Logic

### GO Criteria (Proceed to Live with 600 bps Spread)

- [ ] Fill rate observed: ≥ 0.3% (achieved target fill rate)
- [ ] Net PnL positive (after fees, slippage, adverse selection)
- [ ] Adverse selection: 214–242 bps (no unexpected deterioration)
- [ ] Health state: HEALTHY >95% of time
- [ ] Risk state: NORMAL >99% of time (zero EMERGENCY events)

### MAYBE Criteria (Inconclusive, Proceed to Option B)

- [ ] Fill rate observed: 0.1–0.3% (marginal, inconclusive)
- [ ] Net PnL marginally positive OR break-even (within 10 bps per fill)
- [ ] Adverse selection: stays in expected range (214–242 bps)
- **Next step:** Escalate to Option B (latency optimization) for higher fill potential

### NO-GO Criteria (Immediately Proceed to Option B)

- [ ] Fill rate observed: < 0.1% (too sparse, not viable)
- **OR** Adverse selection broke out: > 280 bps (unexpected deterioration)
- **OR** Net PnL negative (edge insufficient to cover adverse selection)
- **Next step:** Escalate to Option B (latency optimization) required

---

## Deliverables (Quant Researcher)

### Synchronous (End of Test)
1. **Raw fill data:** `fills.jsonl` from test run (compressed if >50 MB)
2. **Session summary:** JSON from `data/sessions/` directory
3. **Parameters log:** `data/params_state.json` (capture state before/after)

### Analysis Report (Within 2 hours of test completion)
1. **Test Summary**
   - Test ID, start/end timestamp, total runtime
   - Parameter override applied
   - Any anomalies or early terminations

2. **Fill Rate Analysis** (1 figure, 1 table)
   - Time-series: fills per 30-min window
   - Regime breakdown (if applicable)
   - Overall fill rate (%)

3. **Adverse Selection Decomposition** (1 figure, 2 tables)
   - Rolling EMA over time (vs. 214–242 bps target band)
   - Regime-wise statistics
   - Latency-bucketed adverse selection

4. **Edge Realization** (1 table, 1 narrative)
   - Per-fill gross edge (theoretical vs. realized)
   - Per-fill adverse selection cost
   - Net edge per fill (should be ~+73 bps)
   - Any deviation from theory; root cause

5. **PnL Breakdown** (1 table, 1 chart)
   - Gross PnL, fees, slippage, net PnL
   - Daily annualization (if extrapolating to live)
   - Comparison to break-even (0 bps)

6. **Health & Risk Summary** (1 table)
   - Time in each health state (HEALTHY / DEGRADED / UNSAFE)
   - Time in each risk state (NORMAL / THROTTLED / HALTED)
   - Any trigger events and their duration

7. **Recommendation**
   - Decision: **GO** / **MAYBE** / **NO-GO** (with explicit rationale)
   - Confidence level (high / medium / low)
   - If MAYBE or NO-GO: specific conditions for revisiting this option

---

## Test Abort / Escalation Criteria

**Halt and escalate immediately if:**

1. **Fill rate < 0.1%** within first 3 hours
   - Reason: Insufficient data and likely not viable
   - Action: Stop test, escalate to Option B

2. **Adverse selection > 280 bps** consistently
   - Reason: Unexpected deterioration; something changed
   - Action: Stop test, investigate root cause, escalate to CTO

3. **Net PnL deeply negative** (>100 bps per fill loss) by hour 4
   - Reason: Edge insufficient to survive adverse selection
   - Action: Stop test, escalate to Option B immediately

4. **Bot crash or feed stall** lasting >10 minutes
   - Reason: Environmental issue, not a test signal
   - Action: Log incident, resolve if possible, resume test

---

## Example Monitoring Template (30-min snapshot)

```json
{
  "timestamp": "2026-04-17T12:30:00Z",
  "testId": "POL-30-OptA-600bps",
  "runElapsedHours": 1.5,
  "snapshot": {
    "fillCount30m": 2,
    "fillRate": "0.35%",
    "adverseSelectionEMA": "228 bps",
    "grossPnl30m": "$12.50",
    "netPnl30m": "$10.20",
    "inventorySkew": 0.15,
    "healthState": "HEALTHY",
    "riskState": "NORMAL",
    "quoteMode": "two_sided",
    "ordersActive": 4
  }
}
```

---

## Success / Failure Example Scenarios

### Scenario A: GO
- Fill rate: 0.42%
- Adverse selection: 218 bps (within range)
- Gross PnL: $320 over 8h
- Net PnL: $240 after fees/slippage
- Net edge per fill: +76 bps (vs. expected +73 bps)
- **Decision:** ✅ **GO** — Launch to live with 600 bps spread

### Scenario B: MAYBE
- Fill rate: 0.18% (below 0.3% target)
- Adverse selection: 225 bps (within range)
- Gross PnL: $90 over 8h
- Net PnL: $50 (marginal)
- Net edge per fill: +55 bps (vs. expected +73 bps)
- **Decision:** 🤔 **MAYBE** — Escalate to Option B (latency optimization) for higher volume

### Scenario C: NO-GO
- Fill rate: 0.06% (dropped below 0.1%)
- Early termination at 3 hours
- Adverse selection: 227 bps (stable)
- Gross PnL: $18
- Net PnL: $12
- **Decision:** ❌ **NO-GO** — Immediately proceed to Option B (latency optimization)

---

## Notes for CTO

1. **Parameter only:** Only override `QUOTE_BASE_HALF_SPREAD_BPS=300`. Do NOT adjust other spread parameters (avSpreadMinBps, avSpreadMaxBps, avMinEdgeBps).

2. **Paper mode:** Run in `MODE=paper` (or `dry_run`) to ensure fills are simulated realistically.

3. **Real feeds:** Use `DATA_SOURCE=real` to get realistic Polymarket + Binance signals.

4. **Bankroll:** Set `BANKROLL_USDC` appropriate for position sizing (e.g., 500–1000 for sizing to $15 quotes).

5. **Log verbosity:** Optional: set `LOG_LEVEL=debug` for richer fill / order lifecycle logs (useful for post-mortems).

6. **Fills capture:** Ensure `data/fills.jsonl` is captured at end of test for analysis. If test is long, compress and archive.

7. **Dashboard:** Optional: take periodic screenshots of the dashboard's "Fills" tab to capture real-time metrics.

---

## References

- **Parent Issue:** [POL-25](/POL/issues/POL-25) (H2 post-mortem and strategy options)
- **Option B (if triggered):** Latency optimization (TBD: separate issue)
- **Prior work:** POL-28 (baseline 300 bps test, fill rate 1.14%, negative edge)

