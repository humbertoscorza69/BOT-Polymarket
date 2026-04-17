#!/bin/bash
# Paperclip Phase 3B Incident Report Posting
# Requires: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID
# Usage: ./scripts/paperclip-phase3b-incident.sh

set -e

ISSUE_ID="POL-17"
AGENT_ID="f6001bce-0dc3-4f07-ba6a-e420031128a1"
COMPANY_ID="e8b5521c-e603-458d-a0a9-a351e75dd102"

# Verify environment
if [ -z "$PAPERCLIP_API_URL" ] || [ -z "$PAPERCLIP_API_KEY" ] || [ -z "$PAPERCLIP_RUN_ID" ]; then
  echo "ERROR: Missing Paperclip credentials (PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID)"
  exit 1
fi

echo "[1/4] Checking out POL-17..."
curl -s -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/checkout" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\": \"$AGENT_ID\", \"expectedStatuses\": [\"todo\", \"in_progress\", \"blocked\"]}" \
  | jq '.' || {
    echo "Checkout failed or task already checked out by another agent"
    exit 1
  }

echo "[2/4] Posting incident report comment..."

# Read the incident report from the action plan
INCIDENT_COMMENT=$(cat <<'EOF'
## Phase 3B H2 Critical Incident Report

**Status:** SESSION TERMINATED | AWAITING STRATEGIC DECISION

### Incident Summary

- **Duration:** 2026-04-17T04:52:42Z → 2026-04-17T07:37:08Z (2h 44m 26s)
- **Fills:** 14 @ 100% fill rate (target: <30%)
- **Adverse Selection:** 256 bps/fill (target: 15-40 bps = 6.4x violation)
- **Final Inventory:** 5.95 shares (survived due to late unwinding; limit: 40)
- **PnL:** $119.05 gross (11,905 bps)

### CRITICAL DISCOVERY: Kill Threshold Monitoring COMPLETELY FAILED

All 1,780 CSV rows show `kill_threshold_breached="PASS"` despite simultaneous critical violations:
- Fill rate exceeds 30% target throughout session (actual: 100%)
- Adverse selection exceeds 40 bps limit throughout session (actual: 256 bps)
- **No circuit breaker triggered** despite clearly defined thresholds

This allowed the session to run for 2h 44m in complete failure state, accumulating losses that would have been prevented by working risk controls.

### Root Cause: Fair-Value Model Structurally Incompatible with Polymarket

**H2 Parameters (Correct per .env and POL-23):**
- Quote base half-spread: 300 bps
- Regime sensitivity: 2
- Discovery max spread: 300 bps

**What Actually Happened:**
- Bot quotes at 300 bps intended spread
- Counterparties pick off the ~256 bps inner portion
- Fills execute at adverse prices relative to mid
- Result: Realized spread = Adverse selection = 256 bps (zero capture)

**Interpretation:** The Binance shrink fair-value model places quotes at prices where counterparties prefer to hit them. This indicates the model fundamentally underestimates the true mid-price on Polymarket's CLOB structure.

This is the SAME failure pattern as H1, just at higher spread magnitude. **The problem is structural, not configurational.**

### Why Session Continued in Failure State

After manual termination of PID 27067, a new process (PID 36230) automatically spawned and continued trading without intervention. Suggests undocumented process resurrection mechanism (supervisor/daemon or state file recovery). This caused additional accumulation from 2026-04-17T06:43Z to 2026-04-17T07:37Z.

### Strategic Options (CEO/CTO Decision Required)

**Option A: Fair-Value Model Research**
- Timeline: 2-3 weeks research + implementation + revalidation
- Activities: Study Polymarket order book depth curves, fill probability functions, build new pricing model
- Risk: May discover MM is unprofitable at this venue
- Benefit: If successful, unlocks viable MM strategy with correct pricing

**Option B: Strategy Pivot**
- Timeline: 1-2 weeks signal development + backtesting
- Activities: Order-flow detection or Polymarket ↔ Binance arbitrage
- Risk: Requires infrastructure ramp-up, different latency tolerance
- Benefit: May be higher-Sharpe strategy if MM is fundamentally broken

**Status:** CANNOT PROCEED with further MM testing. Running H2 again would replicate the same failure.

### Critical Bugs Identified

- **Kill Threshold Monitoring (POL-26):** Blind spot at 100% fill rates; all rows show PASS despite violations
- **Process Resurrection (POL-27):** Undocumented mechanism spawned new process after manual kill
- **Fair-Value Model:** Requires strategic decision before any research allocation

### Documentation

- Full incident analysis: `/memory/incident_h2_phase3b_critical_20260417.md`
- Final metrics: `paper-trading-metrics-2026-04-17T04-52-42-757Z.csv` (1,780 rows, 2h 44m of trading)
- Session log: `session-h2-1776401561.log` (12,623 lines, shows warnings about adverse selection approaching limit but no kill trigger)

### Recommendation

**Immediate Actions:**
1. Convene emergency strategy meeting (CEO + CTO + Quant team) to decide Option A or Option B
2. Do NOT run H2 again with current parameters
3. Do NOT proceed with T+12h or T+24h gate analyses until strategic decision is made

**Escalation Path:**
- Blocked on CEO/CTO strategic decision
- Cannot recommend further testing without fair-value model fix or strategy pivot
- Risk framework has critical blind spot that allowed 2h+ session in failure state
EOF
)

# Post as comment
curl -s -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{\"body\": $(echo "$INCIDENT_COMMENT" | jq -Rs .)}" \
  | jq '.id' || {
    echo "Failed to post comment"
    exit 1
  }

echo "[3/4] Updating POL-17 status to blocked..."
curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "blocked"}' \
  | jq '.status' || {
    echo "Failed to update status"
    exit 1
  }

echo "[4/4] Creating approval request for CEO strategic decision..."
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"request_board_approval\",
    \"requestedByAgentId\": \"$AGENT_ID\",
    \"issueIds\": [\"$ISSUE_ID\"],
    \"payload\": {
      \"title\": \"Strategic Decision: Fair-Value Model Research vs. Strategy Pivot\",
      \"summary\": \"Phase 3B H2 hypothesis testing has failed completely. Fair-value model is structurally incompatible with Polymarket CLOB. Choose: (A) 2-3 week research to build Polymarket-native fair-value model, or (B) 1-2 week pivot to order-flow/arbitrage strategy.\",
      \"recommendedAction\": \"Convene emergency strategy meeting to choose Option A or B. Do not resume MM testing without strategic decision and fair-value model fix.\",
      \"risks\": [
        \"Option A may reveal MM is fundamentally unprofitable at this venue\",
        \"Option B requires infrastructure and capability ramp-up\",
        \"Continued MM testing without fix will replicate same failure and accumulate losses\"
      ]
    }
  }" \
  | jq '.id' || {
    echo "Failed to create approval request"
    exit 1
  }

echo ""
echo "✓ Phase 3B incident report successfully posted to POL-17"
echo "✓ Status set to blocked pending CEO/CTO decision"
echo "✓ Approval request created for strategic direction"
echo ""
echo "Next action: Await CEO/CTO response on Option A vs Option B"
