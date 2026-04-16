import { TelemetrySnapshot } from '../core/telemetry';

/**
 * Convert the internal telemetry snapshot into a JSON-serializable payload
 * for the dashboard. Strips circular refs and clamps history.
 */
export function serializeForDashboard(s: Partial<TelemetrySnapshot>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ts: s.ts ?? Date.now(),
    runId: s.runId ?? null,
    mode: s.mode ?? 'unknown',
  };
  out.poly = s.poly
    ? {
        slug: s.poly.market?.slug,
        conditionId: s.poly.market?.conditionId,
        endDateTs: s.poly.market?.endDateTs,
        bestBid: s.poly.bestBidYes,
        bestAsk: s.poly.bestAskYes,
        mid: s.poly.midYes,
        micro: s.poly.microYes,
        spread: s.poly.spreadYes,
        topImbalance: s.poly.topImbalance,
        depthImbalance: s.poly.depthImbalance,
        feedAgeMs: s.poly.feedAgeMs,
        stale: s.poly.stale,
        bidsTop: (s.poly.yesBook?.bids ?? []).slice(0, 5),
        asksTop: (s.poly.yesBook?.asks ?? []).slice(0, 5),
      }
    : null;
  out.bin = s.bin
    ? {
        symbol: s.bin.symbol,
        bestBid: s.bin.bestBid,
        bestAsk: s.bin.bestAsk,
        mid: s.bin.mid,
        bookImbalance: s.bin.bookImbalance,
        aggressorRatio: s.bin.aggressorRatio,
        priceVelocityBps: s.bin.priceVelocityBps,
        volumeRatio: s.bin.volumeRatio,
        bidWall: s.bin.bidWall,
        askWall: s.bin.askWall,
        available: s.bin.available,
        stale: s.bin.stale,
        feedAgeMs: s.bin.feedAgeMs,
      }
    : null;
  out.features = s.features ?? null;
  out.quote = s.quote ?? null;
  out.regime = s.regime ?? null;
  out.health = s.health ?? null;
  out.inventory = s.inventory ?? null;
  out.pnl = s.pnl
    ? {
        gross: s.pnl.gross,
        net: s.pnl.net,
        realized: s.pnl.realized,
        fees: s.pnl.fees,
        drawdown: s.pnl.drawdown,
        wins: s.pnl.wins,
        losses: s.pnl.losses,
        consecutiveLosses: s.pnl.consecutiveLosses,
        totalFills: s.pnl.totalFills,
        perRegime: s.pnl.perRegime,
        history: (s.pnl.history ?? []).slice(-500),
        avgWin: s.pnl.avgWin,
        avgLoss: s.pnl.avgLoss,
      }
    : null;
  out.risk = s.risk ?? null;
  out.discovery = s.discovery
    ? {
        ts: s.discovery.ts,
        selected: s.discovery.selected
          ? {
              slug: s.discovery.selected.slug,
              conditionId: s.discovery.selected.conditionId,
              question: s.discovery.selected.question,
              endDateTs: s.discovery.selected.endDateTs,
            }
          : null,
        next: s.discovery.next
          ? {
              slug: s.discovery.next.slug,
              conditionId: s.discovery.next.conditionId,
              question: s.discovery.next.question,
              endDateTs: s.discovery.next.endDateTs,
            }
          : null,
        candidates: (s.discovery.candidates ?? []).slice(0, 8).map((c) => ({
          slug: c.market.slug,
          question: c.market.question,
          endDateTs: c.market.endDateTs,
          score: c.score,
          components: c.components,
          reasons: c.reasons,
        })),
        rotations: s.discovery.rotations ?? [],
      }
    : null;
  out.params = s.params ?? null;
  out.activeOrders = (s.activeOrders ?? []).map((o) => ({
    quoteId: o.quoteId,
    token: o.token,
    side: o.side,
    price: o.price,
    sizeShares: o.sizeShares,
    filledSize: o.filledSize,
    status: o.status,
    ageMs: Date.now() - o.createdAt,
    exchangeOrderId: o.exchangeOrderId ?? null,
  }));
  out.recentFills = (s.recentFills ?? []).slice(-30);
  out.advStats = s.advStats ?? null;
  out.feedHealth = s.feedHealth ?? null;
  out.latencyArb = s.latencyArb ?? null;
  out.autohealChanges = s.autohealChanges ?? [];
  out.live = s.live ?? null;
  return out;
}
