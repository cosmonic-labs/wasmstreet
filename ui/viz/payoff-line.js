// payoff-line.js — SVG payoff diagram at expiry (and at horizon if shorter).
// Computes the per-leg and total payoff curve client-side from a price sweep
// and the legs definitions, mirroring the strategy-grid math at days_remaining=0.

export function renderPayoffLines(container, state) {
  const { chain, legs, scenario, pnl } = state;
  if (!legs.length || !pnl) {
    container.innerHTML = '<div class="empty">Add at least one leg to see the payoff diagram.</div>';
    return;
  }

  const w = container.clientWidth || 800;
  const h = container.clientHeight || 480;
  // Top room for two label tracks (breakevens + strikes/spot).
  const padL = 64, padR = 24, padT = 56, padB = 64;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const prices = pnl.price_axis;
  const lastDayCol = pnl.cols - 1;
  const payoffs = prices.map((_, i) => pnl.pnl_grid[i * pnl.cols + lastDayCol]);
  const maxAbs = Math.max(Math.abs(pnl.max_profit), Math.abs(pnl.max_loss), 1);

  const xToPx = p => padL + ((p - prices[0]) / (prices[prices.length - 1] - prices[0])) * innerW;
  const yToPx = v => padT + innerH * (1 - (v + maxAbs) / (2 * maxAbs));
  const yZero = yToPx(0);

  const pts = prices.map((p, i) => `${xToPx(p).toFixed(1)},${yToPx(payoffs[i]).toFixed(1)}`).join(' ');

  const spot = chain ? chain.spot : null;

  // ---------- Top label tracks: breakevens (top), strikes + spot (below) ---
  // Track Y positions:
  //   yBE      = 12  (breakeven pills, very top)
  //   yStrike  = 36  (strike + spot pills, just above chart)
  const yBE = 14;
  const yStrike = 38;

  const pill = (cx, y, text, fg, bg, opts = {}) => {
    const padX = 5;
    const fontSize = opts.fontSize ?? 10;
    const tw = text.length * fontSize * 0.62 + padX * 2;
    const tx = Math.max(padL + 4, Math.min(padL + innerW - 4, cx));
    return `
      <rect x="${(tx - tw / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}"
            width="${tw.toFixed(1)}" height="16" rx="3" ry="3"
            fill="${bg}" stroke="${fg}" stroke-width="0.7" stroke-opacity="0.45"/>
      <text x="${tx.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle"
            font-family="JetBrains Mono" font-size="${fontSize}" font-weight="600"
            fill="${fg}">${text}</text>
    `;
  };

  // Strike vertical lines + pill labels in the strike row
  const strikeEls = legs.map(l => {
    const x = xToPx(l.strike);
    if (x < padL || x > padL + innerW) return '';
    const color = l.kind === 'call' ? '#685BC7' : '#4D43A0';
    return `
      <line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + innerH}"
            stroke="${color}" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>
      ${pill(x, yStrike, `${l.kind === 'call' ? 'C' : 'P'}${l.strike.toFixed(0)}`, color, '#EFEDFA')}
    `;
  }).join('');

  // Spot pill (yellow). Sits in the strike row alongside other markers.
  const spotEl = (spot != null) ? `
    <line x1="${xToPx(spot)}" y1="${padT}" x2="${xToPx(spot)}" y2="${padT + innerH}"
          stroke="#FFB600" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85"/>
    ${pill(xToPx(spot), yStrike, `spot $${spot.toFixed(0)}`, '#B07408', '#FFF1D6')}
  ` : '';

  // Breakevens — vertical dashed lines + pills in the BE row at the top
  const beEls = (pnl.breakeven_prices || []).map(b => {
    const x = xToPx(b);
    if (x < padL || x > padL + innerW) return '';
    return `
      <line x1="${x}" y1="${yBE + 8}" x2="${x}" y2="${padT + innerH}"
            stroke="#1A2330" stroke-width="1.3" stroke-dasharray="5 4" opacity="0.7"/>
      ${pill(x, yBE, `BE $${b.toFixed(2)}`, '#1A2330', '#FFFFFF')}
    `;
  }).join('');

  // ---------- Y-axis ticks (P&L) ---------------------------------------------
  const yTicks = [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs];
  const yTickEls = yTicks.map(v => `
    <line x1="${padL}" x2="${padL - 4}" y1="${yToPx(v)}" y2="${yToPx(v)}" stroke="#8893A4"/>
    <text x="${padL - 8}" y="${yToPx(v) + 3}" text-anchor="end"
          font-family="JetBrains Mono" font-size="10" fill="#4A5566">${formatMoney(v)}</text>
  `).join('');

  // ---------- X-axis ticks: $ + % from spot, BELOW the chart ---------------
  const xTicks = 5;
  const xTickEls = Array.from({ length: xTicks }, (_, i) => {
    const f = i / (xTicks - 1);
    const p = prices[0] + (prices[prices.length - 1] - prices[0]) * f;
    const pct = spot ? ((p / spot - 1) * 100) : null;
    const pctTxt = pct == null ? '' : (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%';
    return `
      <line x1="${xToPx(p)}" x2="${xToPx(p)}" y1="${padT + innerH}" y2="${padT + innerH + 4}" stroke="#8893A4"/>
      <text x="${xToPx(p)}" y="${padT + innerH + 16}" text-anchor="middle"
            font-family="JetBrains Mono" font-size="10" fill="#4A5566">$${p.toFixed(0)}</text>
      <text x="${xToPx(p)}" y="${padT + innerH + 30}" text-anchor="middle"
            font-family="JetBrains Mono" font-size="9" fill="#8893A4">${pctTxt}</text>
    `;
  }).join('');

  // ---------- Profit/loss shading -------------------------------------------
  const positivePts = prices.map((p, i) => {
    const v = payoffs[i];
    const y = v > 0 ? yToPx(v) : yZero;
    return `${xToPx(p).toFixed(1)},${y.toFixed(1)}`;
  });
  const negativePts = prices.map((p, i) => {
    const v = payoffs[i];
    const y = v < 0 ? yToPx(v) : yZero;
    return `${xToPx(p).toFixed(1)},${y.toFixed(1)}`;
  });
  const posShape = `${xToPx(prices[0]).toFixed(1)},${yZero.toFixed(1)} ${positivePts.join(' ')} ${xToPx(prices[prices.length-1]).toFixed(1)},${yZero.toFixed(1)}`;
  const negShape = `${xToPx(prices[0]).toFixed(1)},${yZero.toFixed(1)} ${negativePts.join(' ')} ${xToPx(prices[prices.length-1]).toFixed(1)},${yZero.toFixed(1)}`;

  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <!-- Title (top-right corner, in the BE label gutter) -->
      <text x="${w - padR - 6}" y="${yBE + 4}" text-anchor="end"
            font-family="Inter" font-size="11" font-weight="600" fill="#4A5566">
        Strategy P&amp;L at expiry
      </text>

      <!-- Axes -->
      <line x1="${padL}" y1="${yZero}" x2="${padL + innerW}" y2="${yZero}" stroke="#C9D2DD" stroke-width="1"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="#C9D2DD" stroke-width="1"/>
      ${yTickEls}
      ${xTickEls}

      <!-- Profit / loss shading -->
      <polygon points="${posShape}" fill="#1E9C5C" fill-opacity="0.18"/>
      <polygon points="${negShape}" fill="#D43A47" fill-opacity="0.16"/>

      <!-- Risk-free benchmark: what cash earning the risk-free rate
           would have made over the same horizon, on the same capital
           outlay. Drawn as a horizontal teal-dashed line + label. -->
      ${riskFreeLine(scenario, pnl, padL, padR, innerW, padT, yToPx, w)}

      <!-- Strike + spot guides + pills (strike row) -->
      ${strikeEls}
      ${spotEl}

      <!-- Breakeven guides + pills (BE row) -->
      ${beEls}

      <!-- Payoff curve drawn last so it sits above everything -->
      <polyline fill="none" stroke="#685BC7" stroke-width="2.5" stroke-linejoin="round" points="${pts}"/>
    </svg>
  `;
}

// Compute and render a horizontal "risk-free" reference line at
// risk_free_return = |net_premium| * rate * (days_max / 365).
// This is the dollar return you'd earn if you invested the same
// capital at the risk-free rate over the strategy's time horizon —
// i.e. the opportunity cost. If the strategy's payoff curve is below
// this line, you're worse off than holding cash.
function riskFreeLine(scenario, pnl, padL, padR, innerW, padT, yToPx, w) {
  if (!scenario || !pnl || pnl.net_premium == null) return '';
  const rate = scenario.rate || 0;
  const days = scenario.days_max || 0;
  if (rate <= 0 || days <= 0) return '';
  const capital = Math.abs(pnl.net_premium);
  if (capital < 1) return '';
  const rfReturn = capital * rate * (days / 365);
  const y = yToPx(rfReturn);
  const xLeft = padL + 4;
  const xRight = padL + innerW - 4;
  return `
    <line x1="${xLeft}" y1="${y.toFixed(1)}" x2="${xRight}" y2="${y.toFixed(1)}"
          stroke="#0EA5A5" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.85"/>
    <rect x="${(xLeft).toFixed(1)}" y="${(y - 9).toFixed(1)}"
          width="135" height="18" rx="4" ry="4"
          fill="#E6F7F7" stroke="#0EA5A5" stroke-opacity="0.6"/>
    <text x="${(xLeft + 6).toFixed(1)}" y="${(y + 4).toFixed(1)}"
          font-family="JetBrains Mono" font-size="10" font-weight="600"
          fill="#0EA5A5">
      Risk-free $${rfReturn.toFixed(2)} (${(rate*100).toFixed(2)}% × ${days}d)
    </text>
  `;
}

function formatMoney(v) {
  if (Math.abs(v) >= 1000) return (v >= 0 ? '+' : '-') + '$' + Math.round(Math.abs(v) / 100) / 10 + 'k';
  return (v >= 0 ? '+' : '-') + '$' + Math.round(Math.abs(v)).toLocaleString();
}
