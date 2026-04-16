import { buildConfig, BotConfig } from './config';
import { initRootLogger, getLogger, flushLogs } from './utils/logger';
import { getPol2Params } from './env';
import { DiscoveryEngine } from './adapters/discovery';
import { PolymarketFeed } from './adapters/polymarketFeed';
import { BinanceFeed } from './adapters/binanceFeed';
import { SimFeed } from './adapters/simFeed';
import { MarketHistory } from './adapters/marketHistory';
import { FeatureStore } from './core/featureStore';
import { FairValueModel } from './core/fairValue';
import { AvellanedaStoikov } from './core/avellaneda';
import { QuoteEngine } from './core/quoteEngine';
import { RegimeDetector } from './core/regime';
import { HealthEngine } from './core/health';
import { PnlTracker } from './core/pnl';
import { AdverseSelectionDetector } from './core/adverseSelection';
import { RiskManager } from './core/riskManager';
import { AutoHealing } from './core/autoHealing';
import { PaperTrader } from './core/paperTrader';
import { TelemetryHub } from './core/telemetry';
import { MetricsCalculator, DEFAULT_KILL_THRESHOLDS, PaperTradingMetrics } from './core/metricsCalculator';
import { MetricsExporter } from './core/metricsExporter';
import { KillThresholdMonitor } from './core/killThresholdMonitor';
import { CancelCoordinator } from './execution/cancelCoordinator';
import { InventoryEngine } from './execution/inventoryEngine';
import { OrderManager } from './execution/orderManager';
import { FillTracker } from './execution/fillTracker';
import { ClobDriver } from './execution/clobDriver';
import { Reconciler } from './execution/reconciler';
import { LiveExecutor } from './execution/liveExecutor';
import { DashboardServer } from './dashboard/server';
import { FillsStore } from './persistence/fillsStore';
import { SessionStore } from './persistence/sessionStore';
import { SnapshotStore } from './persistence/snapshotStore';
import { ParamsStore, defaultAdaptiveParams } from './persistence/paramsStore';
import {
  BinanceSnapshot,
  Fill,
  PolymarketMarket,
  PolySnapshot,
  SessionSummary,
} from './types';

async function main(): Promise<void> {
  const cfg: BotConfig = buildConfig();
  const rootLogger = initRootLogger(cfg.logLevel, `${cfg.logsDir}/${cfg.runId}.log`);
  const log = getLogger('main');

  log.info('[BOOT] process started', { pid: process.pid, nodeVersion: process.version });
  log.info('╔══════════════════════════════════════════════════════╗');
  log.info('║   POLYMARKET MARKET MAKER BOT  —  STARTUP            ║');
  log.info('╚══════════════════════════════════════════════════════╝');
  log.info('config', {
    mode: cfg.mode,
    dataSource: cfg.dataSource,
    liveApiEnabled: cfg.liveApiEnabled,
    bankroll: cfg.bankrollUsdc,
    assets: cfg.targetAssets,
    intervals: cfg.targetIntervals,
    runId: cfg.runId,
  });
  log.info('POL-2 parameters', getPol2Params(cfg));
  if (cfg.mode === 'live') {
    log.warn('★★★ LIVE MODE — REAL ORDERS WILL BE PLACED ★★★');
  }

  // Persistence
  const fillsStore = new FillsStore(cfg.fillsFile);
  const sessionStore = new SessionStore(cfg.sessionsDir);
  const snapshotStore = new SnapshotStore(cfg.snapshotsDir);
  const paramsStore = new ParamsStore(cfg.paramsStateFile, defaultAdaptiveParams(cfg.avGamma, cfg.avK));

  // Core engines
  const featureStore = new FeatureStore();
  const fair = new FairValueModel(cfg);
  const avellaneda = new AvellanedaStoikov(cfg);
  const quoteEngine = new QuoteEngine(cfg, fair, avellaneda);
  const regime = new RegimeDetector();
  const health = new HealthEngine(cfg);
  const pnl = new PnlTracker();
  const inventory = new InventoryEngine(cfg);
  const adverse = new AdverseSelectionDetector(cfg);
  const risk = new RiskManager(cfg);
  const autoheal = new AutoHealing(cfg, paramsStore, () => adverse.getEma());

  // Metrics framework (POL-14/POL-15)
  const metricsCalc = new MetricsCalculator();
  const metricsExporter = new MetricsExporter('./data/metrics');
  const killMonitor = new KillThresholdMonitor(DEFAULT_KILL_THRESHOLDS);
  const metricsHistory: PaperTradingMetrics[] = [];
  const sessionStartTime = cfg.startTs;

  // Execution
  const cancelCoord = new CancelCoordinator({
    velocityBpsTrigger: cfg.cancelVelocityBpsTrigger,
    aggressorTrigger: cfg.cancelAggressorTrigger,
    freezeMs: cfg.cancelFreezeMs,
  });
  const paper = new PaperTrader(cfg);
  const clob = new ClobDriver(cfg);
  const reconciler = new Reconciler(cfg, clob, inventory);
  const liveExec = new LiveExecutor(cfg, clob, reconciler);
  const orderManager = new OrderManager({
    mode: cfg.mode,
    cfg,
    paper,
    clob,
  });
  const fills = new FillTracker();

  // Telemetry + dashboard
  const telemetry = new TelemetryHub();
  const dashboard = new DashboardServer(cfg, telemetry);

  // Feeds
  const discovery = new DiscoveryEngine(cfg, {
    targetAssets: cfg.targetAssets,
    targetIntervals: cfg.targetIntervals,
    minLiquidityScore: cfg.discoveryMinLiquidityScore,
    prewarmSecs: cfg.discoveryPrewarmSecs,
    gammaUrl: cfg.polymarketGamma,
    pollMs: cfg.discoveryPollMs,
  });
  const marketHistory = new MarketHistory();
  const polyFeed = new PolymarketFeed(cfg);
  const binanceFeed = new BinanceFeed(cfg);
  const simFeed = new SimFeed(cfg);

  // Wire feeds
  let lastPoly: PolySnapshot | null = null;
  let lastBin: BinanceSnapshot | null = null;
  let lastFeatures: ReturnType<FeatureStore['update']> = null;
  let currentMarket: PolymarketMarket | null = null;

  const onPoly = (p: PolySnapshot): void => {
    lastPoly = p;
    paper.onPoly(p);
    inventory.markToMarket(p.midYes);
  };
  const onBin = (b: BinanceSnapshot): void => {
    lastBin = b;
  };

  if (cfg.dataSource === 'sim') {
    simFeed.on('polySnapshot', onPoly);
    simFeed.on('binanceSnapshot', onBin);
  } else {
    polyFeed.on('snapshot', onPoly);
    binanceFeed.on('snapshot', onBin);
  }

  // Discovery wires markets into everything that needs them
  discovery.on('rotation', ({ market }: { market: PolymarketMarket }) => {
    log.info('rotating market', { slug: market.slug });
    currentMarket = market;
    marketHistory.record(market, 'discovery');
    if (cfg.dataSource === 'sim') {
      simFeed.setMarket(market);
    } else {
      polyFeed.setMarket(market);
      const asset = detectPrimaryAsset(market, cfg.targetAssets);
      if (asset) binanceFeed.setAsset(asset);
    }
    orderManager.setMarket(market);
  });

  // Fill processing pipeline
  orderManager.on('fill', (fill: Fill) => {
    fills.record(fill);
    fillsStore.append(fill);
    const realizedDelta = inventory.applyFill(fill);
    pnl.recordFillRealized(fill, realizedDelta);
    adverse.onFill(fill, lastFeatures);
    autoheal.onFill(fill, realizedDelta, adverse.getEma());
    metricsCalc.recordFill(fill);
    log.info('fill', {
      side: fill.side,
      token: fill.token,
      price: fill.price?.toFixed(4),
      size: fill.size?.toFixed(2),
      regime: fill.regime,
      pnl: pnl.state().net?.toFixed(2),
    });
  });

  // latency arb defense wiring
  cancelCoord.on('cancelAll', (reason: string) => {
    log.info('latency-arb trigger', { reason });
    orderManager.cancelAll(reason).catch((e) => log.warn('cancelAll error', { err: String(e) }));
  });

  // Start services
  log.info('[BOOT] starting services');
  dashboard.start();
  adverse.start(() => (lastPoly?.midYes ?? null));
  paper.start();
  autoheal.start();

  if (cfg.mode === 'live') {
    const ok = await liveExec.bootstrap();
    if (!ok) {
      log.error('live bootstrap failed; exiting to protect funds');
      process.exit(2);
    }
  }

  if (cfg.dataSource === 'real') {
    log.info('[BOOT] starting real feeds (discovery + poly + binance)');
    await discovery.start();
    polyFeed.start();
    binanceFeed.start();
  } else {
    simFeed.start();
    // fabricate a sim market and rotate
    const simMkt: PolymarketMarket = {
      conditionId: 'sim_cond_1',
      slug: 'sim-btc-5m',
      question: 'SIM: BTC up in next 5 minutes?',
      yesTokenId: 'sim_yes',
      noTokenId: 'sim_no',
      endDateTs: Math.floor(Date.now() / 1000) + 300,
      active: true,
      closed: false,
      tags: ['5m', 'btc'],
      category: 'Crypto',
    };
    discovery.emit('rotation', { market: simMkt });
  }

  let tickCount = 0;

  // Main tick: compute features, regime, health, quote, and push telemetry.
  const tickTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      if (!lastPoly || !currentMarket) return;
      const asset = detectPrimaryAsset(currentMarket, cfg.targetAssets) || cfg.targetAssets[0];
      const interval = detectPrimaryInterval(currentMarket, cfg.targetIntervals) || cfg.targetIntervals[0];
      const features = featureStore.update(lastPoly, lastBin, asset, interval);
      if (!features) return;
      lastFeatures = features;
      tickCount++;
      const regSnap = regime.update(features);
      metricsCalc.recordRegimeTransition(regSnap.current);

      // Track stale price events for metrics
      if (lastPoly.stale) {
        metricsCalc.recordStalePriceEvent();
      }

      // Track emergency mode triggers (inventory > 80% of max)
      const invUtilPct = (Math.abs(inventory.state.yesPosition) / cfg.inventoryMaxShares) * 100;
      if (invUtilPct >= cfg.inventoryEmergencyThresholdPct) {
        metricsCalc.recordEmergencyModeTriggered();
      }

      const healthSnap = health.evaluate({
        poly: lastPoly,
        bin: lastBin,
        features,
        apiErrorRate: clob.apiErrorCount / Math.max(1, cfg.riskApiErrorCap) * 0.5,
        adverseSelectionEma: adverse.getEma(),
        orderRejectionRate: orderManager.getRejectionsCount() / Math.max(1, orderManager.getReplaceCount() + 10),
        polyReconnects: polyFeed.reconnects,
        binReconnects: binanceFeed.reconnects,
      });
      paper.onFeatures(features, regSnap.current);

      cancelCoord.feed(lastBin, features);

      const riskState = risk.evaluate({
        sessionPnl: pnl.state().net,
        peakPnl: pnl.state().peak,
        consecutiveLosses: pnl.state().consecutiveLosses,
        adverseSelectionEma: adverse.getEma(),
        apiErrors: clob.apiErrorCount,
        feedStale: lastPoly.stale,
        orderRejections: orderManager.getRejectionsCount(),
        reconcileDrift: reconciler.getLast().drift === true && cfg.mode === 'live',
        inventory: inventory.state,
      });

      const params = paramsStore.get();
      const quote = quoteEngine.quote({
        features,
        regime: regSnap,
        health: healthSnap,
        inventory: inventory.state,
        riskState,
        params,
        preemptiveCancelActive: cancelCoord.isActive(),
      });

      if (tickCount % 20 === 1) {
        log.info('tick', {
          asset,
          interval,
          mid: features.midYes?.toFixed(4),
          regime: regSnap.current,
          risk: riskState,
          quoteMode: quote.mode,
          blockedReason: quote.blockedReason,
          fills: pnl.state().totalFills,
          pnl: pnl.state().net?.toFixed(2),
          activeOrders: orderManager.getActive().length,
        });
      }

      // Apply quote to order manager (paper or live)
      if (cfg.mode !== 'live' || liveExec.isReady()) {
        orderManager.applyQuote(quote).catch((e) => log.warn('applyQuote error', { err: String(e) }));
      }

      telemetry.updatePartial({
        runId: cfg.runId,
        mode: cfg.mode,
        poly: lastPoly,
        bin: lastBin,
        features,
        quote,
        regime: regSnap,
        health: healthSnap,
        inventory: inventory.state,
        pnl: pnl.state(),
        risk: { state: riskState, events: risk.getEvents() },
        discovery: discovery.getReport(),
        params,
        activeOrders: orderManager.getActive(),
        recentFills: fills.recent(50),
        advStats: { ...adverse.stats(), recent: adverse.recent(30) },
        feedHealth: {
          polyReconnects: polyFeed.reconnects,
          binReconnects: binanceFeed.reconnects,
          polyAgeMs: lastPoly.feedAgeMs,
          binAgeMs: lastBin?.feedAgeMs ?? null,
          polyStale: lastPoly.stale,
          binStale: lastBin?.stale ?? false,
        },
        latencyArb: cancelCoord.snapshot(),
        autohealChanges: autoheal.recentChanges(),
        live: {
          enabled: cfg.liveApiEnabled && cfg.mode === 'live',
          driverHealthy: clob.isAvailable,
          reconciledOk: reconciler.getLast().ok,
          openOrderCount: reconciler.getLast().openOrderCount,
          lastFillTs: fills.getLastFillTs(),
        },
      });

      // Metrics framework: calculate, check kill thresholds, export
      const metrics = metricsCalc.calculateMetrics(
        cfg.quoteBaseHalfSpreadBps,
        inventory.state,
        cfg.inventoryMaxShares,
        pnl.state().gross,
        pnl.state().net,
        tickCount
      );
      metricsHistory.push(metrics);

      if (killMonitor.checkMetrics(metrics)) {
        log.error('[METRICS] Kill threshold breached, stopping bot');
        shutdown('KILL_THRESHOLD_BREACHED').catch((e) => log.error('shutdown error', { err: String(e) }));
        return;
      }

      // Export metrics to CSV every 10 ticks
      if (tickCount % 10 === 0) {
        metricsExporter.exportMetrics(metrics);
      }

      // Pivot/kill decision at time gates
      const hoursElapsed = (Date.now() - sessionStartTime) / (1000 * 60 * 60);
      if (tickCount % 100 === 0 && hoursElapsed >= 4) {
        const decision = killMonitor.decidePivotOrKill(metrics, hoursElapsed);
        if (decision === 'kill') {
          log.error('[METRICS] Hypothesis failed, killing session');
          shutdown('HYPOTHESIS_FAILURE').catch((e) => log.error('shutdown error', { err: String(e) }));
          return;
        } else if (decision === 'pivot_h2') {
          log.info('[METRICS] Pivoting to H2 — zero-fee quoting recommended');
        }
      }

      // Daily summary at 24h mark
      if (hoursElapsed >= 24 && tickCount % 100 === 0 && metricsHistory.length > 0) {
        const summary = metricsExporter.generateDailySummary(metricsHistory);
        log.info('[METRICS] Daily summary:\n' + summary);
      }
    } catch (e) {
      log.error('tick error', { err: String(e) });
    }
  }, cfg.tickMs);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn('shutdown requested', { signal });
    clearInterval(tickTimer);
    autoheal.stop();
    adverse.stop();
    paper.stop();
    binanceFeed.stop().catch(() => { /* ignore */ });
    polyFeed.stop().catch(() => { /* ignore */ });
    simFeed.stop();
    discovery.stop();
    reconciler.stop();
    await orderManager.cancelAll('shutdown');
    await dashboard.stop();

    const summary: SessionSummary = {
      runId: cfg.runId,
      start: cfg.startTs,
      end: Date.now(),
      durationMs: Date.now() - cfg.startTs,
      mode: cfg.mode,
      totalFills: pnl.state().totalFills,
      grossPnl: pnl.state().gross,
      netPnl: pnl.state().net,
      realizedPnl: pnl.state().realized,
      drawdown: pnl.state().drawdown,
      regimeBreakdown: {
        low_vol_balanced: summaryRegime(pnl, 'low_vol_balanced'),
        low_vol_directional: summaryRegime(pnl, 'low_vol_directional'),
        medium_vol: summaryRegime(pnl, 'medium_vol'),
        high_vol_chop: summaryRegime(pnl, 'high_vol_chop'),
        high_vol_trend: summaryRegime(pnl, 'high_vol_trend'),
      },
      riskEvents: risk.getEvents(),
      adverseEmaFinal: adverse.getEma(),
      params: {
        gamma: paramsStore.get().gamma,
        k: paramsStore.get().k,
        spreadBias: paramsStore.get().spreadBias,
        sizeMultiplier: paramsStore.get().sizeMultiplier,
      },
    };
    const path = sessionStore.save(summary);
    log.info('session saved', { path });
    snapshotStore.save(`${cfg.runId}_final`, telemetry.getLast());
    await flushLogs();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT').catch((e) => console.error('shutdown error', e)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch((e) => console.error('shutdown error', e)); });
  process.on('uncaughtException', (e) => {
    console.error('[FATAL] uncaughtException:', e);
    log.error('uncaughtException', { err: String(e), stack: e.stack });
  });
  process.on('unhandledRejection', (e) => {
    console.error('[FATAL] unhandledRejection:', e);
    log.error('unhandledRejection', { err: String(e) });
  });
  process.on('exit', (code) => {
    console.error(`[EXIT] code=${code} uptime=${process.uptime().toFixed(1)}s`);
  });
}

function summaryRegime(
  pnl: PnlTracker,
  regime: 'low_vol_balanced' | 'low_vol_directional' | 'medium_vol' | 'high_vol_chop' | 'high_vol_trend',
): { fills: number; pnl: number; winRate: number } {
  const r = pnl.state().perRegime[regime];
  return { fills: r.fills, pnl: r.pnl, winRate: r.fills > 0 ? r.wins / r.fills : 0 };
}

function detectPrimaryAsset(m: PolymarketMarket, targets: string[]): string | null {
  // First try to extract from slug pattern: {asset}-updown-{interval}-{windowTs}
  const parts = m.slug.split('-');
  if (parts.length >= 4 && parts[1] === 'updown') {
    const slugAsset = parts[0].toUpperCase();
    if (targets.includes(slugAsset)) return slugAsset;
  }
  // Fallback: text match
  const text = (`${m.question} ${m.slug} ${(m.tags ?? []).join(' ')} ${m.category ?? ''}`).toLowerCase();
  const aliases: Record<string, string[]> = {
    BTC: ['btc', 'bitcoin'],
    ETH: ['eth', 'ethereum'],
    SOL: ['sol', 'solana'],
    DOGE: ['doge', 'dogecoin'],
    XRP: ['xrp', 'ripple'],
    BNB: ['bnb', 'binance coin'],
    HYPE: ['hype', 'hyperliquid'],
  };
  for (const a of targets) {
    for (const k of aliases[a] ?? [a.toLowerCase()]) {
      if (text.includes(k)) return a;
    }
  }
  return null;
}

function detectPrimaryInterval(m: PolymarketMarket, targets: string[]): string | null {
  // First try to extract from slug pattern: {asset}-updown-{interval}-{windowTs}
  const parts = m.slug.split('-');
  if (parts.length >= 4 && parts[1] === 'updown') {
    const slugInterval = parts[2];
    if (targets.includes(slugInterval)) return slugInterval;
  }
  // Fallback: text match
  const t = (`${m.question} ${m.slug} ${(m.tags ?? []).join(' ')}`).toLowerCase();
  for (const iv of targets) {
    if (t.includes(iv)) return iv;
  }
  return targets[0] ?? null;
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal', e);
  process.exit(1);
});
