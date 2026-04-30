// ticker-search.js — autocomplete input over /tickers.

import { fetchTickers, selectTicker, getState, subscribe } from '/app.js';

let inputEl, suggestionsEl;
let pendingFetch = null;
let kbdIndex = -1;
let lastSuggestions = [];

export function mountTickerSearch(root) {
  root.innerHTML = `
    <div class="ticker-input-row">
      <input type="text" id="ticker-input" placeholder="AAPL"
             autocomplete="off" autocapitalize="off" spellcheck="false" />
      <div class="ticker-suggestions" id="ticker-suggestions"></div>
    </div>
  `;
  inputEl       = root.querySelector('#ticker-input');
  suggestionsEl = root.querySelector('#ticker-suggestions');

  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKeydown);
  inputEl.addEventListener('focus',  () => { if (lastSuggestions.length) suggestionsEl.classList.add('open'); });
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) suggestionsEl.classList.remove('open');
  });

  // Keyboard shortcut: '/' focuses ticker input
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== inputEl &&
        !(document.activeElement instanceof HTMLInputElement)) {
      e.preventDefault();
      inputEl.focus();
      inputEl.select();
    }
  });

  // Reflect current state ticker into the input
  subscribe((s) => {
    if (s.ticker && document.activeElement !== inputEl) {
      inputEl.value = s.ticker;
    }
  });
}

let debounceTimer = null;
function onInput() {
  const q = inputEl.value.trim();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (pendingFetch) pendingFetch.cancelled = true;
    const my = { cancelled: false };
    pendingFetch = my;
    try {
      const r = await fetchTickers(q);
      if (my.cancelled) return;
      lastSuggestions = r.matches || [];
      kbdIndex = lastSuggestions.length ? 0 : -1;
      renderSuggestions();
    } catch (e) { /* network errors are non-fatal */ }
  }, 120);
}

function renderSuggestions() {
  if (!lastSuggestions.length) {
    suggestionsEl.classList.remove('open');
    suggestionsEl.innerHTML = '';
    return;
  }
  suggestionsEl.classList.add('open');
  suggestionsEl.innerHTML = lastSuggestions.map((m, i) => `
    <div class="ticker-suggestion${i === kbdIndex ? ' kbd' : ''}" data-i="${i}">
      <span class="sym">${m.ticker}</span>
      <span class="nm">${escape(m.name)}</span>
    </div>
  `).join('');
  for (const el of suggestionsEl.querySelectorAll('.ticker-suggestion')) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const i = parseInt(el.dataset.i, 10);
      pickSuggestion(i);
    });
  }
}

function onKeydown(e) {
  if (!lastSuggestions.length) {
    if (e.key === 'Enter' && inputEl.value.trim()) {
      selectTicker(inputEl.value.trim().toUpperCase());
      suggestionsEl.classList.remove('open');
    }
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); kbdIndex = Math.min(lastSuggestions.length - 1, kbdIndex + 1); renderSuggestions(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); kbdIndex = Math.max(0, kbdIndex - 1); renderSuggestions(); }
  else if (e.key === 'Enter')   { e.preventDefault(); pickSuggestion(kbdIndex); }
  else if (e.key === 'Escape')  { suggestionsEl.classList.remove('open'); inputEl.blur(); }
}

function pickSuggestion(i) {
  const m = lastSuggestions[i];
  if (!m) return;
  inputEl.value = m.ticker;
  suggestionsEl.classList.remove('open');
  selectTicker(m.ticker);
}

function escape(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
