import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import {
  DiscoveryCandidate,
  DiscoveryReport,
  PolymarketMarket,
} from '../types';
import { getLogger } from '../utils/logger';
import { retry, withTimeout } from '../utils/retry';
import { clamp01, normalize } from '../utils/math';
import { nowSec } from '../utils/time';

const log = getLogger('discovery');

// Interval classification heuristics.
const INTERVAL_KEYWORDS: Record<string, string[]> = {
  '5m': ['5-minute', '5 minute', '5m', 'up or down in 5', '5-min'],
  '15m': ['15-minute', '15 minute', '15m', 'up or down in 15', '15-min'],
  '1h': ['1-hour', 'hourly', 'next hour', '1h'],
  daily: ['daily', 'today', 'end of day'],
};

export interface DiscoveryOpts {
  targetAssets: string[];
  targetIntervals: string[];
  minLiquidityScore: number;
  prewarmSecs: number;
  gammaUrl: string;
  pollMs: number;
}

type GammaEvent = Record<string, unknown>;

function normStr(s: string | undefined | null): string {
  return (s ?? '').toLowerCase();
}

function detectAsset(text: string, targets: string[]): string | null {
  const t = normStr(text);
  for (const a of targets) {
    const A = a.toUpperCase();
    if (t.includes(' ' + A.toLowerCase() + ' ') || t.includes(A.toLowerCase())) return A;
    // also detect common full names
    const mapping: Record<string, string[]> = {
      BTC: ['bitcoin'],
      ETH: ['ethereum'],
      SOL: ['solana'],
      DOGE: ['dogecoin'],
      XRP: ['xrp', 'ripple'],
      BNB: ['bnb', 'binance coin'],
      HYPE: ['hype', 'hyperliquid'],
    };
    for (const alias of mapping[A] ?? []) {
      if (t.includes(alias)) return A;
    }
  }
  return null;
}

function detectInterval(text: string, targets: string[]): string | null {
  const t = normStr(text);
  for (const iv of targets) {
    for (const kw of INTERVAL_KEYWORDS[iv] ?? []) {
      if (t.includes(kw)) return iv;
    }
  }
  return null;
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
      const markets = await this.fetchCandidates();
      const scored = this.scoreAll(markets);
      this.lastCandidates = scored;
      const best = scored[0] ?? null;
      const second = scored[1] ?? null;
      const now = Date.now();

      if (!best) {
        if (this.selected) {
          log.warn('no candidates; keeping selected', { slug: this.selected.slug });
        }
        return;
      }

      // rotate if we have no selection, or selected expired, or best is clearly better near expiry
      const shouldRotate =
        !this.selected ||
        this.selected.closed ||
        (this.selected.endDateTs - nowSec() < this.opts.prewarmSecs && best.market.conditionId !== this.selected.conditionId);

      if (shouldRotate && best.market.conditionId !== this.selected?.conditionId) {
        const from = this.selected?.conditionId ?? null;
        log.info('market rotation', {
          from: this.selected?.slug ?? null,
          to: best.market.slug,
          score: best.score,
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

  private async fetchCandidates(): Promise<PolymarketMarket[]> {
    // Use Polymarket Gamma API — public, documented.
    // GET /markets?active=true&closed=false&limit=500
    const url = `${this.opts.gammaUrl.replace(/\/$/, '')}/markets?active=true&closed=false&limit=500`;

    const raw = await retry(
      () =>
        withTimeout(
          fetch(url, { headers: { 'User-Agent': 'polymarket-mm-bot/1.0' } }).then(async (r) => {
            if (!r.ok) throw new Error(`gamma http ${r.status}`);
            return r.json();
          }),
          10_000,
          'gamma-markets',
        ),
      { retries: 3, minMs: 500, maxMs: 4000 },
    );

    const arr = Array.isArray(raw) ? raw : Array.isArray((raw as GammaEvent).data) ? (raw as { data: GammaEvent[] }).data : [];
    const out: PolymarketMarket[] = [];
    for (const m of arr as GammaEvent[]) {
      const market = this.parseGammaMarket(m);
      if (market) out.push(market);
    }
    return out;
  }

  private parseGammaMarket(m: GammaEvent): PolymarketMarket | null {
    try {
      const conditionId = String(m.conditionId ?? m.condition_id ?? m.condition ?? '');
      const slug = String(m.slug ?? m.marketSlug ?? '');
      const question = String(m.question ?? m.title ?? '');
      if (!conditionId || !question) return null;

      // token ids
      let yesTokenId = '';
      let noTokenId = '';
      const clobTokenIds = m.clobTokenIds ?? m.clob_token_ids;
      if (Array.isArray(clobTokenIds) && clobTokenIds.length >= 2) {
        yesTokenId = String(clobTokenIds[0]);
        noTokenId = String(clobTokenIds[1]);
      } else if (typeof clobTokenIds === 'string') {
        try {
          const arr = JSON.parse(clobTokenIds) as unknown[];
          if (Array.isArray(arr) && arr.length >= 2) {
            yesTokenId = String(arr[0]);
            noTokenId = String(arr[1]);
          }
        } catch {
          /* ignore */
        }
      } else if (Array.isArray(m.outcomes) && Array.isArray(m.outcomePrices)) {
        // older schema
      }

      const endRaw = (m.endDate ?? m.end_date ?? m.endDateIso ?? m.end_date_iso) as string | undefined;
      let endDateTs = 0;
      if (endRaw) {
        const t = Date.parse(endRaw);
        if (!isNaN(t)) endDateTs = Math.floor(t / 1000);
      } else if (typeof m.endTime === 'number') {
        endDateTs = Number(m.endTime);
      }

      const tags = Array.isArray(m.tags)
        ? (m.tags as unknown[]).map((t) => String(t))
        : typeof m.tags === 'string'
          ? String(m.tags).split(',').map((t) => t.trim())
          : [];

      const market: PolymarketMarket = {
        conditionId,
        questionId: m.questionID ? String(m.questionID) : undefined,
        slug,
        question,
        category: m.category ? String(m.category) : undefined,
        tags,
        yesTokenId,
        noTokenId,
        endDateTs,
        active: Boolean(m.active ?? true),
        closed: Boolean(m.closed ?? false),
        liquidityNum: typeof m.liquidityNum === 'number' ? m.liquidityNum : Number(m.liquidity ?? 0) || undefined,
        volumeNum: typeof m.volumeNum === 'number' ? m.volumeNum : Number(m.volume ?? 0) || undefined,
        raw: m,
      };
      return market;
    } catch (e) {
      log.debug('parseGammaMarket failed', { err: String(e) });
      return null;
    }
  }

  private scoreAll(markets: PolymarketMarket[]): DiscoveryCandidate[] {
    const candidates: DiscoveryCandidate[] = [];
    const now = nowSec();
    for (const m of markets) {
      const text = `${m.question} ${m.slug} ${m.category ?? ''} ${(m.tags ?? []).join(' ')}`;
      const asset = detectAsset(text, this.opts.targetAssets);
      const interval = detectInterval(text, this.opts.targetIntervals);
      if (!asset || !interval) continue;
      if (!m.yesTokenId || !m.noTokenId) continue;
      if (m.closed || !m.active) continue;

      const ttl = m.endDateTs - now;
      if (ttl <= 0) continue;

      const components: Record<string, number> = {};
      // asset match = 1 (required)
      components.asset = 1;
      components.interval = 1;

      // time-to-expiry: prefer markets with some remaining runway but not too far.
      // for 5m intervals: ideal 60-180s; for 15m: 60-600s
      const targetTtl = interval === '5m' ? 120 : interval === '15m' ? 360 : 1800;
      const ttlScore = clamp01(1 - Math.abs(ttl - targetTtl) / (targetTtl * 2));
      components.ttl = ttlScore;

      // liquidity proxy
      const liqRaw = m.liquidityNum ?? 0;
      const liqScore = normalize(Math.log10(1 + liqRaw), 0, 5);
      components.liquidity = liqScore;

      // volume proxy
      const volRaw = m.volumeNum ?? 0;
      const volScore = normalize(Math.log10(1 + volRaw), 0, 6);
      components.volume = volScore;

      // freshness: slug/question length as a weak proxy for well-formed event
      components.naming = normStr(m.slug).length > 6 ? 0.6 : 0.3;

      // category bonus
      components.category = (m.category ?? '').toLowerCase().includes('crypto') ? 0.6 : 0.2;

      const score =
        components.asset * 1.0 +
        components.interval * 1.0 +
        components.ttl * 0.8 +
        components.liquidity * 0.9 +
        components.volume * 0.5 +
        components.naming * 0.2 +
        components.category * 0.3;

      const reasons: string[] = [`asset=${asset}`, `interval=${interval}`, `ttl=${ttl}s`];
      if (liqScore < this.opts.minLiquidityScore) reasons.push('low_liquidity');

      candidates.push({ market: m, score, components, reasons });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }
}
