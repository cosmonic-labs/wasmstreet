// chain-table.js — sortable + filterable enriched option chain.
//
// Rows are toggleable; clicking a row adds it as a leg in app state.

import { subscribe, getState, toggleLeg } from '/app.js';

const FILTER = {
  type: 'all',         // 'all' | 'call' | 'put'
  money: 'all',        // 'all' | 'itm' | 'atm' | 'otm'
  expiration: 'all',
  sort: { col: 'mvtv', dir: 'asc' },
};

let chainRoot, toolbarRoot, stockRoot;

export function mountChainTable() {
  chainRoot   = document.getElementById('chain-wrap');
  toolbarRoot = document.getElementById('chain-toolbar');
  stockRoot   = document.getElementById('stock-card');

  subscribe(render);
}

function render(state) {
  renderStockCard(state.chain);
  renderToolbar(state.chain);
  renderChain(state);
}

function renderStockCard(chain) {
  if (!chain || chain.error) {
    stockRoot.innerHTML = chain?.error
      ? `<span class="name" style="color:var(--red)">${escape(chain.error)}</span>`
      : '';
    return;
  }
  const cls = chain.day_change >= 0 ? 'pos' : 'neg';
  const sign = chain.day_change >= 0 ? '+' : '';
  stockRoot.innerHTML = `
    <span class="ticker">${chain.ticker}</span>
    <span class="price">$${chain.spot.toFixed(2)}</span>
    <span class="change ${cls}">${sign}${chain.day_change.toFixed(2)} (${sign}${chain.day_change_pct.toFixed(2)}%)</span>
    <span class="name">${escape(chain.name || '')}</span>
  `;
}

function renderToolbar(chain) {
  if (!chain || !chain.expirations) {
    toolbarRoot.innerHTML = '';
    return;
  }
  const expOpts = chain.expirations
    .map(e => `<option value="${e.date}">${e.date} (${Math.round(e.days)}d)</option>`)
    .join('');
  toolbarRoot.innerHTML = `
    <div class="toolbar-group">
      <label>Type</label>
      <button data-filter="type" data-val="all"  class="${FILTER.type==='all'?'active':''}">All</button>
      <button data-filter="type" data-val="call" class="${FILTER.type==='call'?'active':''}">Call</button>
      <button data-filter="type" data-val="put"  class="${FILTER.type==='put' ?'active':''}">Put</button>
    </div>
    <div class="toolbar-group">
      <label>Money</label>
      <button data-filter="money" data-val="all" class="${FILTER.money==='all'?'active':''}">All</button>
      <button data-filter="money" data-val="itm" class="${FILTER.money==='itm'?'active':''}">ITM</button>
      <button data-filter="money" data-val="atm" class="${FILTER.money==='atm'?'active':''}">ATM</button>
      <button data-filter="money" data-val="otm" class="${FILTER.money==='otm'?'active':''}">OTM</button>
    </div>
    <div class="toolbar-group">
      <label>Expiry</label>
      <select id="exp-select">
        <option value="all">All expirations</option>
        ${expOpts}
      </select>
    </div>
  `;
  toolbarRoot.querySelectorAll('button[data-filter]').forEach(b => {
    b.addEventListener('click', () => {
      FILTER[b.dataset.filter] = b.dataset.val;
      renderToolbar(chain);
      renderChain(getState());
    });
  });
  const sel = toolbarRoot.querySelector('#exp-select');
  sel.value = FILTER.expiration;
  sel.addEventListener('change', () => {
    FILTER.expiration = sel.value;
    renderChain(getState());
  });
}

const COLUMNS = [
  { key: 'leg',        label: 'Leg',     first: true,  numeric: false,
    tip: '<strong>Leg selector.</strong> Click any row to add it as a leg in your strategy. Click again to remove. Selected legs show their position number (1–6).' },
  { key: 'mvtv',       label: 'MV/Theo', numeric: true,  fmt: v => (v == null ? '—' : (v * 100).toFixed(1) + '%'),
    tip: '<strong>Market mid &divide; Black-Scholes theoretical price.</strong><br>Below 100% means the contract is trading <em>cheaper</em> than the BS model says it should — undervalued (green). Above 100% means it&rsquo;s trading <em>richer</em> than BS — overvalued (red). The neutral band is 98–102%.' },
  { key: 'kind',       label: 'Type',    numeric: false, fmt: v => v.toUpperCase(),
    tip: '<strong>Call</strong> = right to buy at the strike. <strong>Put</strong> = right to sell at the strike.' },
  { key: 'expiration', label: 'Expiry',  numeric: false,
    tip: '<strong>Expiration date.</strong> The last day this contract is tradable. The chain shows three expirations (≈ 14, 30, 60 days out).' },
  { key: 'days',       label: 'DTE',     numeric: true,  fmt: v => Math.round(v).toString(),
    tip: '<strong>Days to expiration.</strong> Shorter DTE = faster theta decay (you lose extrinsic value faster).' },
  { key: 'strike',     label: 'Strike',  numeric: true,  fmt: v => v.toFixed(2),
    tip: '<strong>Strike price.</strong> The price at which the option can be exercised.' },
  { key: 'mid',        label: 'Mkt Mid', numeric: true,  fmt: v => v.toFixed(2),
    tip: '<strong>Market mid price.</strong> The midpoint of the bid/ask spread — what the market is actually pricing this contract at.' },
  { key: 'theo',       label: 'BS Theo', numeric: true,  fmt: v => v.toFixed(2),
    tip: '<strong>Black-Scholes theoretical price.</strong> Computed by the <code>pricer-black-scholes</code> wasm component using the contract&rsquo;s implied vol and time to expiry. This is the &ldquo;fair value&rdquo; the BS model assigns.' },
  { key: 'bid',        label: 'Bid',     numeric: true,  fmt: v => v.toFixed(2),
    tip: '<strong>Bid.</strong> The highest price a buyer is currently willing to pay.' },
  { key: 'ask',        label: 'Ask',     numeric: true,  fmt: v => v.toFixed(2),
    tip: '<strong>Ask.</strong> The lowest price a seller is currently willing to accept.' },
  { key: 'iv',         label: 'IV',      numeric: true,  fmt: v => (v * 100).toFixed(1) + '%',
    tip: '<strong>Implied volatility.</strong> The annualized volatility implied by the market mid price. Higher IV = market expects bigger moves.' },
  { key: 'delta',      label: 'Δ',       numeric: true,  fmt: v => v.toFixed(3),
    tip: '<strong>Delta (Δ).</strong> First-order sensitivity of the option price to the underlying. Approximately the probability the option finishes ITM. Calls: 0 to 1; puts: -1 to 0.' },
  { key: 'gamma',      label: 'Γ',       numeric: true,  fmt: v => v.toFixed(4),
    tip: '<strong>Gamma (Γ).</strong> Rate of change of delta with respect to the underlying. Peaks at-the-money. High gamma = delta moves fast as spot moves.' },
  { key: 'volume',     label: 'Vol',     numeric: true,  fmt: v => v.toLocaleString(),
    tip: '<strong>Volume.</strong> Today&rsquo;s contracts traded. Higher volume usually means tighter spreads.' },
  { key: 'oi',         label: 'OI',      numeric: true,  fmt: v => v.toLocaleString(),
    tip: '<strong>Open interest.</strong> Total outstanding contracts not yet closed/exercised. A measure of liquidity.' },
];

function renderChain(state) {
  const chain = state.chain;
  if (!chain || !chain.calls) {
    chainRoot.innerHTML = '<div class="empty">Type a ticker above to load its option chain.</div>';
    return;
  }
  const rows = collectRows(chain);

  // Sort
  const { col, dir } = FILTER.sort;
  rows.sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
    return dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  const legKeys = new Set(state.legs.map(l => `${l.kind}:${l.strike}:${l.expiration}`));
  const legNumByKey = new Map();
  state.legs.forEach((l, i) => legNumByKey.set(`${l.kind}:${l.strike}:${l.expiration}`, i + 1));

  const ths = COLUMNS.map(c => {
    const sortClass = (col === c.key) ? (dir === 'asc' ? 'sort-asc' : 'sort-desc') : '';
    const firstCls = c.first ? 'first-col' : '';
    const tipAttr = c.tip ? ` data-tooltip="${escapeAttr(c.tip)}"` : '';
    return `<th class="sortable ${sortClass} ${firstCls}" data-col="${c.key}"${tipAttr}>${c.label}</th>`;
  }).join('');

  const tbody = rows.map(r => {
    const key = `${r.kind}:${r.strike}:${r.expiration}`;
    const sel = legKeys.has(key);
    const legN = legNumByKey.get(key);
    const ratioCls = (r.mvtv == null) ? 'fair'
      : (r.mvtv < 0.98 ? 'under' : (r.mvtv > 1.02 ? 'over' : 'fair'));
    const cells = COLUMNS.map(c => {
      if (c.first) {
        return `<td class="first-col"><span class="leg-num">${legN ?? '+'}</span></td>`;
      }
      let v = r[c.key];
      if (c.key === 'mvtv') {
        return `<td class="cell-mvtv ${ratioCls}">${c.fmt(v)}</td>`;
      }
      let cls = '';
      if (c.numeric === false) cls = 'text';
      return `<td class="${cls}">${v == null ? '—' : (c.fmt ? c.fmt(v) : v)}</td>`;
    }).join('');
    return `<tr class="${sel ? 'selected' : ''}" data-row="${escape(key)}">${cells}</tr>`;
  }).join('');

  chainRoot.innerHTML = `
    <table class="chain">
      <thead><tr>${ths}</tr></thead>
      <tbody>${tbody}</tbody>
    </table>
  `;

  // Sort header clicks
  chainRoot.querySelectorAll('th[data-col]').forEach(th => {
    if (th.dataset.col === 'leg') return;
    th.addEventListener('click', () => {
      const c = th.dataset.col;
      if (FILTER.sort.col === c) FILTER.sort.dir = FILTER.sort.dir === 'asc' ? 'desc' : 'asc';
      else { FILTER.sort.col = c; FILTER.sort.dir = 'asc'; }
      renderChain(getState());
    });
  });

  // Row clicks toggle a leg
  chainRoot.querySelectorAll('tr[data-row]').forEach(tr => {
    tr.addEventListener('click', () => {
      const key = tr.dataset.row;
      const row = rows.find(r => `${r.kind}:${r.strike}:${r.expiration}` === key);
      if (!row) return;
      const contract = row._raw;
      toggleLeg(contract, row.kind);
    });
  });
}

function collectRows(chain) {
  const all = [];
  for (const c of chain.calls) {
    if (FILTER.type === 'put') continue;
    if (!matchesExp(c, chain)) continue;
    if (!matchesMoney('call', c, chain.spot)) continue;
    all.push(buildRow(c, 'call'));
  }
  for (const p of chain.puts) {
    if (FILTER.type === 'call') continue;
    if (!matchesExp(p, chain)) continue;
    if (!matchesMoney('put', p, chain.spot)) continue;
    all.push(buildRow(p, 'put'));
  }
  return all;
}

function matchesExp(c, chain) {
  if (FILTER.expiration === 'all') return true;
  return c.expiration === FILTER.expiration;
}
function matchesMoney(kind, c, spot) {
  if (FILTER.money === 'all') return true;
  const itm = (kind === 'call' && spot > c.strike) || (kind === 'put' && spot < c.strike);
  const distance = Math.abs(spot - c.strike) / spot;
  if (FILTER.money === 'itm') return itm && distance > 0.01;
  if (FILTER.money === 'otm') return !itm && distance > 0.01;
  if (FILTER.money === 'atm') return distance <= 0.02;
  return true;
}

function buildRow(c, kind) {
  return {
    _raw: c,
    kind,
    expiration: c.expiration,
    days: c.days_to_exp,
    strike: c.strike,
    mid: c.mid,
    theo: c.theoretical_price,
    bid: c.bid,
    ask: c.ask,
    iv: c.iv,
    delta: c.delta,
    gamma: c.gamma,
    volume: c.volume,
    oi: c.open_interest,
    mvtv: (c.theoretical_price > 0) ? (c.mid / c.theoretical_price) : null,
  };
}

function escape(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;',
  }[c]));
}

// For HTML attribute values that should preserve embedded markup (the
// tooltip body uses innerHTML on the value). Only quotes and & need escaping
// inside an attribute.
function escapeAttr(s) {
  return String(s).replace(/[&"]/g, c => ({ '&':'&amp;', '"':'&quot;' }[c]));
}
