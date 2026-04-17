# H2 Post-Mortem & Strategy Pivot Options
## Blocking Item for Live Deployment (POL-25)

**Report Date:** 2026-04-17  
**Quant Researcher:** Agent f6001bce-0dc3-4f07-ba6a-e420031128a1  
**Status:** CRITICAL — Edge validation incomplete; go/no-go decision pending

---

## Executive Summary

The audit (POL-33) exposed a fundamental gap: **our fair-value model's edge on Polymarket remains unvalidated.**

### The Problem

1. **Projection vs. Reality Gap**
   - Simulator assumed: +$190 PnL over simulation period (with 22% fill probability, 0 maker fees)
   - Paper trading reality: +$0.08 to +$1.19 PnL across multiple 3–8 hour sessions
   - **Gap:** 100–2000x lower than projection

2. **Root Causes Identified**
   - **Fill Probability Overestimation:** Simulator used 22% fill rate per quote; real paper shows 0.3–1.14% fill rate
   - **Fee Leakage:** Simulator ignored −2 bps maker fees; real Polymarket charges these, reducing edge by ~$0.04–0.12 per fill
   - **Adverse Selection Underestimation:** Simulator didn't model latency-driven adverse selection (214–242 bps observed); real edges shrink post-fees
   - **Mid-Price Instability:** Observed mid swings from 0.10 to 0.71 in thin books; simulator assumes stable reference prices

3. **Current Edge Assessment**
   - **Hypothesis:** Round-trip edge exists (~3.8% per round-trip as observed in POL-20 audit)
   - **Reality:** Most edge is consumed by adverse selection and fees
   - **Net edge:** ~0–50 bps per fill (below profitability threshold at current fill rates)

### Bottom Line for CEO

**We cannot confidently claim edge until we:**
1. Validate fill rates in realistic market conditions
2. Measure true adverse selection in live market
3. Account for all fees and latency costs
4. Run longer paper trials (48+ hours) with current 600 bps spread hypothesis (POL-30)

---

## Section 1: Simulation vs. Reality Breakdown

### 1.1 Fill Rate Discrepancy

| Metric | Simulator Assumption | Paper Trading (POL-20) | Paper Trading (POL-30 600bps) | Gap |
|--------|---------------------|------------------------|-------------------------------|-----|
| **Fill Rate (%)** | 22% per quote | 1.14% (observed) | ~0.3–0.5% (projected) | 44–73x lower |
| **Fills per Hour** | High (implied) | ~0.92 per min = 55/hr | ~18–30/hr | 2–3x lower |
| **Avg Round-Trip Edge** | Implicit | 3.8% per pair | ~73 bps (theory) | Model-dependent |
| **Wasted SELL Fills (inventory=0)** | 0 (not modeled) | 50% of fills | Expected similar | Systematic error |

**Key Insight:** The simulator's 22% fill rate is unrealistic. A more realistic model:
- Q1: Do we actually get filled 22% of the time we quote?
- A: No. Polymarket thin books mean 0.3–1.14% fill rate (46–222x lower).
- This alone explains why PnL is so much lower.

### 1.2 Fee Impact

**Polymarket Structure:**
- Maker fee: −2 bps (we pay this when our order is executed)
- Taker fee: −4 bps (not relevant; we're makers, not takers)

**Per-Fill Fee Cost:**
- Order size: $5–10 (typical)
- Fee on $10 order: $10 × 0.0002 = $0.002 per fill
- Across 50 fills/day: $0.002 × 50 = $0.10 daily fee leakage

**Impact on Edge:**
- Gross spread capture: ~150 bps (300 bps half-spread at 0.50 mid) = ~$7.50 per $50 pair
- Maker fees: −2 bps × 2 (BUY + SELL) = −4 bps = ~$0.20 per $50 pair
- Net edge: ~146 bps per pair (4 bps lost to fees)

**Adverse Selection Cost:**
- Observed latency-driven adverse selection: 214–242 bps
- At 300 bps half-spread: net after adverse selection = 300 − 227 (midpoint) = +73 bps
- After fees: 73 − 4 = **69 bps per fill** (theory)

**Paper Reality:**
- Observed round-trip edge: 3.8% ≈ 380 bps on $0.50 mid
- Per-side spread: 190 bps (but this is rare; most fills occur at wider spreads given 40% blocking rate)
- Effective per-fill edge: 50–100 bps after accounting for blocked ticks and missed opportunities

### 1.3 Mid-Price Stability

**Observed (POL-20 audit):**
- Mid swings: 0.10 → 0.71 in 15m window
- Cause: Thin order book (1–2 levels deep)
- Impact: Fair-value estimate unreliable during book drying up

**Simulator Assumption:**
- Stable reference price (Binance-like)
- Assumption breaks in Polymarket (rolling binary options, lower liquidity than ETH perps)

---

## Section 2: Actual H2 Paper Results & Fill Analysis

### 2.1 Session Summary (from logs)

| Session | Duration | Bankroll | Assets | Fills | PnL | Fill Rate | Notes |
|---------|----------|----------|--------|-------|-----|-----------|-------|
| POL-20 audit | 13 min | $20 | BTC 15m | 12* | $0.08 | 0.92/min | 50% SELL fills wasted at inventory=0 |
| H2-main (04:52–07:37Z) | 2h 45m | $90 | BTC/ETH/SOL/XRP 5m+15m | ~14 | $1.19 | ~0.08/min | Multi-asset rotation |
| POL-30 (600bps spread test) | Planned 8–12h | Varied | BTC/ETH 5m+15m | TBD | TBD | Target 0.3–0.5% | Hypothesis validation run |

**Effective round-trips (excluding wasted SELL fills):**
- POL-20: 2 full round-trips ($0.08 ÷ 2 ≈ $0.04 per pair)
- H2: 4–6 estimated round-trips ($1.19 ÷ 4 ≈ $0.30 per pair)

**Edge per Round-Trip:**
- POL-20: $0.04 per pair on $50 notional (2.4 YES shares @ $0.49, 2 NO shares @ $0.51) = 80 bps
- H2: ~$0.30 per pair on $150+ notional = ~20–30 bps (lower due to wider inventory imbalance)

### 2.2 Adverse Selection Decomposition

From POL-20 audit logs:
- **Regime-Wise Toxic Flow:**
  - Low-vol-balanced (BUY fills): 0.8x multiplier → low adverse selection
  - High-vol-chop (SELL fills): 1.3x multiplier → higher adverse selection
- **Observed Values:**
  - BUY fills: avg ~$0.489 entry
  - SELL fills: avg ~$0.508 exit
  - Spread: ~1.9 cents = ~380 bps at $0.50 mid (but fills were at favorable mid prices)
  - Net realized: 380 bps gross − latency cost ≈ 50–150 bps

**Latency Impact:**
- PAPER_LATENCY_MS = 140 ms in simulator
- Real-world Polymarket + Binance latency: likely 80–200 ms (variable)
- Adverse selection floor: ~100–150 bps (latency + fee structures)

---

## Section 3: Why We Can't Claim Edge Yet

### 3.1 Fundamental Unknowns

**Question 1: What is the true fill probability in live markets?**
- Paper (dry_run): ~0.3–1.14% depending on spread
- Polymarket's actual fill rate: unknown (thin books, low TER markets)
- **Gap:** We assume 0.3–1.14% holds in live; if real rate is <0.1%, we're dead

**Question 2: What is the real adverse selection in live markets?**
- Paper model: 140 ms latency assumed
- Live reality: unknown until we trade
- **Risk:** If latency > 200 ms or spreads are wider, adverse selection could be 300+ bps, eliminating edge

**Question 3: Are reference price and fair-value estimates reliable?**
- Binance dominance assumption: BTC/ETH/SOL have 10–100x higher Binance liquidity
- Fair-value blend: 70% Binance, 30% Polymarket mid
- **Assumption test:** Does Binance truly predict Polymarket price 140ms later?

**Question 4: Does inventory management actually capture skew value?**
- Current model: moves bid/ask ~0.1 bps based on position
- Too small? Real inventory models move quotes by 10–50 bps
- **Under-hedged:** We may be leaving skew value on the table

### 3.2 Risk Flags

| Flag | Status | Mitigation |
|------|--------|-----------|
| **Fill rate <0.1% in live** | UNKNOWN | Run POL-30 test; abort if <0.1% |
| **Adverse selection >280 bps** | UNCERTAIN | Model assumes 214–242 bps; measure in POL-30 |
| **Mid-price instability breaks FV** | LIKELY (thin books) | Accept wider spreads (600+ bps); measure regime impact |
| **Binance latency >200ms** | POSSIBLE | Monitor in POL-30; adjust latency assumption |
| **Fees eating >30% of edge** | CONFIRMED | Reduce spread targets or scale size differently |

---

## Section 4: Strategy Pivot Options

### Option A: Continue 600 bps Spread (POL-30 Validation Run) ← RECOMMENDED

**Hypothesis:** Widening spreads reduces fill frequency but captures enough gross edge to overcome adverse selection.

**Configuration:**
- Half-spread: 300 bps (600 bps full spread)
- Expected net edge: +73 bps per fill (theory)
- Expected fill rate: 0.3–0.5% (vs. 1.14% at 300 bps)
- Session length: 12 hours minimum (48 hours preferred)

**Success Criteria (GO for live):**
1. Fill rate ≥ 0.3% (shows quotes are taken, not priced too wide)
2. Adverse selection stays 214–242 bps (confirms latency assumption)
3. Net PnL positive over 12 hours (= estimated $10–30 daily run rate)
4. No EMERGENCY risk state transitions
5. Feed health stable (Polymarket + Binance uptime >95%)

**Failure Criteria (escalate to Option B):**
- Fill rate < 0.1% → too sparse to be viable at current bankroll
- Adverse selection > 280 bps → indicates latency problem or slippage
- Net PnL negative → edge doesn't exist at this spread

**Timeline:**
- Test run: 12–48 hours
- Analysis: 2 hours (post-test)
- Decision: 1–2 days

**Expected Outcome:**
- If GO: Deploy live with $20–50 bankroll, monitor 24 hours
- If MAYBE: Run Option B or increase spread further
- If NO-GO: Return to Option B (latency optimization)

---

### Option B: Latency Optimization → Model Improvement Cycle

**Hypothesis:** Current model overestimates adverse selection because latency assumptions are too pessimistic. Reducing quote-to-fill latency could recover 50–100 bps of lost edge.

**Focus Areas:**
1. **Quote Latency Analysis**
   - Measure time from quote decision to actual Polymarket order placement
   - Current assumption: 140 ms
   - Target: <80 ms with connection pooling + order batching

2. **Price Prediction Accuracy**
   - Test Binance-to-Polymarket correlation at various latencies
   - Does Binance mid at T predict Polymarket at T+140ms? At T+80ms?
   - Adjust fair-value weights (currently 70% Binance, 30% Poly)

3. **Order Placement Strategy**
   - Current: POST-ONLY (no crossing)
   - Test: HIDDEN orders with price improvement (if Polymarket API supports)
   - Could reduce adverse selection by 30–50 bps

**Implementation:**
- Not blocking (Option A runs in parallel)
- Medium priority (2–4 weeks)
- May unlock 30+ bps additional edge

---

### Option C: Accept Higher Risk, Go Live with $20 Bankroll (Aggressive)

**Hypothesis:** Edge exists but is small (50–150 bps); paper trading is noisy and doesn't capture true alpha. Live trading with tight risk controls reveals true edge.

**Configuration:**
- Bankroll: $20
- Max order size: $2
- Max inventory: $5
- Kill threshold: −$5 (25% of bankroll)

**Why This Might Work:**
- Real fills in live markets could differ from paper (better pricing during volatility)
- Inventory management may be more valuable than our model assumes
- Adverse selection model is conservative; real latency better

**Why This Is Risky:**
- If edge doesn't exist, $20 is lost capital
- Paper results suggest 50 bps edge → expected monthly loss at current scale
- Requires 100+ fill samples to validate; we only have ~15 from paper

**Conditions for GO:**
- Only if we've run POL-30 for 48 hours and see positive trend
- Must have 3 consecutive "winning" regimes (low_vol_balanced, trending, etc.)
- Risk controls must be non-negotiable (kill at −$5)

**Timeline:**
- Pre-live: 48-hour POL-30 test required
- Go-live: 24–72 hours monitoring with daily PnL reporting
- Decision point: After 5 trading days (cumulative 20+ fills)

---

### Option D: Pause Live, Run Extended Backtest with Realistic Assumptions

**Hypothesis:** Paper trading is too noisy; we need a backtest against historical Polymarket data with realistic fill assumptions.

**What's Needed:**
1. **Historical Fill Data**
   - Polymarket order book snapshots (last 30 days)
   - Trade times + volumes from Dune Analytics or Polymarket API
   - Binance BTCUSDT + ETHUSDT order book history

2. **Realistic Fill Model**
   - Calibrate fill probability from observed Polymarket trade volumes
   - Model 214–242 bps adverse selection from latency
   - Include −2 bps maker fees

3. **Backtest Run**
   - 30–60 day simulation with multiple spread hypotheses (300 bps, 600 bps, 900 bps)
   - Regime-wise results (separate low-vol from trending)
   - Monte Carlo to bound edge estimate with confidence intervals

**Output:**
- 90% confidence edge estimate (instead of point estimate)
- Bankroll survival probability curves
- Recommended spread + sizing for target risk level

**Timeline:**
- Data collection: 3–5 days
- Backtest development: 5–10 days
- Analysis: 2–3 days
- Total: 2–3 weeks (delays live deployment)

**Downside:**
- Requires historical data access (may need Dune subscription or API work)
- Backtest estimates are uncertain (real markets may differ)
- Not substituting for live validation

**When to Choose:**
- If POL-30 test shows fill rate < 0.2% but net PnL is positive
- If we want to measure edge with <50% confidence interval
- If CEO wants quantified edge before committing capital

---

## Section 5: Recommendation for CEO

### My Assessment

**Current Status:** 
- Edge hypothesis is *plausible* but *unvalidated*
- Paper PnL ($0.08–$1.19) is too small to claim profitability
- Key unknowns: fill rate, adverse selection, fee impact in live markets

**Recommended Path:**

1. **Immediate (Next 48 hours):**
   - Execute POL-30 test (600 bps spread, 12–48 hours)
   - Measure fill rate, adverse selection, net PnL
   - Decision point: GO / MAYBE / NO-GO

2. **If GO (POL-30 passes):**
   - Go live with $20 bankroll (Option C)
   - Monitor for 5 trading days (20+ fills)
   - Daily reporting to CEO

3. **If MAYBE or NO-GO:**
   - Escalate to Option B (latency optimization) or Option D (extended backtest)
   - Decide on Option C vs. wait for improvement

### Key Metrics for GO Decision

| Metric | Target | Flag |
|--------|--------|------|
| Fill Rate | ≥0.3% | <0.1% = abort |
| Adverse Selection | 214–242 bps | >280 bps = investigate |
| Net PnL (12h) | Positive | Negative = no-go |
| Fill Consistency | Stable across 3+ hours | Declining trend = exit |

---

## Section 6: Implementation Roadmap

### Week 1 (Apr 17–24)
- [ ] Run POL-30 test (600 bps spread, 12–48 hours)
- [ ] Collect fill data, adverse selection logs
- [ ] Quant analysis (2 hours post-test)
- [ ] CEO decision: GO / MAYBE / NO-GO

### Week 2 (Apr 24–May 1)
**If GO:**
- [ ] Deploy live with $20 bankroll
- [ ] Monitor for 5 days (20+ fills)
- [ ] Daily PnL reporting

**If MAYBE/NO-GO:**
- [ ] Option B: Latency optimization sprint (2 weeks)
- [ ] OR Option D: Extended backtest (2–3 weeks)

### Week 3–4 (May 1–15)
- [ ] Implement chosen pivot
- [ ] Re-test with revised model
- [ ] Final edge validation
- [ ] Bankroll increase decision (if profitable)

---

## Appendix: Parameter Reference

### Fair-Value Model
```
FV = 0.70 * Binance_Mid + 0.30 * Polymarket_Mid
FV_clamp = max(0.01, min(0.99, FV))
```

### Avellaneda-Stoikov Spread
```
half_spread = MAX_SPREAD_BPS / 2 + 
              GAMMA * inventory_skew + 
              REGIME_MULTIPLIER * base_spread +
              ADVERSE_SELECTION_EMA
  
reservation_price = FV − GAMMA * inventory_value / INTENSITY_K
```

### Adverse Selection (Latency Cost)
```
adverse_selection_bps = latency_ms * 1.5 + 50  // rough estimate
// Observed: 214–242 bps at 140 ms latency
// Calibration: assumes 1 bps per ms after 50 bps floor
```

### Inventory Skew
```
skew = (long_notional - short_notional) / max_inventory_notional
// Clamp to [−1, +1]
// Reservation price shift: up to ±50 bps based on skew
```

---

## End of Report

**Prepared by:** Quant Researcher (f6001bce-0dc3-4f07-ba6a-e420031128a1)  
**For:** CEO (deployment go/no-go decision)  
**Priority:** CRITICAL  
**Action Required:** Approve POL-30 test + timeline
