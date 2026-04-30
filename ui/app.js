// app.js — top-level controller for WasmStreet strategy builder.

import { mountTickerSearch } from '/components/ticker-search.js';
import { mountChainTable }    from '/components/chain-table.js';
import { mountLegsTable }     from '/components/legs-table.js';
import { mountScenarioPanel } from '/components/scenario-panel.js';
import { mountStatsCards }    from '/components/stats-cards.js';
import { mountStrategySearch } from '/components/strategy-search.js';
import { installTooltip }     from '/components/tooltip.js';
import { installTour, maybeStartTour } from '/components/tour.js';
import { showDisclaimer }     from '/components/disclaimer.js';
import { mountPnlViz }        from '/viz/pnl-viz.js';

const STATE = {
  ticker: null,
  chain: null,    // enriched payload from /chain
  legs: [],       // [{ key, side, kind, strike, expiration, expiration_days, iv, entry_premium, units, bid, ask, volume }]
  scenario: {
    price_min: 80, price_max: 120, price_steps: 20,
    days_min: 0,   days_max: 30,   day_steps: 16,
    rate: 0.051,
    vol: 0.0,        // additive IV shock applied to every leg's iv (0 = use as-is)
    // Track which fields the user has manually overridden so leg changes
    // don't stomp on them.
    overrides: { price_min: false, price_max: false, days_max: false },
  },
  pnl: null,      // last /strategy/pnl response
  vizTab: 'heatmap',
};

const subscribers = new Set();
function notify() { for (const s of subscribers) s(STATE); }
export function subscribe(fn) { subscribers.add(fn); fn(STATE); return () => subscribers.delete(fn); }
export function getState() { return STATE; }

// ----- API helpers ----------------------------------------------------------

async function timed(fetchFn) {
  const t0 = performance.now();
  try { return await fetchFn(); }
  finally {
    const dt = performance.now() - t0;
    document.getElementById('latency-value').textContent = dt.toFixed(0);
  }
}

export async function fetchTickers(q) {
  return timed(async () => {
    const r = await fetch(`/tickers?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

export async function fetchChain(ticker) {
  return timed(async () => {
    const r = await fetch(`/chain?ticker=${encodeURIComponent(ticker)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

let inflightPnl = null;
export async function fetchStrategyPnl(req) {
  if (inflightPnl) inflightPnl.abort();
  const ctrl = new AbortController();
  inflightPnl = ctrl;
  try {
    return await timed(async () => {
      const r = await fetch('/strategy/pnl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    });
  } finally {
    if (inflightPnl === ctrl) inflightPnl = null;
  }
}

// ----- Mutators -------------------------------------------------------------

export async function selectTicker(ticker) {
  STATE.ticker = ticker;
  STATE.chain = null;
  STATE.legs = [];
  resetScenarioOverrides();
  notify();
  try {
    const chain = await fetchChain(ticker);
    STATE.chain = chain;
    // Default scenario: spot ± 15%, 30 days
    const spot = chain.spot;
    STATE.scenario.price_min = round1(spot * 0.85);
    STATE.scenario.price_max = round1(spot * 1.15);
    STATE.scenario.price_steps = 20;
    STATE.scenario.days_max   = Math.max(7, longestDaysToExp(chain));
    STATE.scenario.day_steps  = Math.min(STATE.scenario.days_max, 16);
    STATE.scenario.vol = 0.0;   // start with no IV shock; chain's IVs apply directly
    STATE.scenario.rate = chain.rate;
    setDataSourceBadge(chain.source);
    notify();
    schedulePnlRefresh();
  } catch (e) {
    console.error(e);
    STATE.chain = { error: e.message };
    notify();
  }
}

export function toggleLeg(contract, kind /* 'call' | 'put' */) {
  const key = legKey(contract, kind);
  const idx = STATE.legs.findIndex(l => l.key === key);
  if (idx >= 0) {
    STATE.legs.splice(idx, 1);
  } else {
    if (STATE.legs.length >= 6) return;  // 6-leg cap
    const mid = (contract.bid + contract.ask) / 2;
    STATE.legs.push({
      key,
      side: 'buy',
      kind,
      strike: contract.strike,
      expiration: contract.expiration,
      expiration_days: contract.days_to_exp,
      iv: contract.iv,
      entry_premium: round2(mid),
      units: 1,
      bid: contract.bid,
      ask: contract.ask,
      mid,
      volume: contract.volume,
      delta: contract.delta,
    });
  }
  reconcileScenarioWithLegs();
  notify();
  schedulePnlRefresh();
}

export function updateLeg(key, patch) {
  const leg = STATE.legs.find(l => l.key === key);
  if (!leg) return;
  Object.assign(leg, patch);
  reconcileScenarioWithLegs();
  notify();
  schedulePnlRefresh();
}

export function removeLeg(key) {
  STATE.legs = STATE.legs.filter(l => l.key !== key);
  reconcileScenarioWithLegs();
  notify();
  schedulePnlRefresh();
}

// Called by the scenario panel when the user manually drags a slider —
// records the override so leg changes don't stomp on the user's choice.
export function updateScenario(patch, fromUser = true) {
  Object.assign(STATE.scenario, patch);
  if (fromUser) {
    for (const k of Object.keys(patch)) {
      if (k in STATE.scenario.overrides) STATE.scenario.overrides[k] = true;
    }
  }
  notify();
  schedulePnlRefresh();
}

// Reset overrides — used when ticker changes (we want fresh defaults).
export function resetScenarioOverrides() {
  for (const k of Object.keys(STATE.scenario.overrides)) {
    STATE.scenario.overrides[k] = false;
  }
}

// When legs change, snap any non-overridden scenario fields to track them.
// - days_max  → max(legs.expiration_days), bounded by 1..120
// - price_min → min(spot * 0.85, min_strike * 0.95)
// - price_max → max(spot * 1.15, max_strike * 1.05)
function reconcileScenarioWithLegs() {
  if (!STATE.chain || !STATE.legs.length) return;
  const ov = STATE.scenario.overrides;
  const spot = STATE.chain.spot;

  if (!ov.days_max) {
    const maxLegDays = Math.max(...STATE.legs.map(l => l.expiration_days));
    const newDays = Math.max(1, Math.min(120, Math.round(maxLegDays)));
    if (newDays !== STATE.scenario.days_max) {
      STATE.scenario.days_max = newDays;
      // Also snap day_steps to a reasonable resolution
      STATE.scenario.day_steps = Math.min(STATE.scenario.days_max, 16);
    }
  }

  const strikes = STATE.legs.map(l => l.strike);
  const minK = Math.min(...strikes);
  const maxK = Math.max(...strikes);
  if (!ov.price_min) {
    const candidate = Math.min(spot * 0.85, minK * 0.95);
    STATE.scenario.price_min = round1(candidate);
  }
  if (!ov.price_max) {
    const candidate = Math.max(spot * 1.15, maxK * 1.05);
    STATE.scenario.price_max = round1(candidate);
  }
}

export function setVizTab(tab) {
  STATE.vizTab = tab;
  notify();
}

// Replace the current legs with a ranked-strategy result from /strategy/search.
export function applyStrategy(strat) {
  if (!STATE.chain) return;
  STATE.legs = strat.legs.map((l, i) => ({
    key: `${l.kind}:${l.strike}:${l.expiration_days}:${i}`,
    side: l.side,
    kind: l.kind,
    strike: l.strike,
    expiration: nearestExpirationLabel(l.expiration_days),
    expiration_days: l.expiration_days,
    iv: l.iv,
    entry_premium: l.entry_premium,
    units: l.units,
    bid: l.entry_premium * 0.98,
    ask: l.entry_premium * 1.02,
    mid: l.entry_premium,
    volume: 0,
    delta: null,
  }));
  // Applying a fresh strategy resets any prior manual overrides — the
  // scenario should track the new legs.
  resetScenarioOverrides();
  reconcileScenarioWithLegs();
  notify();
  schedulePnlRefresh();

  // Scroll the legs panel into view so the user sees the change.
  document.getElementById('panel-legs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function nearestExpirationLabel(days) {
  if (!STATE.chain || !STATE.chain.expirations) return '';
  let best = STATE.chain.expirations[0];
  let bestD = Infinity;
  for (const e of STATE.chain.expirations) {
    const d = Math.abs((e.days || 0) - days);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best.date;
}

// ----- Pnl recompute --------------------------------------------------------

let pnlTimer = null;
function schedulePnlRefresh() {
  if (pnlTimer) clearTimeout(pnlTimer);
  pnlTimer = setTimeout(refreshPnl, 150);
}

async function refreshPnl() {
  if (!STATE.legs.length || !STATE.chain) {
    STATE.pnl = null;
    notify();
    return;
  }
  const req = {
    underlying: {
      spot: STATE.chain.spot,
      rate: STATE.scenario.rate,
      vol:  STATE.scenario.vol,
    },
    scenario: {
      price_min: STATE.scenario.price_min,
      price_max: STATE.scenario.price_max,
      price_steps: STATE.scenario.price_steps,
      days_min: STATE.scenario.days_min,
      days_max: STATE.scenario.days_max,
      day_steps: STATE.scenario.day_steps,
    },
    legs: STATE.legs.map(l => ({
      side: l.side,
      kind: l.kind,
      strike: l.strike,
      expiration_days: l.expiration_days,
      iv: l.iv,
      units: l.units,
      entry_premium: l.entry_premium,
    })),
  };
  try {
    const pnl = await fetchStrategyPnl(req);
    STATE.pnl = pnl;
    notify();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
  }
}

// ----- Helpers --------------------------------------------------------------

function legKey(c, kind) {
  return `${kind}:${c.strike}:${c.expiration}`;
}
function longestDaysToExp(chain) {
  let m = 0;
  for (const c of [...chain.calls, ...chain.puts]) m = Math.max(m, c.days_to_exp || 0);
  return m;
}
function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

function setDataSourceBadge(source) {
  const el = document.getElementById('data-source-badge');
  el.classList.remove('live', 'fixture');
  if (source === 'yahoo') {
    el.classList.add('live');
    el.textContent = '● YAHOO LIVE';
  } else {
    el.classList.add('fixture');
    el.textContent = '◌ FIXTURE';
  }
}

// ----- Boot ----------------------------------------------------------------

installTooltip();
installTour();
mountTickerSearch(document.getElementById('ticker-search-wrap'));
mountChainTable();
mountLegsTable();
mountScenarioPanel();
mountStatsCards();
mountPnlViz();
mountStrategySearch();

setDataSourceBadge('');
document.getElementById('data-source-badge').textContent = 'NO DATA';

// Pre-seed AAPL on load for demo affordance.
selectTicker('AAPL');

// Disclaimer first (every visit), then the onboarding tour.
showDisclaimer().then(() => maybeStartTour());
