import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import {
  DiscoveryCandidate,
  DiscoveryReport,
  PolymarketMarket,
} from '../types';
import { getLogger } from '../utils/logger';
import { retry, withTimeout } from '../utils/retry';
import { nowSec } from '../utils/time';

const log = getLogger('discovery');

/**
 * Rolling crypto up/down markets on Polymarket use deterministic slugs:
 *   {asset}-updown-{interval}-{window_ts}
 *
 * where window_ts = now - (now % intervalSecs).
 *
 * We compute the slug directly and fetch via:
 *   GET https://gamma-api.polymarket.com/events?slug={slug}
 *
 * Outcomes are "Up" / "Down" (mapped to yesTokenId / noTokenId).
 */

export interface DiscoveryOpts {
  targetAssets: string[];
  targetIntervals: string[];
  minLiquidityScore: number;
  prewarmSecs: number;
  gammaUrl: string;
  pollMs: number;
}

type GammaEvent = Record<string, unknown>;
type GammaMarket = Record<string, unknown>;

const INTERVAL_SECS: Record<string, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
};

/** Compute the window timestamp for a given interval. */
function windowTs(nowEpoch: number, intervalSecs: number): number {
  return nowEpoch - (nowEpoch % intervalSecs);
}

/** Build the deterministic slug for a rolling up/down market. */
function buildSlug(asset: string, interval: string, wTs: number): string {
  return `${asset.toLowerCase()}-updown-${interval}-${wTs}`;
}

export class DiscoveryEngine extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private selected: PolymarketMarket | null = null;
  private next: PolymarketMarket | null = null;
  private rotations: Array<{ ts: number; from: string | null; to: string }> = [];
  private lastCandidates: DiscoveryCandidate[] = [];
  private running = false;
  private failCount = 0;

  constructor(private readonly cfg: BotConfig, private readonly opts: DiscoveryOpts) {
    super();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce().catch((e) => log.error('runOnce error', { err: String(e) }));
    }, this.opts.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSelected(): PolymarketMarket | null {
    return this.selected;
  }

  getNext(): PolymarketMarket | null {
    return this.next;
  }

  getReport(): DiscoveryReport {
    return {
      ts: Date.now(),
      selected: this.selected,
      next: this.next,
      candidates: this.lastCandidates,
      rotations: this.rotations.slice(-10),
    };
  }

  async runOnce(): Promise<void> {
    try {
      const candidates = await this.fetchAllWindows();
      const scored = this.scoreAll(candidates);
      this.lastCandidates = scored;
      const best = scored[0] ?? null;
      const second = scored[1] ?? null;
      const now = Date.now();

      if (!best) {
        if (this.selected) {
          log.warn('no candidates; keeping selected', { slug: this.selected.slug });
        } else {
          log.warn('no candidates found');
        }
        return;
      }

      // Rotate if: no selection, selected closed/expired, or best is a different market
      // near our current market's expiry window
      const currentTtl = this.selected ? this.selected.endDateTs - nowSec() : 0;
      const shouldRotate =
        !this.selected ||
        this.selected.closed ||
        currentTtl <= this.opts.prewarmSecs ||
        best.market.conditionId !== this.selected.conditionId;

      if (shouldRotate && best.market.conditionId !== this.selected?.conditionId) {
        const from = this.selected?.conditionId ?? null;
        log.info('market rotation', {
          from: this.selected?.slug ?? null,
          to: best.market.slug,
          score: best.score,
          asset: best.reasons.find((r) => r.startsWith('asset='))?.split('=')[1],
          interval: best.reasons.find((r) => r.startsWith('interval='))?.split('=')[1],
        });
        this.rotations.push({ ts: now, from, to: best.market.conditionId });
        if (this.rotations.length > 50) this.rotations.shift();
        this.selected = best.market;
        this.emit('rotation', { previous: from, market: best.market });
      }

      this.next = second ? second.market : null;
      this.failCount = 0;
      this.emit('report', this.getReport());
    } catch (e) {
      this.failCount += 1;
      log.warn('discovery iteration failed', { err: String(e), failCount: this.failCount });
    }
  }

  /**
   * For each asset × interval combination, fetch the current and next window.
   * Returns all valid markets found.
   */
  private async fetchAllWindows(): Promise<PolymarketMarket[]> {
    const now = nowSec();
    const slugs: Array<{ slug: string; asset: string; interval: string; wTs: number }> = [];

    for (const asset of this.opts.targetAssets) {
      for (const interval of this.opts.targetIntervals) {
        const secs = INTERVAL_SECS[interval];
        if (!secs) continue;

        const current = windowTs(now, secs);
        const next = current + secs;

        slugs.push({ slug: buildSlug(asset, interval, current), asset, interval, wTs: current });
        slugs.push({ slug: buildSlug(asset, interval, next), asset, interval, wTs: next });
      }
    }

    // Fetch all in parallel (batched)
    const results = await Promise.allSettled(
      slugs.map(async ({ slug, asset, interval }) => {
        const market = await this.fetchBySlug(slug);
        if (market) {
          return { market, asset: asset.toUpperCase(), interval };
        }
        return null;
      }),
    );

    const markets: PolymarketMarket[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        markets.push(r.value.market);
      }
    }

    log.debug('fetchAllWindows', {
      slugCount: slugs.length,
      found: markets.length,
    });

    return markets;
  }

  /**
   * Fetch a single event by slug from the Gamma API and extract the market.
   */
  private async fetchBySlug(slug: string): Promise<PolymarketMarket | null> {
    const url = `${this.opts.gammaUrl.replace(/\/$/, '')}/events?slug=${encodeURIComponent(slug)}`;

    try {
      const raw = await retry(
        () =>
          withTimeout(
            fetch(url, { headers: { 'User-Agent': 'polymarket-mm-bot/1.0' } }).then(async (r) => {
              if (!r.ok) throw new Error(`gamma http ${r.status}`);
              return r.json();
            }),
            10_000,
            'gamma-event',
          ),
        { retries: 2, minMs: 300, maxMs: 2000 },
      );

      const events = Array.isArray(raw) ? raw : [];
      if (events.length === 0) return null;

      const event = events[0] as GammaEvent;
      const markets = Array.isArray(event.markets) ? (event.markets as GammaMarket[]) : [];
      if (markets.length === 0) return null;

      return this.parseEventMarket(markets[0], slug);
    } catch (e) {
      log.debug('fetchBySlug failed', { slug, err: String(e) });
      return null;
    }
  }

  /**
   * Parse a market from the events API response.
   * Outcomes are "Up"/"Down" — mapped to yesTokenId/noTokenId.
   */
  private parseEventMarket(m: GammaMarket, slug: string): PolymarketMarket | null {
    try {
      const conditionId = String(m.conditionId ?? m.condition_id ?? '');
      const question = String(m.question ?? m.title ?? '');
      if (!conditionId || !question) return null;

      // Token IDs: clobTokenIds is a JSON string like '["tokenUp", "tokenDown"]'
      let upTokenId = '';
      let downTokenId = '';
      const clobTokenIds = m.clobTokenIds ?? m.clob_token_ids;
      if (typeof clobTokenIds === 'string') {
        try {
          const arr = JSON.parse(clobTokenIds) as unknown[];
          if (Array.isArray(arr) && arr.length >= 2) {
            upTokenId = String(arr[0]);
            downTokenId = String(arr[1]);
          }
        } catch {
          /* ignore */
        }
      } else if (Array.isArray(clobTokenIds) && clobTokenIds.length >= 2) {
        upTokenId = String(clobTokenIds[0]);
        downTokenId = String(clobTokenIds[1]);
      }

      if (!upTokenId || !downTokenId) return null;

      // End date
      const endRaw = (m.endDate ?? m.end_date ?? m.endDateIso) as string | undefined;
      let endDateTs = 0;
      if (endRaw) {
        const t = Date.parse(String(endRaw));
        if (!isNaN(t)) endDateTs = Math.floor(t / 1000);
      }

      // Event start time (the actual window start)
      const eventStartRaw = m.eventStartTime as string | undefined;
      let eventStartTs = 0;
      if (eventStartRaw) {
        const t = Date.parse(String(eventStartRaw));
        if (!isNaN(t)) eventStartTs = Math.floor(t / 1000);
      }

      // Outcome prices
      let outcomePriceYes: number | undefined;
      let outcomePriceNo: number | undefined;
      const outcomePrices = m.outcomePrices;
      if (typeof outcomePrices === 'string') {
        try {
          const arr = JSON.parse(outcomePrices) as unknown[];
          if (arr.length >= 2) {
            outcomePriceYes = parseFloat(String(arr[0]));
            outcomePriceNo = parseFloat(String(arr[1]));
          }
        } catch {
          /* ignore */
        }
      }

      const tags: string[] = [];
      // Extract asset and interval from slug (e.g., "btc-updown-5m-1776336900")
      const parts = slug.split('-');
      if (parts.length >= 3) {
        tags.push(parts[0].toUpperCase()); // asset
        tags.push(parts[2]); // interval
      }

      const market: PolymarketMarket = {
        conditionId,
        questionId: m.questionID ? String(m.questionID) : undefined,
        slug: String(m.slug ?? slug),
        question,
        category: 'Crypto',
        tags,
        // Map Up -> yesTokenId, Down -> noTokenId
        yesTokenId: upTokenId,
        noTokenId: downTokenId,
        endDateTs: eventStartTs > 0 ? eventStartTs + extractIntervalSecs(slug) : endDateTs,
        active: Boolean(m.active ?? true),
        closed: Boolean(m.closed ?? false),
        liquidityNum: typeof m.liquidityNum === 'number' ? m.liquidityNum : Number(m.liquidity ?? 0) || undefined,
        volumeNum: typeof m.volumeNum === 'number' ? m.volumeNum : Number(m.volume ?? 0) || undefined,
        outcomePriceYes,
        outcomePriceNo,
        groupItemTitle: m.groupItemTitle ? String(m.groupItemTitle) : undefined,
        raw: m,
      };
      return market;
    } catch (e) {
      log.debug('parseEventMarket failed', { err: String(e) });
      return null;
    }
  }

  /**
   * Score and rank candidates. Prefers:
   * 1. Markets that are accepting orders
   * 2. Higher liquidity
   * 3. More time remaining in the window
   * 4. Outcome prices closer to 0.50 (most balanced)
   */
  private scoreAll(markets: PolymarketMarket[]): DiscoveryCandidate[] {
    const candidates: DiscoveryCandidate[] = [];
    const now = nowSec();

    for (const m of markets) {
      if (m.closed || !m.active) continue;

      // Check if accepting orders
      const raw = m.raw as GammaMarket | undefined;
      if (raw && raw.acceptingOrders === false) continue;

      const ttl = m.endDateTs - now;
      if (ttl <= 0) continue;

      // Extract asset and interval from slug
      const { asset, interval } = parseSlugMeta(m.slug);
      if (!asset || !interval) continue;

      const components: Record<string, number> = {};

      // Liquidity score (log-normalized)
      const liqRaw = m.liquidityNum ?? 0;
      components.liquidity = Math.min(1, Math.log10(1 + liqRaw) / 5);

      // TTL score: prefer markets with more time remaining
      const intervalSecs = INTERVAL_SECS[interval] ?? 300;
      components.ttl = Math.min(1, ttl / intervalSecs);

      // Price balance: prefer prices closer to 0.50
      const yesPrice = m.outcomePriceYes ?? 0.5;
      components.priceBalance = 1 - Math.abs(yesPrice - 0.5) * 2; // 1.0 at 0.50, 0.0 at 0/1

      // Volume score
      const volRaw = m.volumeNum ?? 0;
      components.volume = Math.min(1, Math.log10(1 + volRaw) / 6);

      const score =
        components.liquidity * 1.2 +
        components.ttl * 1.0 +
        components.priceBalance * 0.8 +
        components.volume * 0.4;

      const reasons: string[] = [
        `asset=${asset}`,
        `interval=${interval}`,
        `ttl=${ttl}s`,
        `liq=${liqRaw.toFixed(0)}`,
        `price=${yesPrice.toFixed(3)}`,
      ];

      candidates.push({ market: m, score, components, reasons });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }
}

/** Extract the interval in seconds from a slug like "btc-updown-5m-1776336900". */
function extractIntervalSecs(slug: string): number {
  const parts = slug.split('-');
  // parts: [asset, "updown", interval, windowTs]
  if (parts.length >= 3) {
    return INTERVAL_SECS[parts[2]] ?? 300;
  }
  return 300;
}

/** Extract asset and interval from slug. */
function parseSlugMeta(slug: string): { asset: string | null; interval: string | null } {
  // Pattern: {asset}-updown-{interval}-{windowTs}
  const parts = slug.split('-');
  if (parts.length >= 4 && parts[1] === 'updown') {
    return { asset: parts[0].toUpperCase(), interval: parts[2] };
  }
  return { asset: null, interval: null };
}
