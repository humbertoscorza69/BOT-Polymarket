# POL-30 Test Execution Checklist (for CTO)

**Test ID:** POL-30-OptA-600bps  
**Objective:** Validate 600 bps spread hypothesis (Option A)  
**Duration:** 8–12 hours continuous paper trading  
**Expected Outcome:** Fill rate ≥0.3% AND net PnL positive

---

## Pre-Test Setup (5 min)

- [ ] Read `POL-30-Test-Specification.md` (full context)
- [ ] Verify bot repo is clean: `git status` (no uncommitted changes)
- [ ] Ensure environment variables are loaded from `.env`

## Test Parameter Configuration (2 min)

Edit `.env` and set:

```bash
# REQUIRED CHANGE:
QUOTE_BASE_HALF_SPREAD_BPS=300

# Verification (should NOT change these):
# MODE=paper  (or dry_run)
# DATA_SOURCE=real
# PAPER_LATENCY_MS=140
# AV_GAMMA=0.8
# AV_K=1.5
# (all other spread params unchanged)
```

Or run inline:
```bash
QUOTE_BASE_HALF_SPREAD_BPS=300 npm run dev
```

## Run Test (8–12 hours)

- [ ] Start bot: `npm run build && npm run dev`
- [ ] Verify bot is running: check dashboard at `http://127.0.0.1:8787`
- [ ] Confirm market selected and quoting started (watch Order book, Quotes tabs)

### Real-Time Monitoring (every 30 min)

Take a snapshot every 30 min:

| Time | Fills (30m) | Fill Rate | Adv.Sel (avg) | Health | Risk | Notes |
|------|-------------|-----------|---------------|--------|------|-------|
| 0:30 |    _        |    _      |       _       |   _    |  _   |       |
| 1:00 |    _        |    _      |       _       |   _    |  _   |       |
| 1:30 |    _        |    _      |       _       |   _    |  _   |       |
| ... | ... | ... | ... | ... | ... | ... |

**Abort conditions (stop immediately if):**
- Fill rate drops below 0.1% within 3 hours → escalate to Option B
- Adverse selection consistently > 280 bps → investigate + escalate
- Bot crashes or feed stalls > 10 min → restart and resume
- Risk state = EMERGENCY → stop and report

## End of Test (5 min)

Once test duration reached:

- [ ] Stop bot: Ctrl+C
- [ ] Archive results:
  ```bash
  # Capture fills
  cp data/fills.jsonl data/fills-POL30-$(date +%Y%m%d-%H%M%S).jsonl
  
  # Capture session summary
  ls data/sessions/
  cp data/sessions/latest.json data/sessions/POL30-session.json
  
  # Capture final params state
  cp data/params_state.json data/params-POL30-$(date +%Y%m%d-%H%M%S).json
  ```

- [ ] Verify files exist and are non-empty:
  ```bash
  wc -l data/fills.jsonl
  du -h data/fills*.jsonl data/sessions/POL30*
  ```

## Hand-Off to Quant Researcher (2 min)

- [ ] Post Paperclip comment on [POL-30](/POL/issues/POL-30):
  ```
  Test execution complete.
  - Duration: [X hours]
  - Fills: [N]
  - Approx fill rate: [Y%]
  - Key observations: [brief notes on health, risk, feed quality, etc.]
  - Files: data/fills.jsonl, data/sessions/POL30-session.json
  ```

- [ ] Quant Researcher will run analysis:
  ```bash
  python analyze-pol30-test.py data/fills.jsonl POL-30-Analysis.md
  ```

- [ ] Analysis report delivered within 2 hours with GO/MAYBE/NO-GO decision

---

## Troubleshooting

| Issue | Check | Action |
|-------|-------|--------|
| Bot won't start | `npm install` complete? | `npm install && npm run build` |
| No market selected | TARGET_ASSETS, TARGET_INTERVALS in .env | Update and restart |
| Dashboard 404 | Port 8787 bound? | Check `netstat -an \| grep 8787` |
| Feed stale warnings | Normal (Poly WS is flaky) | Monitor; bot will reconnect |
| Fills.jsonl empty | Check MODE, DATA_SOURCE | Ensure MODE=paper/dry_run, DATA_SOURCE=real |
| Adverse selection broken | Not in fill records | Proceed with analysis; may need backfill |

---

## Quick Facts

- **Spread change:** 300 bps → 600 bps (half-spread: 150 → 300 bps)
- **Expected fill rate:** 0.3–0.5% (was 1.14%)
- **Expected edge:** +73 bps per fill (was −77 bps)
- **Success:** Fill rate ≥0.3% AND net PnL positive
- **Abort:** Fill rate <0.1% (too sparse) or adverse selection >280 bps

---

## Questions?

See `POL-30-Test-Specification.md` for full context.  
Quant Researcher: available for real-time questions during test.
