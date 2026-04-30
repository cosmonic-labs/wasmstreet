// stats-cards.js — summary cards driven by /strategy/pnl response.

import { subscribe } from '/app.js';

let root;

export function mountStatsCards() {
  root = document.getElementById('stats-row');
  subscribe(render);
  bindVizTabs();
}

function render(state) {
  if (!state.pnl) {
    root.innerHTML = '';
    return;
  }
  const p = state.pnl;
  const fmtMoney = v => (v == null || !isFinite(v))
    ? '—'
    : (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtGreek = v => (v == null) ? '—' : v.toFixed(2);

  const pop = (typeof p.pop_at_horizon === 'number') ? p.pop_at_horizon : null;
  root.innerHTML = `
    <div class="stat-card" data-tooltip="<strong>Probability of Profit at horizon.</strong> Risk-neutral lognormal estimate: given the current spot, the scenario&rsquo;s implied vol (after any IV shock), and the risk-free rate, what fraction of the time would the underlying land in your strategy&rsquo;s profitable price region at the horizon date? Computed by integrating the lognormal density across the price axis weighted by where P&amp;L &gt; 0.">
      <div class="lbl">PoP @ horizon</div>
      <div class="val warn">${pop != null ? pop.toFixed(1) + '%' : '—'}</div>
      <div class="sub">lognormal-weighted</div>
    </div>
    <div class="stat-card" data-tooltip="<strong>Profit Cells.</strong> Geometric coverage — the share of grid cells where the strategy is profitable, ignoring how likely each cell actually is. Sensitive to your chosen price range. <em>Not</em> a probability.">
      <div class="lbl">Profit Cells</div>
      <div class="val" style="color:var(--text-2)">${p.profit_pct.toFixed(1)}%</div>
      <div class="sub">grid coverage</div>
    </div>
    <div class="stat-card" data-tooltip="<strong>Max profit</strong> seen anywhere in the scenario grid (best price &times; best time). Theoretical ceiling under the modeled scenarios.">
      <div class="lbl">Max Profit</div>
      <div class="val pos">${fmtMoney(p.max_profit)}</div>
      <div class="sub">across grid</div>
    </div>
    <div class="stat-card" data-tooltip="<strong>Max loss</strong> seen anywhere in the scenario grid (worst price &times; worst time). Bound your appetite by this number.">
      <div class="lbl">Max Loss</div>
      <div class="val neg">${fmtMoney(p.max_loss)}</div>
      <div class="sub">across grid</div>
    </div>
    <div class="stat-card" data-tooltip="<strong>Net premium</strong> at entry. Positive = you receive cash (credit strategy); negative = you pay cash (debit strategy).">
      <div class="lbl">Net Premium</div>
      <div class="val ${p.net_premium >= 0 ? 'pos' : 'neg'}">${fmtMoney(p.net_premium)}</div>
      <div class="sub">${p.net_premium >= 0 ? 'credit' : 'debit'} at entry</div>
    </div>
    <div class="stat-card" data-tooltip="<strong>Net Δ (delta).</strong> Strategy&rsquo;s sensitivity to the underlying. Positive = profits if spot rises; negative = profits if spot falls; near zero = market-neutral.">
      <div class="lbl">Net Δ</div>
      <div class="val">${fmtGreek(p.net_delta)}</div>
      <div class="sub">vs spot</div>
    </div>
    <div class="stat-card" data-tooltip="<strong>Net Θ (theta), per year.</strong> Time-decay rate. Positive = strategy benefits from passing time (short premium); negative = strategy loses value as time passes (long premium).">
      <div class="lbl">Net Θ</div>
      <div class="val ${p.net_theta < 0 ? 'neg' : 'pos'}">${fmtGreek(p.net_theta)}</div>
      <div class="sub">per year</div>
    </div>
    <div class="stat-card" data-tooltip="<strong>Breakeven prices</strong> at the time horizon. The underlying spot must close above (or below) these at expiry for the strategy to make money.">
      <div class="lbl">Breakevens</div>
      <div class="val" style="font-size:14px">${p.breakeven_prices.length ? p.breakeven_prices.map(x => '$'+x.toFixed(2)).join('  ·  ') : '—'}</div>
      <div class="sub">at horizon</div>
    </div>
  `;
}

function bindVizTabs() {
  const tabs = document.getElementById('viz-tabs');
  if (!tabs) return;
  tabs.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      tabs.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      window.dispatchEvent(new CustomEvent('wasmstreet:viz-tab', { detail: b.dataset.tab }));
    });
  });
}
