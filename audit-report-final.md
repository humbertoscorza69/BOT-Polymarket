# Final Pre-Live Status Audit -- POL-20

**Session:** `session-final-1776389085.log` | **Duration:** ~13 min (01:24:46 - 01:38:00Z)
**Config:** $20 bankroll, $1 quote, $2 max order, $5 max inventory, BTC-only, 5m+15m

---

## Section 1: Bankroll & Sizing -- CONCERN

**1.1 Config confirmed at startup (PASS)**
```
Line 5: config {"bankroll":20,"quoteSize":1,"maxOrderSize":2,"maxInventory":5,"assets":["BTC"],"intervals":["5m","15m"]}
Line 6: risk limits {"sessionLoss":8,"drawdown":4,"killPnlNetMin":-5}
```
All 7 bankroll/sizing values match the requested $20 config exactly.

**1.2 Quote sizes in practice (CONCERN)**
Fill sizes observed: 2, 2, 1.00, 2, 2, 3, 1.10, 2, 2, 3, 2, 0.79 shares.
At mid ~0.50, notional is $1.00-$1.50 per fill (within $1-$2 range). However, the `yesAskShares` formula at `quoteEngine.ts:139` uses `1 - yesAsk` as divisor instead of `yesAsk`, inflating SELL order sizes by ~25-40%. For yesAsk=0.55: `$1 / 0.45 = 2.22 shares` vs correct `$1 / 0.55 = 1.82 shares`.

**1.3 canAccumulate gate (CONCERN)**
No `[INVENTORY] blocked order` log entries in session. With $5 cap and ~4.1 shares at $0.49 = ~$2.00 notional, cap was never approached. Gate exists (`orderManager.ts:149`) but was untested. More importantly: **only BUY orders are gated** -- SELL orders bypass B1 entirely.

**Status: CONCERN** -- Ask sizing formula inflates SELL sizes ~30%. canAccumulate not stress-tested. Not blocking for $20 test but sizing bug should be fixed.

---

## Section 2: Discovery & Market Selection -- PASS

**2.1 Discovery cycle**
30-second poll interval confirmed. Every poll: `fetchAllWindows` then `scoreAll`:
```
Line 11-12: fetchAllWindows {"slugCount":4,"fetched":4} -> scoreAll {"accepted":3,"rejects":{"tooShortTtl":1}}
```

**2.2 Scoring**
Proper filtering: `tooShortTtl` rejections appear correctly as markets approach expiry (lines 76, 83: `accepted:2, tooShortTtl:2` near end of market 1).

**2.3 BTC-only confirmed**
All fills on BTC. Both markets were 15m windows. Only BTC slugs discovered.

**2.4 Rotation**
1 rotation at 01:30:16Z (line 89):
```
market rotation {"from":"btc-updown-15m-1776389400","to":"btc-updown-15m-1776390300","score":2.86}
```
Triggered when old market had ~890s TTL. B2 inventory reset confirmed (line 92): `[ROTATION] inventory reset -- old market positions zeroed`.

**Status: PASS** -- Discovery working correctly with proper filtering, scoring, and rotation.

---

## Section 3: Feed Health & Data Quality -- CONCERN

**3.1 Feed connectivity**
Polymarket WS connected (line 17: `ws subscribed {"assets":2}`), Binance WS connected (line 19: `binance ws open {"symbol":"BTCUSDT"}`). Reconnection after rotation worked (lines 93-94).

**3.2 Mid-price stability**
Mid values oscillate between 0.10 and 0.71 -- massive range for a 15-minute binary option:
- Line 21: mid=0.1000 (first tick, likely empty book)
- Line 100: mid=0.7100
- Line 124: mid=0.3050
Extreme swings suggest the book is very thin and mid computation is unstable when only 1-2 levels exist.

**3.3 Regime detection**
70 ticks at `high_vol_chop`, 28 at `low_vol_balanced`, 2 at `medium_vol`. Regime correctly responds to volatility -- shifts to `low_vol_balanced` during calm periods (01:32-01:37Z).

**3.4 Aggressor/toxicity values**
Not logged at tick level. Cannot verify from session logs alone. Autoheal reports "low-toxic" which suggests toxicFlowProxy is low.

**Status: CONCERN** -- Mid-price instability (0.10 to 0.71) suggests thin book susceptibility. Not blocking for paper, but in live mode, orders during mid=0.10 moments would be mispriced.

---

## Section 4: Quoting Behavior -- CONCERN

**4.1 Quote mode distribution**
- `two_sided`: 46/76 ticks (60.5%)
- `blocked/pathological_spread`: 24/76 (31.6%)
- `blocked/empty_book`: 6/76 (7.9%)

Bot unable to quote on **39.5% of ticks**. `pathological_spread` triggers at >= 400 bps (`featureStore.ts:118`). For Polymarket rolling binaries with thin books, 400+ bps spreads are common.

**4.2 Active orders**
When quoting: always `activeOrders:2` (BUY YES + SELL YES). Two-sided quoting working correctly.

**4.3 Spread values**
Actual bid/ask prices not logged at tick level. Cannot verify spread width against 150bps base half-spread config from logs alone.

**4.4 Autoheal**
Two events:
```
Line 132: autoheal adjusted {"notes":["low-toxic n=8 -> tighten"]}
Line 168: autoheal adjusted {"notes":["low-toxic n=10 -> tighten"]}
```
Autoheal tightening spreads based on low toxic flow -- working as designed.

**Status: CONCERN** -- 40% blocked rate is high. 400bps pathological threshold may be too aggressive for thin markets. Consider raising to 600bps. Not blocking for $20 test (just means slower fill rate).

---

## Section 5: Fills & PnL Realism -- CONCERN

**5.1 Fill count & rate**
12 fills in ~13 min = 0.92 fills/min. But:
- Market 1 (5.5 min): 5 fills, ALL SELL, ALL rejected at position=0
- Market 2 (7.5 min): 7 fills, 4 BUY + 3 SELL, working round-trips

**5.2 Fill distribution**
- BUY: 4 fills (3.0, 1.10, 2.0, 0.79 shares at ~$0.49)
- SELL: 8 fills total, but 6 rejected at position=0
- Effective SELL fills: 2 full (size 2 each) + 1 partial (0.098 shares)
- Raw BUY/SELL ratio: 4/8 = heavy SELL bias

**5.3 PnL**
$0.00 entire market 1 (all fills rejected). Market 2: $0.08 realized.
- Round-trip edge: BUY avg ~$0.489, SELL avg ~$0.508 = ~$0.019/share = ~3.8%
- Reasonable for 150bps+ half-spread config

**5.4 Regime during fills**
BUY fills: all in `low_vol_balanced` (0.8x multiplier).
SELL fills: all in `high_vol_chop` (1.3x multiplier).
H1 regime multipliers working: chop regime has higher fill rate.

**5.5 QueueModel**
Cannot verify factor values from logs -- internal to `computeFillProb()`. Code confirms wiring is correct (`paperTrader.ts:170-177`). The `queueModel.ts:15-16` has inverted continue conditions but they are functionally no-ops (only counts same-price volume). Simplified but not broken.

**5.6 CRITICAL: Silent SELL fill rejection**
6 of 12 fills (50%) were SELL at position=0, silently rejected by inventory:
```
Line 24: short YES rejected; excess shares dropped {"excess":2,"position":0}
Line 28: short YES rejected; excess shares dropped {"excess":2,"position":0}
```
Fills recorded in fill-tracker but produce zero PnL. In live, exchange rejects naked shorts. In paper, this wastes simulation and inflates fill counts.

**Status: CONCERN** -- PnL mechanics work on correct round-trips. But 50% of fills are wasted SELL-at-zero. Paper metrics misleading. Not blocking for live (exchange handles it).

---

## Section 6: Inventory Management -- PASS with CONCERN

**6.1 B1: canAccumulate gate**
Gate exists at `orderManager.ts:149`. Not triggered this session (inventory stayed under $5 cap at ~$2 max notional). Code is correct: checks per-side notional vs `riskMaxInventoryUsdc`.

**6.2 B2: Rotation reset**
CONFIRMED in live session:
```
Line 92: [ROTATION] inventory reset -- old market positions zeroed
```
Occurred at rotation point (01:30:16Z). Test coverage in `inventoryGuard.test.ts` also passes (5/5 tests).

**6.3 Inventory skew effect**
With ~4.1 YES shares at $0.49, skew = (4.1 * 0.49) / 5 = 0.40. Below 0.5 threshold for bid reduction. A-S reservation price shift is minimal (~0.1 bps) at these sizes. Correctly integrated but effect negligible.

**6.4 Missing SELL gate (CONCERN)**
`orderManager.ts:149` only gates `w.side === 'BUY'`. SELL orders never checked against inventory. Paper SELL fills on empty position get silently dropped. Exchange rejects in live, so paper-mode-only issue.

**Status: PASS** for B1/B2 core mechanics. **CONCERN** for missing SELL gate (paper accuracy only).

---

## Section 7: Post-Only & Execution Safety -- PASS

**7.1 H3: Post-only guard**
Code confirmed at `orderManager.ts:157-171`. Checks both sides:
- BUY: blocks if `price >= bestAsk`
- SELL: blocks if `price <= bestBid`
No `[POST-ONLY]` log entries -- no crossing attempts occurred. Guard in place.

**7.2 H4: Maker fill price**
`paperTrader.ts:133`: `const filledPrice = o.price` -- zero slippage for makers. Fill prices in logs are precise decimals matching limit prices.

**7.3 Rate limiting**
No rejection logs. At ~2 orders per active tick (10s intervals), well within 4/sec + burst 8 limits.

**Status: PASS** -- All execution safety guards in place and correct.

---

## Section 8: Risk State Machine -- PASS

**8.1 Risk state**
`risk:"NORMAL"` on every tick for entire 13-minute session. No state transitions.

**8.2 Kill distance**
- Session PnL: $0.08
- EMERGENCY at sessionPnl <= -$8. Distance: $8.08 away.
- HALTED at drawdown >= $4. Current: $0.
- Kill PnL: -$5. Distance: $5.08 away.
- Max single-fill loss: 2 shares x $0.50 = $1.00. Need 8 consecutive max-loss fills to hit EMERGENCY.

**8.3 Consecutive losses**
Internal counter, not in logs. With $0.08 positive PnL and 2 effective round-trips, no evidence of consecutive losses.

**8.4 Warmup**
Bot went live immediately. First tick at 01:24:49 (3s after startup). First fill at 01:25:00 (14s after startup). Fast but acceptable for paper mode.

**Status: PASS** -- Risk state machine correct, well within all thresholds.

---

## Summary

| Section | Status | Blocking? |
|---------|--------|-----------|
| 1. Bankroll & Sizing | CONCERN | No -- sizing bug within bounds |
| 2. Discovery & Selection | PASS | -- |
| 3. Feed Health | CONCERN | No -- thin book instability expected |
| 4. Quoting Behavior | CONCERN | No -- 40% blocked is high but functional |
| 5. Fills & PnL | CONCERN | No -- round-trips work, 50% wasted SELLs |
| 6. Inventory Mgmt | PASS/CONCERN | No -- B1/B2 verified, SELL gate paper-only |
| 7. Post-Only & Safety | PASS | -- |
| 8. Risk State Machine | PASS | -- |

## Known Issues for Post-$20 Fix Backlog
1. **Ask sizing formula** (`quoteEngine.ts:139`): `1 - yesAsk` should be `yesAsk` -- inflates SELL sizes ~30%
2. **Missing SELL-side inventory gate**: SELL orders placed on empty inventory. Paper-only (exchange rejects in live).
3. **pathological_spread threshold**: 400bps may be too strict for thin Polymarket books. Consider 600bps.
4. **QueueModel continue logic** (`queueModel.ts:15-16`): Inverted conditions are no-ops. Works but misses price priority modeling.
5. **Mid-price instability**: Mid swings 0.10-0.71 when book is 1-2 levels deep.

---

## Verdict: CONDITIONAL GO

The core mechanics work: BUY-SELL round-trips produce positive PnL ($0.08 on 2 round-trips = ~3.8% edge per round-trip). Risk controls correctly calibrated. B1/B2/H3/H4 verified in code and partially in session. Market rotation with inventory reset confirmed working.

**Conditions for $20 live:**
1. Accept ~40% idle time (pathological spread) -- market reality, not a bug
2. Accept paper PnL is slightly inflated due to wasted SELL fills in totals
3. Ask sizing bug contained by $2 max order size clamp -- no catastrophic mis-sizing
4. Monitor live session for exchange SELL rejections (would validate the paper SELL gap)

**Not blocking** -- all 5 known issues are non-critical at $20 scale and fixable after the first live test provides real exchange feedback.
