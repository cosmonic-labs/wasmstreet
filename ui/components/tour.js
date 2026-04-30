// tour.js — onboarding tour. Runs on every page load (skippable).
//
// A single "spotlight" element uses a giant box-shadow to dim everything
// outside its rect, and a thin slate-purple ring to highlight the target.
// Popover positions itself relative to the spotlight, viewport-clamped.

const STEPS = [
  {
    target: '#ticker-search-wrap input',
    title: 'Pick a ticker',
    body: `Type any ticker — autocomplete drops a list of ~145 popular names served by a wasm component. The current spot price comes <strong>live from Yahoo</strong>, fetched by the <code>market-data</code> wasm component using <code>wasi:http/outgoing-handler</code>.`,
    placement: 'bottom',
  },
  {
    target: '#chain-wrap',
    title: 'Read the option chain',
    body: `Each row is a contract. The <strong>BS Theo</strong> column is the Black-Scholes fair value. <strong>MV/Theo</strong> is market price &divide; that fair value: <span style="color:#1E9C5C">below 100% = undervalued</span>, <span style="color:#D43A47">above 100% = overvalued</span>. Click any column header to sort.`,
    placement: 'top',
  },
  {
    target: '#chain-wrap tbody tr',
    title: 'Click rows to add legs',
    body: `Click a contract row to mark it as a strategy leg. Click again to remove it. Each leg is numbered 1–6 in the column on the left. The scenario panel below auto-tunes its time horizon to the longest leg you pick.`,
    placement: 'right',
  },
  {
    target: '#panel-legs',
    title: 'Configure your legs',
    body: `Selected legs land here. Toggle <strong style="color:#1E9C5C">Buy</strong> / <strong style="color:#D43A47">Sell</strong>, set units, edit the entry premium. Net cash flow updates live — credit means you collect cash, debit means you pay it.`,
    placement: 'top',
  },
  {
    target: '#scenario-controls',
    title: 'Run scenarios',
    body: `Drag the IV-shock or volatility slider and watch the heatmap repaint. Each change fires a <code>POST /strategy/pnl</code>; the C++ <code>pricer-strategy-grid</code> component evaluates 1 800+ Black-Scholes prices in &lt;100ms.`,
    placement: 'top',
  },
  {
    target: '#pnl-viz',
    title: 'Read the P&L grid',
    body: `Every cell is the strategy&rsquo;s P&amp;L at that <strong>price &times; day</strong> combination. Green = profit, red = loss. Hover any cell for the exact dollar value. Switch to <strong>Payoff Lines</strong> for the at-expiry curve with breakeven dots and a risk-free benchmark.`,
    placement: 'top',
  },
  {
    target: '#panel-search',
    title: 'Find winning strategies',
    body: `The C++ <code>pricer-strategy-search</code> component enumerates ~500 candidate strategies on the chain, scores each by your chosen objective (Balanced / Income / Asymmetric / Moonshot), and ranks the top 12. Click <strong>Apply</strong> on any card to load it as your legs.`,
    placement: 'top',
  },
];

let backdrop = null;     // dim "donut" element
let popover  = null;
let currentStep = 0;
let resizeListener = null;

export function installTour() {
  const btn = document.getElementById('tour-btn');
  if (btn) btn.addEventListener('click', () => start());
}

// Auto-run on every load (the user explicitly asked for this — not gated
// on localStorage). User can hit Esc or "Skip tour" to dismiss instantly.
export function maybeStartTour() {
  // Wait for the chain to be loaded so the targets exist.
  setTimeout(() => start(), 700);
}

function start() {
  if (popover) return;  // already running
  currentStep = 0;
  buildOverlay();
  showStep();
}

function buildOverlay() {
  // The "donut": a positioned div with a giant box-shadow that dims the
  // rest of the viewport. We adjust its rect to spotlight the current
  // step's target. No clip-paths, no SVG masks — works in every browser.
  backdrop = document.createElement('div');
  backdrop.id = 'tour-spotlight';
  backdrop.style.cssText = `
    position: fixed;
    z-index: 800;
    border-radius: 8px;
    border: 2px solid var(--slate-purple, #685BC7);
    box-shadow:
      0 0 0 9999px rgba(20, 30, 50, 0.55),
      0 0 0 4px rgba(104, 91, 199, 0.30),
      0 0 24px rgba(104, 91, 199, 0.45);
    pointer-events: none;
    transition: top 220ms ease, left 220ms ease, width 220ms ease, height 220ms ease;
  `;
  document.body.appendChild(backdrop);

  popover = document.createElement('div');
  popover.id = 'tour-popover';
  popover.style.cssText = `
    position: fixed; z-index: 900;
    background: white;
    color: #1A2330;
    border-radius: 10px;
    box-shadow: 0 20px 50px rgba(20,30,50,0.25);
    padding: 18px 20px;
    width: 360px;
    max-width: calc(100vw - 32px);
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    transition: top 220ms ease, left 220ms ease, opacity 200ms ease;
    opacity: 0;
  `;
  popover.innerHTML = `
    <div id="tour-step-counter" style="font-size:10.5px; letter-spacing:1px; text-transform:uppercase; color:#8893A4; font-weight:600;"></div>
    <h3 id="tour-title" style="margin: 6px 0 10px; font-size: 16px; font-weight:600;"></h3>
    <div id="tour-body" style="color:#4A5566;"></div>
    <div style="margin-top:18px; display:flex; justify-content:space-between; align-items:center;">
      <button id="tour-skip" style="background: none; border: none; color:#8893A4; cursor: pointer; font-size:12px; padding:0;">Skip tour</button>
      <div style="display:flex; gap:8px;">
        <button id="tour-prev" style="background:#FAFBFD; color:#4A5566; border:1px solid #DDE4EC; border-radius:6px; padding:6px 14px; cursor:pointer; font-size:12px; font-weight:500;">Back</button>
        <button id="tour-next" style="background:#685BC7; color:white; border:none; border-radius:6px; padding:6px 18px; cursor:pointer; font-size:12px; font-weight:600;">Next →</button>
      </div>
    </div>
  `;
  document.body.appendChild(popover);

  popover.querySelector('#tour-skip').addEventListener('click', dismiss);
  popover.querySelector('#tour-prev').addEventListener('click', () => goto(currentStep - 1));
  popover.querySelector('#tour-next').addEventListener('click', () => goto(currentStep + 1));
  document.addEventListener('keydown', onKey);

  resizeListener = () => positionForCurrentStep();
  window.addEventListener('resize', resizeListener);
  window.addEventListener('scroll', resizeListener, true);
}

function onKey(e) {
  if (!popover) return;
  if (e.key === 'Escape')          dismiss();
  else if (e.key === 'ArrowRight') goto(currentStep + 1);
  else if (e.key === 'ArrowLeft')  goto(currentStep - 1);
}

function goto(i) {
  if (i < 0) return;
  if (i >= STEPS.length) { dismiss(); return; }
  currentStep = i;
  showStep();
}

function showStep() {
  const step = STEPS[currentStep];

  popover.querySelector('#tour-step-counter').textContent = `Step ${currentStep + 1} of ${STEPS.length}`;
  popover.querySelector('#tour-title').textContent = step.title;
  popover.querySelector('#tour-body').innerHTML = step.body;
  popover.querySelector('#tour-prev').style.display = currentStep === 0 ? 'none' : '';
  popover.querySelector('#tour-next').textContent = currentStep === STEPS.length - 1 ? 'Got it' : 'Next →';

  positionForCurrentStep();

  // First time we render the popover, fade it in
  requestAnimationFrame(() => { popover.style.opacity = '1'; });
}

function positionForCurrentStep() {
  const step = STEPS[currentStep];
  const target = step ? document.querySelector(step.target) : null;
  if (!target) {
    // Place spotlight off-screen and centre the popover
    backdrop.style.top    = '-1000px';
    backdrop.style.left   = '-1000px';
    backdrop.style.width  = '0px';
    backdrop.style.height = '0px';
    centerPopover();
    return;
  }

  // Make sure the target is visible
  const rect = target.getBoundingClientRect();
  const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
  if (!inView) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    // Re-measure after scroll resolves
    setTimeout(() => positionForCurrentStep(), 280);
    return;
  }

  const pad = 6;
  const sx = Math.max(4, rect.left - pad);
  const sy = Math.max(4, rect.top - pad);
  const sw = Math.min(window.innerWidth - sx - 4,  rect.width  + pad * 2);
  const sh = Math.min(window.innerHeight - sy - 4, rect.height + pad * 2);

  backdrop.style.left   = `${sx}px`;
  backdrop.style.top    = `${sy}px`;
  backdrop.style.width  = `${sw}px`;
  backdrop.style.height = `${sh}px`;

  placePopover({ top: sy, left: sx, right: sx + sw, bottom: sy + sh, width: sw, height: sh },
               step.placement);
}

function centerPopover() {
  const pw = popover.offsetWidth || 360;
  const ph = popover.offsetHeight || 240;
  popover.style.left = `${(window.innerWidth - pw) / 2}px`;
  popover.style.top  = `${(window.innerHeight - ph) / 2}px`;
}

function placePopover(rect, placement = 'bottom') {
  const pw = popover.offsetWidth || 360;
  const ph = popover.offsetHeight || 240;
  const margin = 18;

  // Try the requested placement; fall back if it would put the popover
  // off-screen or behind the spotlight.
  const tries = [placement, 'bottom', 'top', 'right', 'left'];
  const seen = new Set();
  for (const p of tries) {
    if (seen.has(p)) continue;
    seen.add(p);
    const pos = computePos(rect, p, pw, ph, margin);
    if (fits(pos, pw, ph)) {
      popover.style.left = `${pos.left}px`;
      popover.style.top  = `${pos.top}px`;
      return;
    }
  }
  // Nothing fits — clamp the requested placement
  const pos = computePos(rect, placement, pw, ph, margin);
  popover.style.left = `${Math.max(8, Math.min(window.innerWidth - pw - 8, pos.left))}px`;
  popover.style.top  = `${Math.max(8, Math.min(window.innerHeight - ph - 8, pos.top))}px`;
}

function computePos(rect, placement, pw, ph, margin) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  switch (placement) {
    case 'top':    return { left: cx - pw / 2,         top: rect.top - ph - margin };
    case 'right':  return { left: rect.right + margin, top: cy - ph / 2 };
    case 'left':   return { left: rect.left - pw - margin, top: cy - ph / 2 };
    case 'bottom':
    default:       return { left: cx - pw / 2, top: rect.bottom + margin };
  }
}

function fits(pos, pw, ph) {
  return pos.left >= 8
      && pos.top  >= 8
      && pos.left + pw <= window.innerWidth - 8
      && pos.top  + ph <= window.innerHeight - 8;
}

function dismiss() {
  if (!popover) return;
  document.removeEventListener('keydown', onKey);
  if (resizeListener) {
    window.removeEventListener('resize', resizeListener);
    window.removeEventListener('scroll', resizeListener, true);
    resizeListener = null;
  }
  popover.style.opacity = '0';
  if (backdrop) {
    backdrop.style.opacity = '0';
    backdrop.style.transition = 'opacity 180ms ease';
  }
  setTimeout(() => {
    popover?.remove();
    backdrop?.remove();
    popover = null;
    backdrop = null;
  }, 200);
}
