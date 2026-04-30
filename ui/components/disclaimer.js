// disclaimer.js — modal shown on every page load.
//
// Communicates that the site is a proof-of-concept demo using free data,
// shouldn't be relied on for accuracy, and isn't financial advice. Returns
// a Promise that resolves when the user dismisses, so the boot sequence
// can chain the tour after.

export function showDisclaimer() {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.id = 'disclaimer-backdrop';
    backdrop.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      background: rgba(20, 30, 50, 0.55);
      display: flex; align-items: center; justify-content: center;
      opacity: 0;
      transition: opacity 180ms ease;
    `;

    const modal = document.createElement('div');
    modal.id = 'disclaimer-modal';
    modal.style.cssText = `
      background: white;
      border-radius: 12px;
      box-shadow: 0 24px 60px rgba(20,30,50,0.30);
      width: 460px;
      max-width: calc(100vw - 32px);
      padding: 28px 28px 24px;
      font-family: 'Inter', system-ui, sans-serif;
      color: #1A2330;
      transform: translateY(8px);
      opacity: 0;
      transition: transform 200ms ease, opacity 200ms ease;
    `;

    modal.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
        <div style="
          width: 38px; height: 38px;
          border-radius: 9px;
          background: #FFF1D6;
          color: #B07408;
          display: flex; align-items: center; justify-content: center;
          font-size: 22px; font-weight: 700; line-height: 1;">!</div>
        <div>
          <div style="font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:#8893A4; font-weight:600;">
            Demo only
          </div>
          <h2 style="margin:0; font-size:18px; font-weight:600;">
            Not financial advice
          </h2>
        </div>
      </div>

      <p style="margin: 0 0 12px; color:#4A5566; line-height:1.55; font-size:13.5px;">
        WasmStreet is a <strong>proof-of-concept demonstration</strong> of WebAssembly
        Components running on wasmCloud v2.
      </p>

      <ul style="margin: 0 0 18px; padding-left: 20px; color:#4A5566; line-height:1.55; font-size:13px;">
        <li>Spot prices are pulled live from Yahoo&rsquo;s public chart endpoint
            on a best-effort basis; option chains are <em>synthesized</em>
            around that spot using a model.</li>
        <li>Theoretical prices, Greeks, and P&amp;L scenarios use closed-form
            Black-Scholes assumptions that diverge from real markets.</li>
        <li>Numbers may be wrong, stale, or misleading. <strong>Do not make
            real trading decisions based on anything you see here.</strong></li>
        <li>The point is to show how WASI 0.2 components composed by
            wasmCloud handle real numerical workloads. Not to manage money.</li>
      </ul>

      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:8px; border-top: 1px solid #DDE4EC;">
        <span style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-size:11px; color:#8893A4;">
          Press <kbd style="background:#F1F4F8; border:1px solid #DDE4EC; padding:1px 6px; border-radius:4px; font-family:inherit;">Esc</kbd> or click below
        </span>
        <button id="disclaimer-dismiss" style="
          background: #685BC7;
          color: white;
          border: none;
          border-radius: 7px;
          padding: 10px 22px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          letter-spacing: 0.2px;
          font-family: inherit;
        ">I understand &middot; show me the demo</button>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Animate in
    requestAnimationFrame(() => {
      backdrop.style.opacity = '1';
      modal.style.opacity = '1';
      modal.style.transform = 'translateY(0)';
    });

    function dismiss() {
      backdrop.style.opacity = '0';
      modal.style.opacity = '0';
      modal.style.transform = 'translateY(8px)';
      document.removeEventListener('keydown', onKey);
      setTimeout(() => {
        backdrop.remove();
        resolve();
      }, 200);
    }

    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Enter') dismiss();
    }

    modal.querySelector('#disclaimer-dismiss').addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);

    // Focus the button so Enter/Space dismiss
    setTimeout(() => modal.querySelector('#disclaimer-dismiss').focus(), 100);
  });
}
