// pnl-heatmap.js — colored P&L spreadsheet.
//
// Three.js InstancedMesh paints the colored cell layer (one quad per
// (price × day) cell, GPU-accelerated). DOM overlays draw:
//   - the axes (price on Y with $ AND %-from-spot, days on X with date)
//   - cell values when grid is small enough to be readable
//   - a hover tooltip with full context (price, day, vol, P&L)
//   - a header strip with a color-bar legend.
//
// The user sees a grid that *looks* like a colored spreadsheet, but
// rendered fast.

import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

const GREEN   = new THREE.Color('#1E9C5C');
const RED     = new THREE.Color('#D43A47');
const NEUTRAL = new THREE.Color('#FFFFFF');

export function createHeatmap(container) {
  // Layout: top legend strip, then the grid area.
  container.innerHTML = '';
  container.style.position = 'relative';
  container.style.overflow = 'hidden';

  // Top: color-bar legend with min..0..max
  const legend = document.createElement('div');
  legend.id = 'heatmap-legend';
  legend.style.cssText = `
    position: absolute; top: 8px; right: 12px;
    font-family: var(--mono); font-size: 10.5px; color: var(--text-2);
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px; background: rgba(255,255,255,0.85);
    border: 1px solid var(--border); border-radius: 4px;
    z-index: 8;
  `;
  legend.innerHTML = `
    <span id="legend-min">—</span>
    <span style="display:inline-block; width:80px; height:8px; background:linear-gradient(to right, #D43A47, #FFFFFF, #1E9C5C); border:1px solid #C9D2DD;"></span>
    <span id="legend-max">—</span>
  `;
  container.appendChild(legend);

  // Header label (vol/rate pinned)
  const headerLabel = document.createElement('div');
  headerLabel.id = 'heatmap-header-label';
  headerLabel.style.cssText = `
    position: absolute; top: 10px; left: 14px;
    font-family: var(--sans); font-size: 11px; font-weight: 600;
    color: var(--text-2);
    z-index: 8;
  `;
  container.appendChild(headerLabel);

  // GL canvas wrapper — uses absolute layout inside container
  const canvasWrap = document.createElement('div');
  canvasWrap.id = 'heatmap-canvas';
  canvasWrap.style.cssText = `
    position: absolute;
    inset: 36px 60px 50px 80px;
    background: white;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  `;
  container.appendChild(canvasWrap);

  // Y axis (prices)
  const yAxis = document.createElement('div');
  yAxis.style.cssText = `
    position: absolute; left: 0; top: 36px; bottom: 50px; width: 80px;
    pointer-events: none; z-index: 6;
  `;
  container.appendChild(yAxis);

  // X axis (days)
  const xAxis = document.createElement('div');
  xAxis.style.cssText = `
    position: absolute; left: 80px; right: 60px; bottom: 0; height: 50px;
    pointer-events: none; z-index: 6;
  `;
  container.appendChild(xAxis);

  // Y axis title
  const yTitle = document.createElement('div');
  yTitle.style.cssText = `
    position: absolute; left: 4px; top: 50%;
    transform: translate(0, -50%) rotate(-90deg); transform-origin: 0 50%;
    font-family: var(--mono); font-size: 10.5px; color: var(--text-mute);
    letter-spacing: 0.5px;
  `;
  yTitle.textContent = 'Underlying $  /  % from spot';
  container.appendChild(yTitle);

  // X axis title
  const xTitle = document.createElement('div');
  xTitle.style.cssText = `
    position: absolute; left: 50%; bottom: 4px; transform: translateX(-50%);
    font-family: var(--mono); font-size: 10.5px; color: var(--text-mute);
    letter-spacing: 0.5px;
  `;
  xTitle.textContent = 'Days from now →';
  container.appendChild(xTitle);

  // Tooltip
  const tip = document.createElement('div');
  tip.className = 'heatmap-tooltip';
  container.appendChild(tip);

  // Three.js setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  camera.position.z = 5;
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0xffffff, 1);
  canvasWrap.appendChild(renderer.domElement);

  let mesh = null;
  let lastData = null;
  let valueLayer = null; // DOM div with per-cell value text
  let scenarioInfo = { vol: null, rate: null, spot: null };

  function dispose() {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh = null;
    }
  }

  function pnlToColor(pnl, scale) {
    if (scale <= 0) return NEUTRAL;
    const t = Math.max(-1, Math.min(1, pnl / scale));
    const c = new THREE.Color();
    if (t >= 0) c.copy(NEUTRAL).lerp(GREEN, t);
    else        c.copy(NEUTRAL).lerp(RED,   -t);
    return c;
  }

  function resize() {
    const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (lastData) {
      camera.left = 0; camera.right = lastData.cols;
      camera.bottom = 0; camera.top = lastData.rows;
      camera.updateProjectionMatrix();
    }
  }

  const ro = new ResizeObserver(() => {
    resize();
    if (lastData) repaintAxes();
    if (lastData) renderer.render(scene, camera);
  });
  ro.observe(canvasWrap);

  function update(data, scenario) {
    lastData = data;
    scenarioInfo = scenario || scenarioInfo;
    dispose();

    const { pnl_grid, rows, cols, max_profit, max_loss } = data;
    const scale = Math.max(Math.abs(max_profit), Math.abs(max_loss), 1);

    // Update legend
    document.getElementById('legend-min').textContent = fmtMoneyShort(max_loss);
    document.getElementById('legend-max').textContent = fmtMoneyShort(max_profit);
    const horizonDays = data.day_axis.length
      ? data.day_axis[data.day_axis.length - 1]
      : 0;
    headerLabel.innerHTML = scenarioInfo.vol != null
      ? `<strong>P&amp;L grid</strong> · horizon <strong>${horizonDays.toFixed(0)}d</strong> · vol ${(scenarioInfo.vol * 100).toFixed(1)}% · rate ${(scenarioInfo.rate * 100).toFixed(2)}%`
      : '';

    const geom = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial();
    mesh = new THREE.InstancedMesh(geom, mat, rows * cols);

    const dummy = new THREE.Object3D();
    const colorBuf = new Float32Array(rows * cols * 3);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const idx = i * cols + j;
        // Three.js coordinate origin is bottom-left. We want price on Y
        // such that high prices are at the top of the canvas.
        dummy.position.set(j, i, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);

        const c = pnlToColor(pnl_grid[idx], scale);
        colorBuf[idx * 3 + 0] = c.r;
        colorBuf[idx * 3 + 1] = c.g;
        colorBuf[idx * 3 + 2] = c.b;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colorBuf, 3);
    scene.add(mesh);

    resize();
    renderer.render(scene, camera);
    repaintAxes();
    repaintValueLayer();

    // Hover handler
    canvasWrap.onmousemove = (ev) => {
      const r = canvasWrap.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      const j = Math.floor(x * cols);
      const i = rows - 1 - Math.floor(y * rows); // top is high price
      if (i < 0 || i >= rows || j < 0 || j >= cols) {
        tip.style.display = 'none';
        return;
      }
      const v = pnl_grid[i * cols + j];
      const sign = v >= 0 ? '+' : '-';
      const cls = v >= 0 ? 'pos' : 'neg';
      const pct = scenarioInfo.spot
        ? ((data.price_axis[i] / scenarioInfo.spot - 1) * 100)
        : null;
      const pctTxt = pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
      tip.className = `heatmap-tooltip ${cls}`;
      tip.style.display = 'block';
      // Position relative to the panel container (offsetParent)
      tip.style.left = `${ev.clientX - container.getBoundingClientRect().left + 14}px`;
      tip.style.top  = `${ev.clientY - container.getBoundingClientRect().top  + 14}px`;
      tip.innerHTML = `
        <strong>${sign}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong><br>
        Spot: $${data.price_axis[i].toFixed(2)}${pctTxt}<br>
        Day: +${data.day_axis[j].toFixed(0)}<br>
        Vol: ${scenarioInfo.vol != null ? (scenarioInfo.vol * 100).toFixed(1) + '%' : '—'}
      `;
    };
    canvasWrap.onmouseleave = () => { tip.style.display = 'none'; };
  }

  function repaintAxes() {
    if (!lastData) return;
    const { rows, cols, price_axis, day_axis } = lastData;
    const cw = canvasWrap.clientWidth;
    const ch = canvasWrap.clientHeight;
    if (!cw || !ch) return;

    // Y ticks: pick ~7 evenly-spaced row indices
    const nY = Math.min(7, rows);
    const yEls = [];
    for (let k = 0; k < nY; k++) {
      const i = Math.round((rows - 1) * k / (nY - 1));
      const yPx = ((rows - 1 - i) / Math.max(1, rows - 1)) * (ch - ch / rows);
      const price = price_axis[i];
      const pct = scenarioInfo.spot ? ((price / scenarioInfo.spot - 1) * 100) : null;
      const pctTxt = pct == null ? '' : (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
      yEls.push(`
        <div style="position:absolute; left:8px; right:4px; top:${yPx}px;
                    transform: translateY(-50%);
                    font-family: var(--mono); font-size: 10.5px;
                    color: var(--text-2); text-align: right;">
          <div>$${price.toFixed(2)}</div>
          <div style="color: var(--text-mute); font-size: 9.5px">${pctTxt}</div>
        </div>
      `);
    }
    yAxis.innerHTML = yEls.join('');

    // X ticks: pick ~6 evenly-spaced col indices
    const nX = Math.min(6, cols);
    const xEls = [];
    for (let k = 0; k < nX; k++) {
      const j = Math.round((cols - 1) * k / (nX - 1));
      const xPx = (j / Math.max(1, cols - 1)) * (cw - cw / cols);
      const day = day_axis[j];
      const isHorizon = (k === nX - 1);
      const lbl = isHorizon
        ? `<div style="font-weight:600; color:var(--slate-purple);">+${day.toFixed(0)}d horizon</div>`
        : `<div>+${day.toFixed(0)}d</div>`;
      xEls.push(`
        <div style="position:absolute; top:6px; left:${xPx}px;
                    transform: translateX(-50%);
                    font-family: var(--mono); font-size: 10.5px;
                    color: var(--text-2); text-align: center;
                    white-space: nowrap;">
          ${lbl}
        </div>
      `);
    }
    xAxis.innerHTML = xEls.join('');
  }

  function repaintValueLayer() {
    // Remove old layer
    if (valueLayer) valueLayer.remove();
    valueLayer = null;

    if (!lastData) return;
    const { rows, cols, pnl_grid } = lastData;

    const cw = canvasWrap.clientWidth;
    const ch = canvasWrap.clientHeight;
    if (!cw || !ch) return;

    const cellW = cw / cols;
    const cellH = ch / rows;

    // Only show numeric values when cells are big enough to read
    const showValues = cellW >= 36 && cellH >= 22;
    if (!showValues) return;

    valueLayer = document.createElement('div');
    valueLayer.style.cssText = `
      position: absolute; inset: 0; pointer-events: none;
      font-family: var(--mono); font-size: 10px; color: var(--text);
    `;
    let html = '';
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const v = pnl_grid[i * cols + j];
        const xPx = j * cellW;
        const yPx = (rows - 1 - i) * cellH;  // top = high price
        // Pick text color for legibility on the colored background
        const isStrong = Math.abs(v) > 0.6 * Math.max(Math.abs(lastData.max_profit), Math.abs(lastData.max_loss));
        const color = isStrong ? '#1A2330' : 'rgba(26,35,48,0.7)';
        const sign = v >= 0 ? '+' : '-';
        const txt = `${sign}$${Math.abs(v) >= 1000
                     ? (Math.round(Math.abs(v) / 100) / 10).toFixed(1) + 'k'
                     : Math.round(Math.abs(v))}`;
        html += `<div style="position:absolute; left:${xPx}px; top:${yPx}px;
                              width:${cellW}px; height:${cellH}px;
                              display:flex; align-items:center; justify-content:center;
                              color:${color};">${txt}</div>`;
      }
    }
    valueLayer.innerHTML = html;
    canvasWrap.appendChild(valueLayer);
  }

  function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  function fmtMoneyShort(v) {
    if (v == null || !isFinite(v)) return '—';
    if (Math.abs(v) >= 1000) return (v >= 0 ? '+' : '-') + '$' + (Math.round(Math.abs(v) / 100) / 10) + 'k';
    return (v >= 0 ? '+' : '-') + '$' + Math.round(Math.abs(v));
  }

  return {
    update,
    dispose() {
      dispose();
      ro.disconnect();
      renderer.dispose();
      container.innerHTML = '';
    },
  };
}
