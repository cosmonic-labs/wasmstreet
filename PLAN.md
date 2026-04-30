# WasmStreet

> A live options-pricing workbench powered by C++ quant components running on CNCF wasmCloud.

WasmStreet is a demonstration of real, production-grade quantitative finance algorithms compiled to WebAssembly Components in C++ and orchestrated by [wasmCloud](https://wasmcloud.com) v2. The UI looks and feels like a trader's workbench. The fact that it's WebAssembly underneath is invisible to the user — the wow happens when you tell them.

## Architecture

```
                                    ┌──────────────────────────────┐
                                    │   Browser (trader workbench) │
                                    │   Three.js · sliders · grid  │
                                    └──────────────┬───────────────┘
                                                   │ HTTPS
                                                   ▼
                ┌──────────────────────────────────────────────────────┐
                │                     wasmCloud host                   │
                │                  (started with `wash up`)            │
                │                                                      │
                │  ┌────────────────────────────────────────────────┐  │
                │  │   wasi:http  ─────►  pricing-router (Rust)     │  │
                │  │                          │                     │  │
                │  │                          │  WIT calls          │  │
                │  │                          ▼                     │  │
                │  │            ┌──────────────────────────┐        │  │
                │  │            │  pricer-black-scholes    │  C++   │  │
                │  │            │  (closed-form + Greeks)  │  WASI  │  │
                │  │            └──────────────────────────┘        │  │
                │  │            ┌──────────────────────────┐        │  │
                │  │            │  pricer-monte-carlo      │  C++   │  │
                │  │            │  (Asian options)         │  WASI  │  │
                │  │            └──────────────────────────┘        │  │
                │  │            ┌──────────────────────────┐        │  │
                │  │            │  pricer-binomial-tree    │  C++   │  │
                │  │            │  (Cox-Ross-Rubinstein,   │  WASI  │  │
                │  │            │   American options)      │        │  │
                │  │            └──────────────────────────┘        │  │
                │  └────────────────────────────────────────────────┘  │
                │                                                      │
                │  Configured via .wash/config.yaml                    │
                │  (no wadm, no Kubernetes)                            │
                └──────────────────────────────────────────────────────┘
                                                   │
                                                   │ (Milestone 7+)
                                                   ▼
                                          ┌────────────────┐
                                          │  Live market   │
                                          │  data feed     │
                                          │  (e.g. Polygon │
                                          │   or Yahoo)    │
                                          └────────────────┘
```

## Stack constraints

- **wasmCloud v2** only, configured via `.wash/config.yaml`
- **No `wadm`**, no Kubernetes, no Helm — plain `wash up` and component links
- Pricing components are **C++ → WASI 0.2 reactor components** built from the [bytecodealliance/sample-wasi-http-cpp](https://github.com/bytecodealliance/sample-wasi-http-cpp) starter (WASI SDK 28, `wit-bindgen cpp`, `-fno-exceptions`, `-mexec-model=reactor`)
- Router is a small Rust component for clean WIT consumption
- UI is a static SPA (no React framework lock-in needed) styled to look like a real trader workbench

---

## Milestones

The plan is structured to **kill the riskiest unknowns first**. The hard part is not the UI — it's a non-trivial C++ quant library compiled to a WASI 0.2 component and wired through wasmCloud. Everything else is downstream of that working.

### Milestone 0 — Reproduce the upstream sample, unmodified

**Goal:** Get a stock C++ WASI HTTP component running under `wash` before changing a single line.

**Why first:** Validates your toolchain (WASI SDK 28, `wit-bindgen cpp`, `wkg`, `wash` v2) on your machine. Every later milestone assumes this works. Don't skip it.

**Done when:**
- `git clone` of `sample-wasi-http-cpp` builds cleanly
- The resulting `.wasm` runs under `wash up` (not just `wasmtime serve`) and serves `/hello` over HTTP
- `.wash/config.yaml` defines the host and the HTTP link

**Risks to watch:**
- WASI SDK install path issues (`WASI_SDK_PATH`)
- `wit-bindgen` version drift — pin to `0.48.1` or newer per the sample
- `wash` v2 HTTP link config syntax differs from v1 examples; use the v2 docs only

---

### Milestone 1 — One pricing function, end to end, simulated inputs

**Goal:** A single C++ component that exposes `price-european-call(spot, strike, vol, rate, time) -> f64` and returns a Black-Scholes price.

**Why second:** This is the credibility test. Black-Scholes is ~30 lines of C++ with `<cmath>` only — no QuantLib, no Boost, no exceptions. If this doesn't compile to a reactor component, nothing harder will.

**Done when:**
- A new WIT world `wasmstreet:pricing` defines the interface
- `pricer-black-scholes.wasm` implements it in pure C++ (no library deps)
- `curl -X POST localhost:8080/price -d '{"spot":100,"strike":100,"vol":0.2,"rate":0.05,"time":1.0}'` returns ~10.45
- All inputs are simulated/hardcoded in the request — no market data yet

**Risks to watch:**
- `std::expected` / `tl::expected` plumbing for error returns in WIT
- C++20 features available under WASI SDK 28 — `-fno-exceptions` rules out anything throwing
- Floating-point determinism across hosts (matters later for testing)

---

### Milestone 2 — Add the Greeks, then the router

**Goal:** Extend the pricer to return delta, gamma, vega, theta, rho alongside price. Introduce a tiny Rust `pricing-router` component that fronts HTTP and delegates to the pricer over WIT.

**Why now:** The Greeks are closed-form for Black-Scholes — same math, no new infra risk. The router is the seam that lets future milestones swap pricing models without touching the UI. Getting two components composing over WIT in `.wash/config.yaml` is the wasmCloud-specific learning, and it's better to hit it with a working pricer than mid-redesign.

**Done when:**
- WIT now returns a `pricing-result` record with price + 5 Greeks
- The router is a separate `.wasm`, linked to the pricer via `.wash/config.yaml`
- Single HTTP request returns price + Greeks in one JSON payload
- Response time logged and < 5ms locally

---

### Milestone 3 — A second pricing model: Monte Carlo for Asian options

**Goal:** Add `pricer-monte-carlo.wasm` implementing a Monte Carlo simulation for arithmetic Asian options. The router picks the pricer based on the request payload (`"model": "monte-carlo"`).

**Why this algorithm:** Monte Carlo is *visually* beautiful (you can render the simulated paths in milestone 6) and demonstrates real CPU work — 100,000 paths × 252 timesteps is meaningful computation, not a toy. Asian options have no closed form, so the only honest way to price them is simulation, which justifies the complexity to a finance audience.

**Why now in the sequence:** Two components implementing the same WIT interface is the wasmCloud composition story. If swapping models works at the router level, the rest of the demo is just adding more pricers.

**Done when:**
- `pricer-monte-carlo.wasm` exists, separate component, same WIT interface (with model-specific extensions for path data)
- Router dispatches by `model` field
- An API call to `/price?model=monte-carlo` returns a price plus a sample of 50 simulated paths (for later visualization)
- Mersenne Twister or PCG RNG running inside the component (deterministic with a seed)

**Risks to watch:**
- RNG state inside reactor components — make sure each invocation is seeded explicitly, no hidden global state
- Memory: 100k × 252 doubles is ~200MB if you keep them all; design to stream/aggregate

---

### Milestone 4 — Third model: binomial tree (Cox-Ross-Rubinstein) for American options

**Goal:** `pricer-binomial-tree.wasm` for American-exercise options, where early exercise matters and there's no Black-Scholes shortcut.

**Why this algorithm:** Binomial trees are *visually beautiful* (the tree itself is the visualization in milestone 6), they handle American options correctly which BS cannot, and the recursive backward induction is satisfying to watch animate. Three models — closed-form, Monte Carlo, and lattice — span the three families of option pricing techniques. That's the educational arc.

**Done when:**
- Third pricer component, same WIT contract, dispatched by router
- Returns the tree structure (node values) so the UI can render it
- 1000-step tree completes in < 50ms

---

### Milestone 5 — Application shell + minimal but functional UI

**Goal:** A web page with a navigable application shell (left rail of section icons, top bar for context) and the first section — Pricing — wired to the components. Ugly is fine. Functional is required. The shell is designed so future sections drop in without redesign.

**Why now:** Don't polish before the math is solid. The point of this milestone is to make sure every model is callable from a real browser request, that CORS works, that latency is acceptable, and that the data shapes the UI needs are actually emitted by the components. Discover this *before* spending time on Three.js.

**The application shell**

WasmStreet is structured as a Bloomberg-style multi-section workbench. Even though only the Pricing section ships in this milestone, the shell makes room for everything in the roadmap. The left rail holds section icons; the top bar holds global context (selected instrument, market session indicator, latency badge); the main canvas hosts the active section.

Sections (and their icons — all single-color line icons in the rail, lit accent when active):

| Section          | Icon concept                                 | Status   | Purpose                                          |
| ---------------- | -------------------------------------------- | -------- | ------------------------------------------------ |
| **Pricing**      | Greek letter Δ (delta) in a bordered square  | M5 ship  | Live options pricing across three models         |
| **Surface**      | Three concentric curves forming a wireframe  | M6       | Volatility surface explorer (3D)                 |
| **Paths**        | Three diverging stochastic lines from a dot  | M6       | Monte Carlo path bundle viewer                   |
| **Tree**         | Recombining lattice nodes, 3 levels deep     | M6       | Binomial tree visualizer                         |
| **Chain**        | Stacked horizontal bars (option chain rows)  | M7       | Live option chain priced vs. market              |
| **Risk**         | Bell curve with shaded tail                  | future   | Portfolio Greeks aggregation, scenario shocks    |
| **Curves**       | Yield curve silhouette ascending to right    | future   | Bootstrap discount curves from market instruments |
| **Settings**     | Gear with 6 teeth                            | always   | Endpoint config, market data source, theming    |

The icon set should feel like a single hand drew them — uniform 24px viewBox, 1.5px stroke, no fills, sharp corners (no rounded line caps — this is finance, not a wellness app). Glyph for each, rendered as inline SVG so they recolor with the theme.

**Done when:**
- Single HTML page, left rail with all eight section icons, only Pricing is active
- Inactive icons are gainsboro-tinted; active icon glows slate-purple with a subtle accent rule on the rail
- Pricing section: sliders for spot/strike/vol/rate/time, dropdown to select model (Black-Scholes / Monte Carlo / Binomial-Tree)
- Updates fire on slider drag with debouncing
- Greeks displayed as plain numbers in a panel
- One static line chart for payoff
- It works. It is not pretty.

---

### Milestone 6 — Make it beautiful

**Goal:** The UI now looks like a tool a real trading desk would use, with Cosmonic's visual identity.

**Why this milestone exists:** A demo people screenshot and share is worth 100x a demo that "works." But beauty is the polish on top of correctness, not a substitute for it.

**Visual references to study:**
- Bloomberg Terminal's options chain (the dense grid aesthetic)
- TradingView's chart panels (clean dark-mode financial UI)
- thinkorswim's analyze tab (the slider + curve interplay)
- IBKR's Risk Navigator (the Greeks dashboard layout)

**Cosmonic brand palette:**

```css
:root {
  --slate-purple: #685BC7;   /* primary accent — active states, key data */
  --light-gray:   #768692;   /* secondary text, axis labels, inactive icons */
  --yellow:       #FFB600;   /* alerts, P&L emphasis, hover highlights */
  --space-blue:   #002E5D;   /* surface depth — panels recessed into background */
  --gunmetal:     #253746;   /* base surfaces, the canvas tone */
  --gainsboro:    #D9E1E2;   /* primary text, grid lines, borders */
}
```

**Palette application:**
- App background: `--gunmetal` with a subtle vertical gradient toward `--space-blue` at the bottom for atmospheric depth
- Left rail: solid `--space-blue`, slightly darker than the canvas, with a 1px `--slate-purple` divider on the right edge
- Active section icon: `--slate-purple` glyph + a 2px `--slate-purple` accent bar on the left edge of its rail slot
- Inactive section icons: `--light-gray`, lifting to `--gainsboro` on hover
- Top bar: `--space-blue` with `--gainsboro` text; latency badge uses `--yellow` text on a transparent pill
- Data panels: `--gunmetal` surfaces with 1px `--space-blue` borders, soft inset shadow for depth
- Numerics: `--gainsboro` for primary values, `--light-gray` for units and labels
- Positive Greeks / P&L: a clean green `#3FB984` (calibrated to sit cleanly against `--gunmetal`)
- Negative Greeks / P&L: a clean red `#E5484D` (calibrated to match)
- `--yellow` is reserved for highlights, hover states, alerts, and the latency badge — never for value sign
- Slider tracks: `--space-blue` channel, `--slate-purple` fill, `--gainsboro` thumb
- Chart accent lines: `--slate-purple` primary series, `--yellow` for highlighted/selected series

**Typography:**
- Display / brand wordmark: a geometric sans with character — *Söhne*, *General Sans*, or *Neue Haas Grotesk Display* (avoid Inter/Roboto)
- UI labels: the same family at 500 weight, tracked +20
- Numerics: a tabular-figures monospace — *JetBrains Mono*, *IBM Plex Mono*, or *Berkeley Mono* — so digits don't shift width as values update. This is non-negotiable for a trading UI.

**Three.js animations — used surgically, not gratuitously:**
1. **Monte Carlo path bundle** — when the MC pricer runs, render its 50 sample paths as a translucent ribbon fanning out across a 3D plot of price × time. As the slider moves and re-prices, the ribbon morphs. This is *the* screenshot moment.
2. **Binomial tree** — render the recombining tree as 3D nodes with values, with backward-induction propagating color (option value) from leaves to root in a visible pulse on each repricing.
3. **Volatility surface** — for Black-Scholes, render the live 3D surface of option price vs. (strike, time-to-expiry) that deforms as the user drags the volatility slider.

**Layout:** The shell from milestone 5 stays — left rail, top bar, main canvas. The Pricing section's main canvas now becomes a Bloomberg-grid feel: dense, monospace numerics, tight rows. Greeks in their own bordered panel. Model selector as a segmented control, not a dropdown. Latency badge in the top bar showing component round-trip in ms. The Surface, Paths, and Tree sections each get their own dedicated route in the rail rather than living as toggles within Pricing — this is how the shell pays for itself.

**Done when:**
- It looks like something you'd put on the homepage of cosmonic.com
- The three Three.js visualizations work and respond to slider input at 60fps
- A non-technical viewer says "wait, that's running in WebAssembly?" when told

---

### Milestone 7 — Real market data, real quotes

**Goal:** Wire in a live source. The user types a ticker (AAPL, SPY) and WasmStreet pulls the spot price + nearest-the-money option chain, then prices each contract using all three models in parallel.

**Why last:** Live data adds API keys, rate limits, parsing failures, market-hours edge cases, and exchange-holiday weirdness. None of that has anything to do with the wasmCloud or quant story. Get everything else solid first, then add it.

**Approach:**
- Use a free-tier source: Polygon, Finnhub, or Yahoo Finance unofficial endpoints
- Add a `market-data` component (Rust is fine here — IO-heavy, not numerically interesting) that fetches and caches quotes
- The router calls `market-data` to fill in the spot/strike/IV inputs the user previously typed by hand
- Add a "model vs. market" panel: show the WasmStreet-computed price next to the actual mid quote, with the difference highlighted. This is the killer demo moment for finance people — *visible* model-vs-market dispersion.

**Done when:**
- User types `SPY` and sees a live option chain priced by all three models
- Implied volatility solver runs on the binomial component (root-find on observed price → vol)
- Delta-hedge ratio displayed against the live quote

---

## Why this order works

Each milestone closes off a category of risk:

| Milestone | Risk closed |
|-----------|-------------|
| 0 | Toolchain (WASI SDK + wash v2) |
| 1 | C++ → WASI 0.2 reactor with custom WIT |
| 2 | Multi-component composition over WIT in `.wash/config.yaml` |
| 3 | Stateful CPU-bound work inside a component |
| 4 | Third model proves the contract is right, not coincidentally fitted |
| 5 | End-to-end UX path is real |
| 6 | Visual quality |
| 7 | External IO and live data |

If milestone 1 doesn't work, the whole project is in trouble. Better to know on day one than week three.

## Repository layout (target)

```
wasmstreet/
├── README.md
├── .wash/
│   └── config.yaml
├── wit/
│   └── wasmstreet.wit              # shared interface for all pricers
├── components/
│   ├── pricer-black-scholes/       # C++, milestones 1-2
│   ├── pricer-monte-carlo/         # C++, milestone 3
│   ├── pricer-binomial-tree/       # C++, milestone 4
│   ├── pricing-router/             # Rust, milestone 2
│   └── market-data/                # Rust, milestone 7
└── ui/
    ├── index.html
    ├── shell/                      # milestone 5 — the application frame
    │   ├── shell.js                # routing between sections
    │   ├── shell.css               # rail, top bar, canvas grid
    │   └── icons/                  # one SVG per section
    │       ├── pricing.svg
    │       ├── surface.svg
    │       ├── paths.svg
    │       ├── tree.svg
    │       ├── chain.svg
    │       ├── risk.svg
    │       ├── curves.svg
    │       └── settings.svg
    ├── sections/
    │   ├── pricing/                # milestone 5 functional, milestone 6 polished
    │   ├── surface/                # milestone 6
    │   ├── paths/                  # milestone 6
    │   ├── tree/                   # milestone 6
    │   └── chain/                  # milestone 7
    └── viz/                        # Three.js, milestone 6
        ├── monte-carlo-paths.js
        ├── binomial-tree.js
        └── volatility-surface.js
```

## Getting started

```bash
# Prerequisites
wash --version          # >= 2.0.0
wasm32-wasip2-clang++ --version   # WASI SDK 28
wit-bindgen --version   # >= 0.48.1

# Milestone 0
git clone https://github.com/bytecodealliance/sample-wasi-http-cpp
cd sample-wasi-http-cpp
make
wash up                 # uses .wash/config.yaml in this repo
curl http://localhost:8080/hello
```

## License

Apache-2.0 (matching the upstream C++ sample).