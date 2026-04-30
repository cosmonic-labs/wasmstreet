// pnl-viz.js — switches between heatmap and payoff-line views.

import { subscribe, getState } from '/app.js';
import { createHeatmap }       from '/viz/pnl-heatmap.js';
import { renderPayoffLines }   from '/viz/payoff-line.js';

let root, heatmap, currentTab = 'heatmap';
let mountedTab = null;

export function mountPnlViz() {
  root = document.getElementById('pnl-viz');

  window.addEventListener('wasmstreet:viz-tab', (e) => {
    currentTab = e.detail;
    swap();
    render(getState());
  });

  subscribe(render);
}

function swap() {
  if (mountedTab === currentTab) return;
  if (heatmap) { heatmap.dispose(); heatmap = null; }
  root.innerHTML = '';
  mountedTab = currentTab;
}

function render(state) {
  if (!state.pnl || !state.legs.length) {
    if (heatmap) { heatmap.dispose(); heatmap = null; }
    root.innerHTML = '<div class="empty">Add at least one leg to see the P&amp;L grid.</div>';
    mountedTab = null;
    return;
  }

  if (currentTab === 'heatmap') {
    swap();
    if (!heatmap) heatmap = createHeatmap(root);
    heatmap.update(state.pnl, {
      vol: state.scenario.vol,
      rate: state.scenario.rate,
      spot: state.chain ? state.chain.spot : null,
    });
  } else {
    swap();
    renderPayoffLines(root, state);
  }
}
