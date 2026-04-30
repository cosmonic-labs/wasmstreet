// tooltip.js — generic hover-delay tooltip.
//
// Any element with `data-tooltip="..."` attribute (or a child with
// `data-tooltip-target=key`) shows a styled popover after HOVER_DELAY_MS.
// Disappears immediately on mouseleave. Single tooltip element shared
// across the page.
//
// For headers that are dynamically rendered (chain table, legs table, etc.),
// callers re-attach by using a delegated mouseover listener on document.

const HOVER_DELAY_MS = 500;
const HIDE_DELAY_MS = 50;

let tipEl = null;
let showTimer = null;
let hideTimer = null;
let activeEl = null;

function ensureEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.id = 'tooltip';
  tipEl.style.cssText = `
    position: fixed;
    z-index: 1000;
    background: #1A2330;
    color: white;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12px;
    line-height: 1.5;
    padding: 8px 12px;
    border-radius: 6px;
    max-width: 320px;
    box-shadow: 0 6px 20px rgba(20,30,50,0.18);
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 100ms ease, transform 100ms ease;
  `;
  // Arrow
  const arrow = document.createElement('div');
  arrow.id = 'tooltip-arrow';
  arrow.style.cssText = `
    position: absolute;
    width: 8px; height: 8px;
    background: #1A2330;
    transform: rotate(45deg);
  `;
  tipEl.appendChild(arrow);

  const body = document.createElement('div');
  body.id = 'tooltip-body';
  tipEl.appendChild(body);
  document.body.appendChild(tipEl);
  return tipEl;
}

function showTooltip(el, text) {
  ensureEl();
  const body = document.getElementById('tooltip-body');
  const arrow = document.getElementById('tooltip-arrow');
  body.innerHTML = text;
  // Position above the element by default; flip below if not enough room
  const rect = el.getBoundingClientRect();
  tipEl.style.opacity = '0';
  tipEl.style.left = '0px';
  tipEl.style.top = '0px';
  // Force layout to read width
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;

  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));

  const aboveTop = rect.top - th - 10;
  const belowTop = rect.bottom + 10;
  const placeBelow = aboveTop < 8;
  const top = placeBelow ? belowTop : aboveTop;

  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;

  const arrowLeft = rect.left + rect.width / 2 - left - 4;
  arrow.style.left = `${Math.max(8, Math.min(tw - 16, arrowLeft))}px`;
  if (placeBelow) {
    arrow.style.top = '-4px';
    arrow.style.bottom = 'auto';
  } else {
    arrow.style.top = 'auto';
    arrow.style.bottom = '-4px';
  }

  // Animate in
  requestAnimationFrame(() => {
    tipEl.style.opacity = '1';
    tipEl.style.transform = 'translateY(0)';
  });
  activeEl = el;
}

function hideTooltip() {
  if (!tipEl) return;
  tipEl.style.opacity = '0';
  tipEl.style.transform = 'translateY(4px)';
  activeEl = null;
}

function findTooltipTarget(target) {
  let el = target;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.tooltip) return el;
    el = el.parentElement;
  }
  return null;
}

export function installTooltip() {
  document.addEventListener('mouseover', (e) => {
    const el = findTooltipTarget(e.target);
    if (!el) return;
    if (showTimer) clearTimeout(showTimer);
    if (hideTimer) clearTimeout(hideTimer);
    if (activeEl === el) return;
    showTimer = setTimeout(() => {
      showTooltip(el, el.dataset.tooltip);
    }, HOVER_DELAY_MS);
  });
  document.addEventListener('mouseout', (e) => {
    const el = findTooltipTarget(e.target);
    if (!el) return;
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    hideTimer = setTimeout(hideTooltip, HIDE_DELAY_MS);
  });
  // Hide on scroll / Esc
  window.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); });
}
