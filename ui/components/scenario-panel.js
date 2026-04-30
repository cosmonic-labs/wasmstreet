// scenario-panel.js — sliders for price range, vol, rate, days horizon.

import { subscribe, getState, updateScenario } from '/app.js';

let root;
let lastTicker = null;
let lastLegSig = '';

export function mountScenarioPanel() {
  root = document.getElementById('scenario-controls');
  subscribe(state => {
    // Re-render when ticker changes OR when legs change (so we can reflect
    // leg-driven scenario auto-snaps in slider positions). Slider drags
    // themselves don't trigger a re-render — we update slider values
    // imperatively via `bind` to keep focus.
    const sig = state.legs.map(l => `${l.kind}${l.strike}${l.expiration_days}`).join('|');
    const tickerChanged = state.ticker !== lastTicker;
    const legsChanged = sig !== lastLegSig;
    if (tickerChanged || legsChanged || (state.chain && !root.querySelector('#vol'))) {
      lastTicker = state.ticker;
      lastLegSig = sig;
      render(state);
    } else if (state.chain && root.querySelector('#vol')) {
      // No re-render: just update the displayed values to track scenario state
      syncSlidersToState(state);
    }
  });
}

function syncSlidersToState(state) {
  const sc = state.scenario;
  const spot = state.chain.spot;
  const setVal = (id, v, html) => {
    const inp = root.querySelector(`#${id}`);
    if (inp && document.activeElement !== inp) inp.value = v;
    const val = root.querySelector(`#${id}-val`);
    if (val) val.innerHTML = html;
  };
  const lowPct = (sc.price_min / spot - 1) * 100;
  const highPct = (sc.price_max / spot - 1) * 100;
  setVal('lo',   lowPct.toFixed(0),  `${lowPct.toFixed(0)}% &middot; $${sc.price_min.toFixed(2)}`);
  setVal('hi',   highPct.toFixed(0), `+${highPct.toFixed(0)}% &middot; $${sc.price_max.toFixed(2)}`);
  setVal('days', sc.days_max,        `${sc.days_max} d`);
}

function render(state) {
  if (!state.chain) {
    root.innerHTML = '<span class="hint">Select a ticker to enable scenario controls.</span>';
    return;
  }
  const sc = state.scenario;
  const spot = state.chain.spot;
  // Use percent of spot for price range bounds
  const lowPct  = (sc.price_min / spot - 1) * 100;
  const highPct = (sc.price_max / spot - 1) * 100;

  const ov = sc.overrides;
  const hasLegs = state.legs && state.legs.length > 0;
  const autoBadge = (overridden, what) => (!overridden && hasLegs)
    ? `<span class="auto-badge" data-tooltip="Auto-derived from your selected legs (${what}). Drag the slider to override.">auto</span>`
    : '';

  root.innerHTML = `
    <div class="scenario-control" data-tooltip="<strong>Price range</strong> covered by the P&amp;L heatmap, expressed as % from current spot ($${spot.toFixed(2)}). Set how far up and down you want to model.">
      <label>Price range (% from spot) ${autoBadge(ov.price_min && ov.price_max, 'strike spread')}</label>
      <div class="row">
        <input type="range" id="lo" class="slider-lo" min="-40" max="-2" step="1" value="${lowPct.toFixed(0)}">
        <span class="val" id="lo-val">${lowPct.toFixed(0)}% &middot; $${sc.price_min.toFixed(2)}</span>
      </div>
      <div class="row">
        <input type="range" id="hi" class="slider-hi" min="2" max="40" step="1" value="${highPct.toFixed(0)}">
        <span class="val" id="hi-val">+${highPct.toFixed(0)}% &middot; $${sc.price_max.toFixed(2)}</span>
      </div>
    </div>
    <div class="scenario-control" data-tooltip="<strong>IV shock</strong> applied to every leg&rsquo;s implied vol when computing forward marks. Slider at 0% means &lsquo;use the chain&rsquo;s IV as-is&rsquo;. Drag right to model a vol expansion (long-vol positions get richer, short-vol get crushed); drag left to model vol compression.">
      <label>IV shock <span class="auto-badge" style="background:transparent;color:var(--text-mute);text-transform:none;font-weight:500;letter-spacing:0;">applied to every leg</span></label>
      <div class="row">
        <input type="range" id="vol" min="-0.15" max="0.40" step="0.005" value="${sc.vol}">
        <span class="val" id="vol-val">${(sc.vol >= 0 ? '+' : '')}${(sc.vol*100).toFixed(1)}pp</span>
      </div>
      <label data-tooltip="<strong>Risk-free rate.</strong> Used to discount future payoffs in Black-Scholes and to price the &lsquo;cash earning interest&rsquo; benchmark on the payoff chart.">Risk-free rate</label>
      <div class="row">
        <input type="range" id="rate" min="-0.02" max="0.10" step="0.0025" value="${sc.rate}">
        <span class="val" id="rate-val">${(sc.rate*100).toFixed(2)}%</span>
      </div>
    </div>
    <div class="scenario-control" data-tooltip="<strong>Time horizon</strong> in days. The heatmap shows P&amp;L from now (day 0) out to this many days, the latest column representing strategy P&amp;L on the horizon date.">
      <label>Time horizon (days) ${autoBadge(ov.days_max, 'longest leg expiry')}</label>
      <div class="row">
        <input type="range" id="days" min="1" max="120" step="1" value="${sc.days_max}">
        <span class="val" id="days-val">${sc.days_max} d</span>
      </div>
      <label data-tooltip="<strong>Grid resolution.</strong> Higher = smoother heatmap but more compute. Each request fires (price-steps &times; day-steps) Black-Scholes evaluations per leg.">Grid resolution</label>
      <div class="row">
        <input type="range" id="res" min="20" max="120" step="10" value="${sc.price_steps}">
        <span class="val" id="res-val">${sc.price_steps}×${sc.day_steps}</span>
      </div>
    </div>
  `;

  bind('lo',   v => {
    const newMin = spot * (1 + parseFloat(v) / 100);
    updateScenario({ price_min: round1(newMin) });
  }, v => `${parseFloat(v).toFixed(0)}% &middot; $${(spot*(1+parseFloat(v)/100)).toFixed(2)}`);
  bind('hi',   v => {
    const newMax = spot * (1 + parseFloat(v) / 100);
    updateScenario({ price_max: round1(newMax) });
  }, v => `+${parseFloat(v).toFixed(0)}% &middot; $${(spot*(1+parseFloat(v)/100)).toFixed(2)}`);
  bind('vol',  v => updateScenario({ vol: parseFloat(v) }),
              v => `${parseFloat(v) >= 0 ? '+' : ''}${(parseFloat(v)*100).toFixed(1)}pp`);
  bind('rate', v => updateScenario({ rate: parseFloat(v) }), v => `${(parseFloat(v)*100).toFixed(2)}%`);
  bind('days', v => {
    const days = parseInt(v, 10);
    updateScenario({ days_max: days, day_steps: Math.min(days, 60) });
  }, v => `${v} d`);
  bind('res',  v => {
    const r = parseInt(v, 10);
    updateScenario({ price_steps: r, day_steps: Math.min(getState().scenario.days_max, Math.floor(r * 0.5)) });
  }, v => `${v}×${Math.min(getState().scenario.days_max, Math.floor(parseInt(v, 10) * 0.5))}`);
}

function bind(id, onChange, fmtVal) {
  const inp = root.querySelector(`#${id}`);
  const val = root.querySelector(`#${id}-val`);
  inp.addEventListener('input', () => {
    if (val && fmtVal) val.innerHTML = fmtVal(inp.value);
    onChange(inp.value);
  });
}

function round1(v) { return Math.round(v * 10) / 10; }
