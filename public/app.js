/* eslint-disable */
(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n === null || n === undefined || isNaN(n) ? '-' : Number(n).toFixed(d));
  const fmtPct = (n, d = 1) => (n === null || n === undefined ? '-' : (n * 100).toFixed(d) + '%');
  const fmtBps = (n, d = 1) => (n === null || n === undefined ? '-' : n.toFixed(d) + ' bps');
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '-');
  const fmtAge = (ms) => (ms === null ? '-' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');

  const kv = (el, pairs) => {
    el.innerHTML = pairs
      .map(([k, v, cls]) => `<div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>`)
      .join('');
  };

  // Equity chart
  const equityCtx = $('equityChart').getContext('2d');
  const chart = new Chart(equityCtx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Net PnL', data: [], borderColor: '#77a3ff', tension: 0.2, pointRadius: 0 }] },
    options: {
      animation: false,
      scales: { x: { display: false }, y: { ticks: { color: '#6a7a8f' }, grid: { color: '#1d2330' } } },
      plugins: { legend: { labels: { color: '#c8d1d9' } } },
    },
  });

  function renderSession(s) {
    const d = s.discovery?.selected;
    const ttl = d ? Math.max(0, d.endDateTs - Math.floor(Date.now() / 1000)) : null;
    kv($('sessionKv'), [
      ['Mode', s.mode || '-'],
      ['Run ID', s.runId || '-'],
      ['Clock', new Date(s.ts).toLocaleTimeString()],
      ['Selected', d?.slug || '-'],
      ['Time to expiry', ttl !== null ? ttl + 's' : '-'],
    ]);
  }

  function renderMarket(s) {
    const p = s.poly;
    kv($('marketKv'), [
      ['Best Bid', fmt(p?.bestBid, 4)],
      ['Best Ask', fmt(p?.bestAsk, 4)],
      ['Mid', fmt(p?.mid, 4)],
      ['Micro', fmt(p?.micro, 4)],
      ['Spread (bps)', p?.spread ? fmtBps(p.spread * 10000) : '-'],
      ['Feed age', p ? fmtAge(p.feedAgeMs) : '-', p?.stale ? 'warn' : ''],
    ]);
  }

  function stateColor(s) {
    if (s === 'NORMAL' || s === 'HEALTHY') return 'pos';
    if (s === 'THROTTLED' || s === 'DEGRADED') return 'warn';
    if (s === 'HALTED' || s === 'UNSAFE' || s === 'EMERGENCY') return 'neg';
    return '';
  }

  function renderRisk(s) {
    const r = s.risk || {};
    const h = s.health || {};
    kv($('riskKv'), [
      ['Risk', r.state || '-', stateColor(r.state)],
      ['Health', h.state || '-', stateColor(h.state)],
      ['Health score', fmt(h.score, 2)],
      ['Adv. EMA', fmt(s.advStats?.ema, 3)],
      ['Reasons', (h.reasons || []).join('; ') || '-'],
    ]);
  }

  function renderRegime(s) {
    const r = s.regime || {};
    kv($('regimeKv'), [
      ['Current', r.current || '-'],
      ['Candidate', r.candidate || '-'],
      ['Confidence', fmt(r.confidence, 2)],
      ['Age', fmtAge(r.ageMs)],
      ['Reason', r.reason || 'stable'],
    ]);
  }

  function renderPnl(s) {
    const p = s.pnl;
    if (!p) return;
    const color = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    kv($('pnlKv'), [
      ['Net', '$' + fmt(p.net, 2), color(p.net)],
      ['Gross', '$' + fmt(p.gross, 2), color(p.gross)],
      ['Realized', '$' + fmt(p.realized, 2), color(p.realized)],
      ['Fees', '$' + fmt(p.fees, 2)],
      ['Drawdown', '$' + fmt(p.drawdown, 2), p.drawdown > 0 ? 'warn' : ''],
      ['Fills', p.totalFills],
      ['W/L', p.wins + '/' + p.losses],
      ['Avg win', '$' + fmt(p.avgWin, 2), 'pos'],
      ['Avg loss', '$' + fmt(p.avgLoss, 2), 'neg'],
    ]);
    const labels = (p.history || []).map((_, i) => i);
    const data = (p.history || []).map((h) => h.equity);
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update('none');
  }

  function renderSignals(s) {
    const f = s.features || {};
    const q = s.quote || {};
    kv($('signalsKv'), [
      ['Internal fair', fmt(q.internalFair, 4)],
      ['Reservation', fmt(q.reservationPrice, 4)],
      ['Optimal spread', q.optimalSpread ? fmtBps(q.optimalSpread * 10000) : '-'],
      ['Caution', fmt(q.cautionScore, 2)],
      ['Poly imbalance', fmt(f.polyBookImbalance, 2)],
      ['Bin imbalance', fmt(f.binanceBookImbalance, 2)],
      ['Aggressor', fmt(f.binanceAggressorRatio, 2)],
      ['Velocity', fmtBps(f.binancePriceVelocityBps)],
      ['Vol EMA', fmtBps(f.realizedVolEma)],
      ['Momentum', fmt(f.momentumPersistence, 2)],
      ['Toxic proxy', fmt(f.toxicFlowProxy, 2)],
      ['Liquidity', fmt(f.liquidityScore, 2)],
      ['Fill opp.', fmt(f.fillOpportunityScore, 2)],
    ]);
  }

  function renderFeeds(s) {
    const fh = s.feedHealth || {};
    const b = s.bin || {};
    kv($('feedKv'), [
      ['Poly reconnects', fh.polyReconnects ?? '-'],
      ['Bin reconnects', fh.binReconnects ?? '-'],
      ['Poly stale', fh.polyStale ? 'YES' : 'no', fh.polyStale ? 'warn' : 'pos'],
      ['Bin stale', fh.binStale ? 'YES' : 'no', fh.binStale ? 'warn' : 'pos'],
      ['Bin symbol', b.symbol || '-'],
      ['Bin available', b.available ? 'YES' : 'no', b.available ? 'pos' : 'warn'],
    ]);
  }

  function renderInventory(s) {
    const i = s.inventory || {};
    kv($('invKv'), [
      ['Free USDC', '$' + fmt(i.freeUsdc, 2)],
      ['YES pos', fmt(i.yesPosition, 2)],
      ['NO pos', fmt(i.noPosition, 2)],
      ['YES avg', fmt(i.yesAvgCost, 4)],
      ['NO avg', fmt(i.noAvgCost, 4)],
      ['Unrealized', '$' + fmt(i.unrealizedPnl, 2)],
      ['MTM', '$' + fmt(i.markToMarketPnl, 2)],
      ['Skew', fmt(i.normalizedSkew, 2)],
    ]);
  }

  function renderLive(s) {
    const l = s.live || {};
    kv($('liveKv'), [
      ['Enabled', l.enabled ? 'YES' : 'no', l.enabled ? 'warn' : ''],
      ['Driver', l.driverHealthy ? 'OK' : 'NO', l.driverHealthy ? 'pos' : 'neg'],
      ['Reconciler', l.reconciledOk ? 'OK' : 'NO', l.reconciledOk ? 'pos' : 'neg'],
      ['Open orders', l.openOrderCount ?? '-'],
      ['Last fill', fmtTime(l.lastFillTs)],
    ]);
  }

  function renderQuote(s) {
    const q = s.quote || {};
    kv($('quoteKv'), [
      ['Mode', q.mode || '-', q.mode === 'blocked' ? 'neg' : 'pos'],
      ['Blocked', q.blockedReason || '-'],
      ['YES bid', fmt(q.yesBid, 4) + ' × ' + fmt(q.yesBidSize, 0)],
      ['YES ask', fmt(q.yesAsk, 4) + ' × ' + fmt(q.yesAskSize, 0)],
      ['NO bid', fmt(q.noBid, 4) + ' × ' + fmt(q.noBidSize, 0)],
      ['NO ask', fmt(q.noAsk, 4) + ' × ' + fmt(q.noAskSize, 0)],
      ['Size mult', fmt(q.sizingMultiplier, 2)],
      ['Inv skew', fmt(q.inventorySkew, 2)],
    ]);
  }

  function renderOrders(s) {
    const rows = (s.activeOrders || [])
      .map(
        (o) => `<tr>
          <td>${o.token}</td>
          <td>${o.side}</td>
          <td>${fmt(o.price, 4)}</td>
          <td>${fmt(o.sizeUsdc, 2)}</td>
          <td>${fmt(o.filledSize, 2)}</td>
          <td>${fmtAge(o.ageMs)}</td>
          <td>${o.status}</td>
        </tr>`
      )
      .join('');
    $('ordersTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan=7>none</td></tr>';
  }

  function renderFills(s) {
    const rows = (s.recentFills || [])
      .slice()
      .reverse()
      .map(
        (f) => `<tr>
          <td>${fmtTime(f.ts)}</td>
          <td>${f.token}</td>
          <td>${f.side}</td>
          <td>${fmt(f.price, 4)}</td>
          <td>${fmt(f.size, 2)}</td>
          <td>${f.regime}</td>
        </tr>`
      )
      .join('');
    $('fillsTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan=6>none</td></tr>';
  }

  function renderDiscovery(s) {
    const d = s.discovery;
    if (!d) return;
    kv($('discoveryKv'), [
      ['Selected', d.selected?.slug || '-'],
      ['Next', d.next?.slug || '-'],
      ['Rotations', (d.rotations || []).length],
    ]);
    const rows = (d.candidates || [])
      .map(
        (c) => `<tr>
          <td>${c.slug}</td>
          <td>${fmt(c.score, 2)}</td>
          <td>${(c.reasons || []).join(', ')}</td>
        </tr>`
      )
      .join('');
    $('discoveryTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan=3>searching…</td></tr>';
  }

  function renderAdv(s) {
    const a = s.advStats || {};
    kv($('advKv'), [
      ['Adverse EMA', fmt(a.ema, 3)],
      ['Samples', a.totalSamples ?? '-'],
      ['By regime', JSON.stringify(a.byRegime || {}).replace(/"/g, '')],
    ]);
    $('autohealList').innerHTML = (s.autohealChanges || [])
      .slice(-8)
      .map((c) => `<li>${new Date(c.ts).toLocaleTimeString()}: ${c.note}</li>`)
      .join('');
  }

  function renderLatency(s) {
    const l = s.latencyArb || {};
    kv($('latencyKv'), [
      ['Active', l.active ? 'YES' : 'no', l.active ? 'warn' : 'pos'],
      ['Total triggers', l.totalCancels ?? 0],
    ]);
    $('latencyList').innerHTML = (l.recentCancels || [])
      .slice(-8)
      .map((c) => `<li>${new Date(c.ts).toLocaleTimeString()}: ${c.reason}</li>`)
      .join('');
  }

  function render(s) {
    try { renderSession(s); } catch {}
    try { renderMarket(s); } catch {}
    try { renderRisk(s); } catch {}
    try { renderRegime(s); } catch {}
    try { renderPnl(s); } catch {}
    try { renderSignals(s); } catch {}
    try { renderFeeds(s); } catch {}
    try { renderInventory(s); } catch {}
    try { renderLive(s); } catch {}
    try { renderQuote(s); } catch {}
    try { renderOrders(s); } catch {}
    try { renderFills(s); } catch {}
    try { renderDiscovery(s); } catch {}
    try { renderAdv(s); } catch {}
    try { renderLatency(s); } catch {}
    $('headerStatus').textContent = 'live @ ' + new Date().toLocaleTimeString();
  }

  fetch('/api/snapshot').then(r => r.json()).then(render).catch(() => {});
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try { render(JSON.parse(e.data)); } catch {}
  };
  es.onerror = () => { $('headerStatus').textContent = 'disconnected'; };
})();
