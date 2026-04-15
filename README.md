# Polymarket Market Maker Bot

A professional-grade, modular market making system for Polymarket crypto event
contracts (BTC/ETH/SOL/DOGE/XRP/BNB/HYPE up-or-down in 5m/15m, etc.). Built in
TypeScript/Node.js. Includes real Polymarket + Binance feeds, Avellaneda-Stoikov
quoting, regime detection, adverse-selection-aware risk management, auto-healing
parameter adaptation, realistic paper trading, a live execution path via
`@polymarket/clob-client`, and a local observability dashboard.

> **WARNING: Live trading puts real capital at risk.** Read the whole file,
> especially the **"Going Live"** section. The default ships in `dry_run` mode.

## What the bot does

1. **Auto-discovers** the currently tradable crypto market that matches your
   target asset/interval list from the Polymarket Gamma API.
2. **Streams** real Polymarket order book updates over WebSocket and real
   Binance `bookTicker`, `depth`, `aggTrade` streams for the matching asset.
3. **Computes** features: microprice, depth imbalance, cross-venue pressure,
   aggressor ratio, momentum persistence, rolling vol, toxic-flow proxy, etc.
4. **Builds** an internal fair value by blending Polymarket microprice with
   Binance signals, weighted and clamped for stability.
5. **Quotes** using an Avellaneda-Stoikov reservation price + spread, adjusted
   by regime, health, adverse-selection EMA, inventory skew, and fees.
6. **Defends** against latency arbitrage by preemptively cancelling when
   Binance velocity / aggressor ratio spikes.
7. **Simulates fills honestly** in dry-run/paper (partials, missed fills,
   slippage, fees, toxicity, latency) so PnL is not fantasy.
8. **Manages** inventory, exposure, and a full risk state machine
   (NORMAL → THROTTLED → HALTED → EMERGENCY).
9. **Auto-heals** over time: widens/tightens, scales size, per-regime tuning
   persisted in `data/params_state.json`.
10. **Observes** everything through a local dashboard at
    `http://127.0.0.1:8787`.

## Architecture

```
src/
  index.ts                   # orchestration / main loop
  config.ts / env.ts         # typed, Zod-validated configuration
  types.ts                   # shared types

  adapters/
    discovery.ts             # Gamma-API-driven market discovery + rotation
    polymarketFeed.ts        # WS order-book feed + mid/micro/imbalance
    binanceFeed.ts           # WS bookTicker + depth + aggTrade + walls
    simFeed.ts               # synthetic feed for DATA_SOURCE=sim
    marketHistory.ts         # rolling history of selected markets

  core/
    featureStore.ts          # rolling features + EMAs
    fairValue.ts             # composite fair value model
    avellaneda.ts            # reservation price + optimal spread
    regime.ts                # FSM regime detection with hysteresis
    health.ts                # HEALTHY / DEGRADED / UNSAFE
    quoteEngine.ts           # final YES/NO bid/ask quotes
    paperTrader.ts           # realistic fill simulator
    pnl.ts                   # realized/unrealized/drawdown tracker
    adverseSelection.ts      # fill post-mortem + toxicity EMA
    riskManager.ts           # kill-switch state machine
    autoHealing.ts           # per-regime parameter adaptation
    telemetry.ts             # single pane of glass for dashboard
    queueModel.ts / toxicFlowModel.ts / liquidityModel.ts

  execution/
    clobDriver.ts            # @polymarket/clob-client wrapper
    orderManager.ts          # placement, drift, replace, cancel-all
    fillTracker.ts           # central fill record
    inventoryEngine.ts       # positions, avg costs, skew, MTM
    reconciler.ts            # balance / open-orders reconciliation
    liveExecutor.ts          # live-mode readiness gate
    rateLimiter.ts           # token-bucket for order calls
    cancelCoordinator.ts     # latency-arb defense

  dashboard/
    server.ts                # Express + SSE
    sse.ts                   # push hub
    serializers.ts           # safe JSON for UI

  persistence/
    jsonStore.ts             # atomic writes / JSONL helpers
    fillsStore.ts            # fills.jsonl
    sessionStore.ts          # per-run summaries
    paramsStore.ts           # adaptive parameter state
    snapshotStore.ts         # final telemetry snapshots

public/                      # local dashboard UI
data/                        # logs, fills, session summaries, params_state.json
tests/                       # vitest suites
```

## Install

```
npm install
cp .env.example .env
```

Then edit `.env`. The defaults run in `dry_run` mode with `real` data sources
— you can start without any API keys.

## Run modes

- `MODE=dry_run` – connects to real feeds, runs everything, but orders only
  simulate in the paper engine. **Safe default**.
- `MODE=paper` – same as dry_run (alias); placements never leave the machine.
- `MODE=live` – requires `LIVE_API_ENABLED=true` **and** Polymarket creds. Refuses
  to start otherwise. Sends real orders through the CLOB.

`DATA_SOURCE`:
- `real` – Polymarket WS + Binance WS (recommended)
- `sim` – synthetic feed for local testing without any network access

## Start

```
npm run build
npm run dev       # or: npm start (after build)
```

Open the dashboard at `http://127.0.0.1:8787` (or whatever you set in env).

## Environment Variables

See `.env.example` for the full list with defaults. Key ones:

| Var | Purpose |
| --- | --- |
| `MODE` | dry_run / paper / live |
| `DATA_SOURCE` | real / sim |
| `LIVE_API_ENABLED` | must be `true` to allow live orders |
| `TARGET_ASSETS` | e.g. `BTC,ETH,SOL` — bot picks the best active market from these |
| `TARGET_INTERVALS` | e.g. `5m,15m` |
| `BANKROLL_USDC` | used for sizing bounds + risk caps |
| `AV_GAMMA`/`AV_K` | Avellaneda-Stoikov risk aversion + intensity |
| `AV_SPREAD_MIN_BPS`/`AV_SPREAD_MAX_BPS` | clamp output spread |
| `AV_MIN_EDGE_BPS` | minimum half-spread after fees |
| `RISK_*` | session loss cap, drawdown cap, consecutive loss cap, etc. |
| `POLY_PRIVATE_KEY` / `POLY_FUNDER_ADDRESS` / `POLY_API_*` | live creds |
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | local UI binding |
| `DISCORD_WEBHOOK_URL` | (optional) alerts |

## Switching assets

Just edit `TARGET_ASSETS=DOGE,HYPE` in `.env` and restart. No code changes.
The bot's discovery engine will pick the best tradable market that matches.

## What to monitor before going live

1. Run at least a full session in `dry_run` on `real` feeds. Confirm:
   - Fills arrive with realistic frequency.
   - PnL history is not unrealistic (gross dominated by fees + slippage).
   - Adverse-selection EMA stays below `RISK_TOXIC_FLOW_EMA_CAP`.
   - Regime transitions are sensible (check dashboard).
   - Risk state remains NORMAL most of the time.
2. Verify that the dashboard's "Discovery" panel rotates correctly across
   contract expiries.
3. Confirm Polymarket + Binance WebSockets reconnect cleanly (unplug / replug
   your network and watch the Feeds card).
4. Fund a small wallet (e.g. $20) and set `MAX_ORDER_SIZE_USDC=2` for a first
   live test.
5. Flip `LIVE_API_ENABLED=true` and `MODE=live`. The bot will require
   `POLY_PRIVATE_KEY` + `POLY_FUNDER_ADDRESS` and will bail out if balance is
   zero or reconciliation fails.

## Going Live

```
MODE=live
LIVE_API_ENABLED=true
POLY_PRIVATE_KEY=0x...
POLY_FUNDER_ADDRESS=0x...
POLY_API_KEY=...        # optional; bot can derive these
POLY_API_SECRET=...
POLY_API_PASSPHRASE=...
MAX_ORDER_SIZE_USDC=5
BANKROLL_USDC=50
```

The live bootstrap sequence:
1. Init CLOB client with your wallet.
2. Fetch live balance; refuse to start if zero.
3. Run reconciliation (open orders + balance); refuse to start on failure.
4. Start periodic reconciliation every 2 minutes.
5. Only then allow `OrderManager` to place live orders.

## Troubleshooting

- **No market selected**: check `TARGET_ASSETS` and `TARGET_INTERVALS`; make
  sure Gamma API is reachable.
- **Feed stale warnings**: Polymarket WS is intermittent at times. The bot
  will keep reconnecting with exponential backoff + jitter.
- **Binance unavailable**: bot degrades to Polymarket-only; quotes will be
  wider.
- **EMERGENCY risk state**: session loss cap hit. Requires manual restart.
- **Reject bursts**: the order manager will track rejections; health engine
  adds a penalty; risk manager may throttle.
- **CLOB client not installed**: live trading requires `@polymarket/clob-client`
  to resolve. `dry_run` and `paper` work without it.

## Known assumptions and limitations

- The exact schema returned by Polymarket's Gamma API changes occasionally;
  `discovery.ts::parseGammaMarket` copes with several variants but you may
  need to adjust if Polymarket ships a breaking change.
- `@polymarket/clob-client`'s API surface evolves. The driver probes method
  availability at runtime and logs what it can do.
- The queue model is a placeholder; real maker queueing on Polymarket is
  not transparent without per-level timestamps. Fill simulation in paper
  mode is realistic in aggregate, not at the microstructure-exact level.
- Only YES buys/sells are used as the primary inventory axis; NO is mirrored
  where sensible. Complementary-token arbitrage is not exploited (intentional:
  Polymarket enforces the 1-1 complement and fees make it marginal).

## Tests

```
npm test
```

Covers: Avellaneda math invariants, regime transitions, health classification,
quote engine clamps/blocks, risk state transitions, discovery scoring, paper
trader lifecycle, adverse selection tracking.
