// legs-table.js — configurable leg rows.
// Columns: # | Side (Buy/Sell) | Kind | Strike | Expiry | Units | Entry | Bid | Ask | Volume | Cash Flow | Δ | × remove
// Cash flow = entry_premium × 100 × units × (sell ? +1 : -1) (credit positive)

import { subscribe, getState, updateLeg, removeLeg } from '/app.js';

let root;

export function mountLegsTable() {
  root = document.getElementById('legs-wrap');
  subscribe(render);
}

function render(state) {
  if (!state.legs.length) {
    root.innerHTML = '<div class="empty">No legs yet — click rows in the chain above.</div>';
    return;
  }

  const rows = state.legs.map((l, i) => renderLegRow(l, i)).join('');
  const totals = renderTotalsRow(state);

  root.innerHTML = `
    <table class="legs-table">
      <thead>
        <tr>
          <th class="leg-num-cell" data-tooltip="Leg position in the strategy.">#</th>
          <th data-tooltip="<strong>Buy</strong> (long): pay the premium up front, profit if price rises (calls) or falls (puts). <strong>Sell</strong> (short): collect the premium up front, profit if the option expires worthless.">Side</th>
          <th data-tooltip="<strong>Call</strong> = right to buy at the strike. <strong>Put</strong> = right to sell at the strike.">Type</th>
          <th data-tooltip="Strike price. The price at which the option can be exercised.">Strike</th>
          <th data-tooltip="Expiration date and days remaining.">Expiry</th>
          <th data-tooltip="<strong>Units</strong> = number of contracts. Each contract represents 100 shares of the underlying.">Units</th>
          <th data-tooltip="<strong>Entry premium</strong> per share. Defaults to mid price; edit to model your actual fill.">Entry</th>
          <th data-tooltip="Current bid (highest price a buyer will pay).">Bid</th>
          <th data-tooltip="Current ask (lowest price a seller will accept).">Ask</th>
          <th data-tooltip="<strong>Implied volatility</strong> at this strike — used by the pricer when projecting forward.">IV</th>
          <th data-tooltip="Today&rsquo;s contract volume.">Vol</th>
          <th data-tooltip="<strong>Delta (Δ)</strong> at scenario spot. Sums across legs to give your strategy&rsquo;s net delta exposure.">Δ</th>
          <th data-tooltip="<strong>Net cash flow</strong> at entry = entry premium &times; 100 &times; units, signed by side. Positive = credit received; negative = debit paid.">Cash Flow</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}${totals}</tbody>
    </table>
  `;

  // Bind handlers
  root.querySelectorAll('button[data-side]').forEach(b => {
    b.addEventListener('click', () => {
      const key = b.dataset.key;
      const side = b.dataset.side;
      updateLeg(key, { side });
    });
  });
  root.querySelectorAll('input.units').forEach(inp => {
    inp.addEventListener('change', () => {
      const key = inp.dataset.key;
      const units = Math.max(1, parseInt(inp.value, 10) || 1);
      updateLeg(key, { units });
    });
  });
  root.querySelectorAll('input.entry').forEach(inp => {
    inp.addEventListener('change', () => {
      const key = inp.dataset.key;
      const entry_premium = parseFloat(inp.value);
      if (!isNaN(entry_premium)) updateLeg(key, { entry_premium });
    });
  });
  root.querySelectorAll('button.leg-remove').forEach(b => {
    b.addEventListener('click', () => removeLeg(b.dataset.key));
  });
}

function renderLegRow(leg, i) {
  const k = escape(leg.key);
  const cf = cashFlow(leg);
  const cfCls = cf >= 0 ? 'cell-pos' : 'cell-neg';
  const sign = cf >= 0 ? '+' : '';
  return `
    <tr>
      <td class="leg-num-cell"><span class="leg-num">${i + 1}</span></td>
      <td style="text-align:left">
        <div class="leg-side">
          <button data-key="${k}" data-side="buy"  class="${leg.side==='buy' ?'active buy' :''} buy">Buy</button>
          <button data-key="${k}" data-side="sell" class="${leg.side==='sell'?'active sell':''} sell">Sell</button>
        </div>
      </td>
      <td>${leg.kind.toUpperCase()}</td>
      <td>${leg.strike.toFixed(2)}</td>
      <td>${leg.expiration} <span style="color:var(--text-mute)">(${Math.round(leg.expiration_days)}d)</span></td>
      <td><input type="number" min="1" step="1" class="units" data-key="${k}" value="${leg.units}"></td>
      <td><input type="number" step="0.01" class="units entry" data-key="${k}" value="${leg.entry_premium.toFixed(2)}" style="width:78px"></td>
      <td>${leg.bid.toFixed(2)}</td>
      <td>${leg.ask.toFixed(2)}</td>
      <td>${(leg.iv * 100).toFixed(1)}%</td>
      <td>${(leg.volume || 0).toLocaleString()}</td>
      <td>${(leg.delta != null) ? leg.delta.toFixed(3) : '—'}</td>
      <td class="${cfCls}">${sign}${cf.toFixed(2)}</td>
      <td><button class="leg-remove" data-key="${k}">×</button></td>
    </tr>
  `;
}

function renderTotalsRow(state) {
  const total = state.legs.reduce((acc, l) => acc + cashFlow(l), 0);
  const totalDelta = state.legs.reduce((acc, l) => {
    const sign = (l.side === 'buy') ? +1 : -1;
    const d = (l.kind === 'call') ? (l.delta ?? 0) : ((l.delta ?? 0));
    return acc + sign * (l.units || 1) * 100 * d;
  }, 0);
  const sign = total >= 0 ? '+' : '';
  const cls = total >= 0 ? 'cell-pos' : 'cell-neg';
  return `
    <tr class="legs-totals">
      <td colspan="12" style="text-align:right">Net cash flow (${total >= 0 ? 'credit' : 'debit'}):</td>
      <td class="${cls}">${sign}${total.toFixed(2)}</td>
      <td></td>
    </tr>
  `;
}

function cashFlow(leg) {
  const sign = (leg.side === 'sell') ? +1 : -1;
  return sign * leg.entry_premium * 100 * (leg.units || 1);
}

function escape(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;',
  }[c]));
}
