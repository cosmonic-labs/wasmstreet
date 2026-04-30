// strategy-search.js — section 4: ranked candidate strategies.
//
// Calls /strategy/search with the current chain + scenario. Renders ranked
// strategy cards. Click "Apply" on a card to load its legs into panel 2.

import { subscribe, getState } from '/app.js';
import { applyStrategy } from '/app.js';

const SCORINGS = [
  { key: 'balanced',   label: 'Balanced',   tip: 'Composite score: probability of profit, reward/risk, premium efficiency.' },
  { key: 'income',     label: 'Income',     tip: 'Credit strategies only — collect premium, win often.' },
  { key: 'asymmetric', label: 'Asymmetric', tip: 'Maximize reward / risk regardless of probability.' },
  { key: 'moonshot',   label: 'Moonshot',   tip: 'Cheap entry with massive upside if a big move happens.' },
];

let resultsEl, controlsEl;
let scoring = 'balanced';
let lastResults = null;
let inflight = null;

export function mountStrategySearch() {
  resultsEl  = document.getElementById('search-results');
  controlsEl = document.getElementById('search-controls');

  renderControls();
  subscribe(state => {
    // Disable button if no chain
    const btn = controlsEl.querySelector('#search-go');
    if (btn) btn.disabled = !state.chain || !state.chain.calls;
  });
}

function renderControls() {
  const segs = SCORINGS.map(s => `
    <button data-key="${s.key}" data-tooltip="${s.tip}" class="${scoring === s.key ? 'active' : ''}">${s.label}</button>
  `).join('');
  controlsEl.innerHTML = `
    <div class="toolbar-group" style="background: var(--border); padding:1px;">${segs}</div>
    <button id="search-go" class="search-btn">Search strategies</button>
  `;
  controlsEl.querySelectorAll('button[data-key]').forEach(b => {
    b.addEventListener('click', () => {
      scoring = b.dataset.key;
      renderControls();
    });
  });
  controlsEl.querySelector('#search-go').addEventListener('click', runSearch);
}

async function runSearch() {
  const state = getState();
  if (!state.chain || !state.chain.calls) return;

  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;

  resultsEl.innerHTML = `<div class="empty">Searching ~500 strategies...</div>`;

  const contracts = [
    ...state.chain.calls.map(c => ({
      kind: 'call', strike: c.strike, expiration_days: c.days_to_exp, iv: c.iv, mid: c.mid,
    })),
    ...state.chain.puts.map(p => ({
      kind: 'put',  strike: p.strike, expiration_days: p.days_to_exp, iv: p.iv, mid: p.mid,
    })),
  ];

  const sc = state.scenario;
  const t0 = performance.now();
  const req = {
    spot: state.chain.spot, rate: sc.rate, scenario_vol: sc.vol,
    price_min: sc.price_min, price_max: sc.price_max, price_steps: 20,
    days_min: sc.days_min, days_max: sc.days_max, day_steps: 8,
    max_results: 12, scoring,
    contracts,
  };

  try {
    const r = await fetch('/strategy/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const dt = performance.now() - t0;
    document.getElementById('latency-value').textContent = dt.toFixed(0);
    lastResults = data;
    renderResults(data, dt);
  } catch (e) {
    if (e.name === 'AbortError') return;
    resultsEl.innerHTML = `<div class="empty" style="color:var(--red)">${e.message}</div>`;
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

function renderResults(data, elapsedMs) {
  if (!data.ranked.length) {
    resultsEl.innerHTML = `<div class="empty">No qualifying strategies for the <strong>${data.scoring}</strong> objective.</div>`;
    return;
  }

  const cards = data.ranked.map((r, i) => renderCard(r, i)).join('');
  resultsEl.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; font-family:var(--mono); font-size:11.5px; color:var(--text-2);">
      <span>
        <strong>${data.evaluated.toLocaleString()}</strong> candidates evaluated &middot;
        <strong>${data.ranked.length}</strong> ranked by <em>${data.scoring}</em> &middot;
        ${elapsedMs.toFixed(0)} ms total
      </span>
      <span style="color:var(--text-mute)">Click <strong>Apply</strong> to load any strategy into your legs panel.</span>
    </div>
    <div class="search-grid">${cards}</div>
  `;

  resultsEl.querySelectorAll('button[data-apply]').forEach(b => {
    b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.apply, 10);
      const strat = data.ranked[idx];
      if (strat) applyStrategy(strat);
    });
  });
}

function renderCard(r, i) {
  const moneyCls = v => v >= 0 ? 'pos' : 'neg';
  const fmtMoney = v => (v >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(v)).toLocaleString();
  const legs = r.legs.map(l => {
    const sideCls = l.side === 'buy' ? 'leg-buy' : 'leg-sell';
    return `<span class="leg-pill ${sideCls}">${l.side === 'buy' ? '+' : '-'} ${l.kind === 'call' ? 'C' : 'P'} ${l.strike}</span>`;
  }).join(' ');
  const rrAttr = `data-tooltip="<strong>Risk / reward.</strong> Max profit divided by absolute max loss. Higher = more upside per dollar of risk."`;
  const ppAttr = `data-tooltip="<strong>Probability of Profit at horizon.</strong> Lognormal-weighted estimate: integrating the risk-neutral lognormal density of the underlying at the horizon date over the strategy&rsquo;s profitable price region. Uses the average leg IV (plus your IV shock) as the diffusion vol."`;
  const pop = (typeof r.pop_at_horizon === 'number') ? r.pop_at_horizon : r.profit_pct;
  return `
    <div class="search-card">
      <div class="search-rank">#${i + 1}</div>
      <div class="search-name">${escape(r.name)}</div>
      <div class="search-legs">${legs}</div>
      <div class="search-stats">
        <div ${ppAttr}>
          <div class="lbl">PoP</div>
          <div class="val">${pop.toFixed(1)}%</div>
        </div>
        <div data-tooltip="Maximum profit observed in the scenario grid.">
          <div class="lbl">Max Profit</div>
          <div class="val pos">${fmtMoney(r.max_profit)}</div>
        </div>
        <div data-tooltip="Maximum loss observed in the scenario grid.">
          <div class="lbl">Max Loss</div>
          <div class="val neg">${fmtMoney(r.max_loss)}</div>
        </div>
        <div data-tooltip="Net premium at entry. Positive = credit (you collect cash), negative = debit (you pay cash).">
          <div class="lbl">Net Prem</div>
          <div class="val ${moneyCls(r.net_premium)}">${fmtMoney(r.net_premium)}</div>
        </div>
        <div ${rrAttr}>
          <div class="lbl">R/R</div>
          <div class="val">${(r.max_profit / Math.max(1, Math.abs(r.max_loss))).toFixed(2)}</div>
        </div>
      </div>
      <button class="search-apply" data-apply="${i}">Apply →</button>
    </div>
  `;
}

function escape(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;',
  }[c]));
}
