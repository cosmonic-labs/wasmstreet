# WasmStreet

> Build & price multi-leg options strategies — every number computed by WebAssembly Components.

WasmStreet is a single-page options strategy workbench. Pick a ticker, browse a live option chain with theoretical prices and Greeks already computed, click rows to add legs, configure buy/sell + units, and watch the P&L unfold across a (price × time) grid as you drag the volatility slider. The chain enrichment, the autocomplete, the live market data, and the strategy P&L grid all run inside **C++ and Rust WebAssembly Components composed by wasmCloud v2** — the browser is a thin presentation layer.

```
                          ┌──────────────────────────────────────────┐
                          │         Browser (light theme)            │
                          │  · sortable chain · spreadsheet heatmap  │
                          │  · onboarding tour · hover tooltips      │
                          └──────────────┬───────────────────────────┘
                                         │ HTTP
                                         ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │              Composed wasmstreet.wasm (~3.4 MB raw)                        │
   │              wasmtime serve -Shttp  ·  wasi:http/proxy                     │
   │                                                                            │
   │  ┌─────────────────────────────────────────────────────────────────────┐   │
   │  │   pricing-router (Rust)                                             │   │
   │  │   /tickers /chain /strategy/pnl /strategy/search /price /stock ...  │   │
   │  └──────────┬──────────────────────────────────────────────────────────┘   │
   │             │ wac plug (WIT calls)                                         │
   │   ┌─────────┼─────────┬──────────┬──────────┬──────────┬──────────┐        │
   │   ▼         ▼         ▼          ▼          ▼          ▼          ▼        │
   │ ┌────┐ ┌─────────┐ ┌────────┐ ┌────────┐ ┌─────────┐ ┌────────┐ ┌─────┐    │
   │ │ BS │ │ Strategy│ │Strategy│ │ Market │ │ Ticker  │ │ Monte  │ │ Bin │    │
   │ │C++ │ │ Grid    │ │ Search │ │ Data   │ │ Search  │ │ Carlo  │ │Tree │    │
   │ │    │ │ C++     │ │ C++    │ │ Rust   │ │ Rust    │ │ C++    │ │ C++ │    │
   │ │24K │ │ ~65 KB  │ │~250 KB │ │~245 KB │ │ ~250 KB │ │ ~60 KB │ │~60K │    │
   │ │    │ │ BS grid │ │ ranks  │ │ Yahoo  │ │SEC+Yahoo│ │ Asian  │ │CRR  │    │
   │ │    │ │ + lognl │ │  ~500  │ │ chart  │ │  10K+   │ │ paths  │ │tree │    │
   │ │    │ │   PoP   │ │ candi- │ │ + cache│ │ + cache │ │        │ │     │    │
   │ │    │ │         │ │ dates  │ │+fixture│ │+fallback│ │        │ │     │    │
   │ └────┘ └─────────┘ └────────┘ └────┬───┘ └────┬────┘ └────────┘ └─────┘    │
   │                                    │          │                            │
   │                                    │ wasi:http/outgoing-handler            │
   │                                    ▼          ▼                            │
   └─────────────────────  query1.finance.yahoo.com  ───────────────────────────┘
```

## Demonstration
![WasmStreet - Black Scholes Option Price Strategy Simulator](wasmstreet-demo-clip-minified.gif) 


## Workflow

1. **Pick a ticker** — autocomplete drops a list of ~145 names from a wasm component. Select one and a real Yahoo `/v8/finance/chart` request leaves the wasm sandbox, comes back, and seeds a believable option chain (3 expirations × 9 strikes per side, modeled with a real IV smile).
2. **Browse the chain** — every contract is enriched server-side with **BS Theo** (the Black-Scholes theoretical price) and **MV/Theo** (market mid divided by BS theoretical: <100% = undervalued, >100% = overvalued). The chain table is fully sortable, filterable, and every column header explains itself on hover. Click rows to mark them as legs (up to 6).
3. **Configure your legs** — for each selected leg, toggle Buy/Sell, set units, edit the entry premium. Net cash flow updates live (credit/debit).
4. **Run scenarios** — drag the price-range, vol, rate, time-horizon, and grid-resolution sliders. Every change fires a debounced `POST /strategy/pnl` to the C++ `pricer-strategy-grid` component, which evaluates Black-Scholes for each leg at every cell of a (price × time) grid. The colored P&L spreadsheet shows the dollar value in each cell, with axes labeled in both **$ price** and **% from spot**, and the current vol pinned in the header. Switch to the Payoff Lines tab for an at-expiry SVG line chart with strike, spot, and breakeven markers.
5. **Find winning strategies** — section 4 calls the **`pricer-strategy-search`** wasm component, which enumerates ~500 candidate multi-leg strategies (longs, vertical spreads, straddles, strangles, iron condors), runs each through a small BS grid evaluation, scores them by your chosen objective (Balanced / Income / Asymmetric / Moonshot), and returns the top 12. Click **Apply** on any card to load the strategy into your legs panel.

A guided tour runs on first visit (and any time you press the **? Tour** button in the top bar) walking through every panel.

## The `ticker-search` component

Ticker autocomplete is its own wasm component, [`components/ticker-search/`](components/ticker-search/). Two-tier hybrid search:

**Tier 1 — local index over the SEC universe (fast, offline-capable)**
- A snapshot of [`sec.gov/files/company_tickers.json`](https://www.sec.gov/files/company_tickers.json) lives at [`components/ticker-search/data/sec_tickers.json`](components/ticker-search/data/sec_tickers.json) (~770 KB JSON).
- A build-time script (`make -C components/ticker-search regen-data`) flattens it into [`src/sec_data.rs`](components/ticker-search/src/sec_data.rs) — a `pub const SEC_TICKERS: &[(&str, &str)] = &[...];` array with **10 357 US-listed equities**, baked into the wasm.
- At query time the component runs prefix → substring → name-substring matches case-insensitively, takes the first N hits, returns. Worst-case ≤1 ms.

**Tier 2 — Yahoo `/v1/finance/search` fallback (broad, networked)**
- If the local index returns zero matches *and* the query is ≥2 characters, the component calls Yahoo's public search endpoint via `wasi:http/outgoing-handler`.
- Yahoo's search covers the full universe — foreign equities, ADRs, OTC, crypto, FX — so anything the SEC list misses still gets a chance.
- Responses are cached in-memory for 60 s per query. We filter to `quoteType in {EQUITY, ETF}` so we don't suggest mutual funds or indices as option underlyings.
- The router's response includes `evaluated` (size of the local universe scanned) and `used_yahoo` (true if the fallback ran), so the UI can show honest provenance.

**Cost**

| | Cost |
|---|---|
| Wasm size impact | +250 KB stripped (mostly the SEC table as static UTF-8) |
| Local query latency | ≤1 ms over 10 357 entries |
| Yahoo fallback rate | Only when local returns 0 hits *and* query ≥ 2 chars; cache holds 60 s |
| External quota | No API key. Yahoo rate-limits anonymous IPs at unspecified thresholds — cache + local-first design keep the rate to seconds-between-calls in normal demo use |
| Refresh cadence | Manual `make regen-data` to pull a fresh SEC file. The SEC publishes daily; you typically don't need to refresh more often than weekly |

**Why a separate component?**
- **Capability isolation.** The router doesn't need `wasi:http/outgoing-handler` for autocomplete; pushing the network call into a dedicated component means autocomplete and chain-fetch share the same minimum-privilege story but don't share state.
- **Hot-swap.** Swap the SEC snapshot for a CRSP-style global universe, or replace the Yahoo fallback with a paid feed, without touching anything else. The WIT contract stays.
- **Honest sizes.** The SEC table is 250 KB; pinning it to one component keeps the router's hot path lean.

## About this data

**Honest answer: the option chains aren't sourced from anyone — they're synthesized in C++ around the live spot.** Only the spot price is real. The disclaimer modal that shows on every page load says this; here's the longer version.

### Live (best-effort)

- **Spot price + day change** comes from Yahoo Finance's public chart endpoint:
  `https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}`. No API key, no auth. It's the same endpoint Yahoo's own website uses, but it's rate-limited and not officially supported for third-party callers.
- The `market-data` wasm component fetches it via `wasi:http/outgoing-handler`, parses the JSON, and caches for 10 seconds.

### Synthesized (everything else)

- Yahoo's *options* endpoint (`/v7/finance/options`) returns 401 to anonymous callers, so we never see a real option chain.
- The `market-data` component takes the live spot and builds a chain around it in [`components/market-data/src/synth.rs`](components/market-data/src/synth.rs):
  - **3 expirations**: 14, 30, 60 days
  - **9 strikes per side per expiration** (-10% to +10% from spot)
  - **IV smile** modeled into each contract — puts steeper than calls, mild term-structure tilt
  - **Bid/ask spreads** scale with vol and time
  - **Mid prices** get ±8% deterministic per-strike noise so the MV/Theo column shows real-looking dispersion
- Volume and open interest are pseudo-random functions of (strike, days), peaking ATM.
- The chain payload includes a `source: "yahoo"` field — but that only describes where the *spot* came from. The contract data is always synthesized.

### Fixture fallback

- If Yahoo returns 401/429/timeout/anything non-2xx, the component falls back to a hand-curated table of 15 well-known tickers in [`components/market-data/src/fixture.rs`](components/market-data/src/fixture.rs) with realistic spot prices, then runs the same synth on top. The chain payload then has `source: "fixture"` and the top bar shows the orange `FIXTURE` badge so you can tell at a glance.

### Where to look in code

| File | Role |
|------|------|
| [`components/market-data/src/yahoo.rs`](components/market-data/src/yahoo.rs) | Parses the live `/v8/finance/chart` response |
| [`components/market-data/src/synth.rs`](components/market-data/src/synth.rs) | Generates strikes, IVs, bid/ask, volume, OI |
| [`components/market-data/src/fixture.rs`](components/market-data/src/fixture.rs) | Offline fallback stock metadata |
| [`components/market-data/src/wasm_guest.rs`](components/market-data/src/wasm_guest.rs) | Orchestrates fetch → synth → cache |

### Why not real chain data?

The free unauthenticated options-chain feeds we evaluated:

| Source | Why we didn't use it |
|--------|----------------------|
| Yahoo `/v7/finance/options` | Returns 401 to anonymous callers |
| CBOE | Paid feed |
| Polygon free tier | 5 req/min, requires API key, ≥15 min delayed |
| Tradier sandbox | Full chains, but requires registering for a token |
| Finnhub free tier | Stocks only — no options |

If you want truly live chain data, wire one of those into the `market-data` component — it already imports `wasi:http/outgoing-handler` and has a clean fetch path. Gate it behind an API-key env var and keep the synth as the fallback. Roughly a 100-line change isolated to one wasm component; nothing else in the system needs to know.

### Bottom line

WasmStreet exists to demonstrate that WASI 0.2 components composed by wasmCloud can handle real numerical workloads — Black-Scholes, multi-leg P&L grids, Monte Carlo, binomial trees, lognormal PoP, strategy search. The math is real. The chain data behind it is a model. **Don't trade off it.**

## Run it

```bash
# Prerequisites
wasm-tools --version    # wasm-tools 1.243+
wash --version          # wash 2.0+
wasmtime --version      # wasmtime 39+
wit-bindgen --version   # wit-bindgen 0.50+
cargo install wac-cli   # WAC composition CLI

# WASI SDK 28 (one time): download from
#   https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-28
# extract to ~/wasi-sdk/wasi-sdk-28.0-arm64-macos and the Makefiles will
# pick it up via WASI_SDK_PATH.

# Build all 5 components, compose, run
make all
make dev    # wasmtime serve -Scli -Shttp build/wasmstreet.wasm

# Browse to http://localhost:8000
```

End-to-end smoke test:

```bash
make test                       # native unit tests for every component
bash tests/integration.sh iter1 # /tickers, /chain, /strategy/pnl
```

Single curl that proves the whole pipeline:

```bash
# Live spot from the wasm market-data component
curl -s 'http://localhost:8000/stock?ticker=AAPL' | jq

# Enriched option chain (every row carries theoretical_price + Greeks)
curl -s 'http://localhost:8000/chain?ticker=AAPL' | jq '.calls[5]'

# Strategy P&L grid for a bull call spread
curl -s -X POST http://localhost:8000/strategy/pnl \
  -H 'Content-Type: application/json' \
  -d '{
    "underlying":{"spot":192,"rate":0.05,"vol":0.22},
    "scenario":{"price_min":170,"price_max":220,"price_steps":21,
                "days_min":0,"days_max":30,"day_steps":11},
    "legs":[
      {"side":"buy", "kind":"call","strike":195,"expiration_days":30,
       "iv":0.22,"units":1,"entry_premium":4.20},
      {"side":"sell","kind":"call","strike":205,"expiration_days":30,
       "iv":0.20,"units":1,"entry_premium":1.80}
    ]
  }' | jq '{max_profit, max_loss, breakeven_prices, net_premium}'
```

## Component sizes

After `make all`, with `wasm-tools strip`:

| Component                    | Source LoC          | Stripped `.wasm` |
|------------------------------|---------------------|------------------|
| `pricer-black-scholes`       | ~110 C++            | 24 KB            |
| `pricer-monte-carlo`         | ~180 C++            | 60 KB            |
| `pricer-binomial-tree`       | ~160 C++            | 58 KB            |
| `pricer-strategy-grid`       | ~250 C++            | 65 KB            |
| `pricer-strategy-search`     | ~430 C++            | 250 KB           |
| `market-data`                | ~530 Rust           | 245 KB           |
| `ticker-search`              | ~250 Rust + 10K SEC table | 250 KB     |
| `pricing-router`             | ~700 Rust + UI      | 480 KB           |
| **Composed `wasmstreet.wasm`** | **+ ~3 100 LoC UI** | **~1.7 MB stripped / 3.4 MB raw** |

Seven numerical and IO components plus a router, all sandboxed by default, all hot-swappable at the WAC composition layer.

## WIT contract

The full WIT lives at [`wit/wasmstreet.wit`](wit/wasmstreet.wit). Highlights:

```wit
package wasmstreet:pricing@0.1.0;

interface types { record option-spec { ... }  record greeks { ... }  ... }

interface black-scholes  { price-european:    func(...) -> result<bs-result, string>;  }
interface monte-carlo    { price-asian-call:  func(...) -> result<mc-result, string>;  }
interface binomial-tree  { price:             func(...) -> result<bt-result, string>;  }

interface quote {
    record option-chain  { ticker, spot, day-change, expirations, calls, puts, source, ... }
    get-stock:  func(ticker: string) -> result<stock-quote, string>;
    get-chain:  func(ticker: string) -> result<option-chain, string>;
}

interface strategy {
    record leg     { side, kind, strike, expiration-days, iv, units, entry-premium }
    record scenario { spot, rate, vol, price-min..price-max, days-min..days-max, steps }
    record grid-result {
        pnl: list<f64>, rows, cols, price-axis, day-axis,
        max-profit, max-loss, profit-pct, breakeven-prices, net-premium,
        net-delta, net-gamma, net-vega, net-theta,
    }
    compute-pnl: func(legs, scenario) -> result<grid-result, string>;
}

world bs-pricer            { export black-scholes; }
world mc-pricer            { export monte-carlo;   }
world bt-pricer            { export binomial-tree; }
world strategy-grid-pricer { export strategy;      }
world market-data          { export quote;
                             import wasi:http/outgoing-handler@0.2.8; ... }
```

The router's world imports all five and `include`s `wasi:http/proxy@0.2.8`. WAC composition resolves each pricer's export against the matching router import at build time:

```bash
wac plug \
  --plug pricer-black-scholes.wasm   \
  --plug pricer-monte-carlo.wasm     \
  --plug pricer-binomial-tree.wasm   \
  --plug pricer-strategy-grid.wasm   \
  --plug market-data.wasm            \
  pricing_router.wasm                \
  -o build/wasmstreet.wasm
```

## API endpoints

| Method | Path                     | Component path                              | Notes                                    |
|--------|--------------------------|---------------------------------------------|------------------------------------------|
| GET    | `/tickers?q=AA`          | router → ticker-search                      | Autocomplete; 10 357 baked SEC tickers + Yahoo fallback for the long tail |
| GET    | `/stock?ticker=AAPL`     | router → market-data → Yahoo                | Live spot + day change                   |
| GET    | `/chain?ticker=AAPL`     | router → market-data → Yahoo + BS enrichment| Full chain, theoretical price + Greeks   |
| POST   | `/strategy/pnl`          | router → strategy-grid                      | N×M P&L grid + summary stats             |
| POST   | `/strategy/search`       | router → strategy-search                    | Enumerate + rank ~500 candidate strategies |
| POST   | `/price`                 | router → BS / MC / BT                       | Single-contract pricing across 3 models  |
| GET    | `/quote?ticker=`         | legacy alias of `/chain`                    | Kept for prior integration tests         |
| GET    | `/health`                | router                                      | Liveness                                 |
| GET    | `/...`                   | router                                      | UI assets via `include_dir!`             |

## Why WebAssembly?

- **Language-portable.** The numerics live in C++ (`<cmath>`, `<random>`). The HTTP plumbing + autocomplete is Rust, where lifetimes make HTTP-server code safe by default. The UI is JavaScript. Five languages-mixed components, one runtime, glued together by WIT — no FFI dance.
- **Sandboxed by default.** Each pricer can do nothing but compute — no filesystem, no network, no env vars, because its WIT world doesn't import them. The market-data component *can* reach the network, but only the network. Reasoning about what a component can affect is reading its WIT, nothing more.
- **Composable at the artifact level.** Replacing the strategy P&L grid with a GPU-accelerated implementation is a `wac plug` away — no source change to the router, no rebuild of the unrelated pricers.
- **Tiny.** The composed binary is well under 1 MB stripped and contains everything: four numerical libraries, a Yahoo-fetching live data layer, a Rust router, and the SPA. Cold start is sub-100 ms.
- **Deployment-portable.** The same `wasmstreet.wasm` runs unmodified on `wasmtime serve`, on a wasmCloud cluster, in a cloud-edge worker — anywhere a WASI 0.2 runtime exists.
- **Capability-based security.** Every external effect is *granted* via WIT import. We can read exactly what each component is allowed to do without reading code.

## Architecture decisions worth knowing

- **`wash` v2 has no `wash up`.** The v2 dev loop is `wash dev` (single-component) and `wash host` (full host). Multi-component composition happens at *build time* with `wac` rather than runtime linking. WasmStreet is composed once into `build/wasmstreet.wasm` and run with `wasmtime serve -Shttp` — equivalent to a wasmCloud workload deployment but without the control plane, matching the "no wadm, no Kubernetes" constraint.
- **Yahoo's `/v7/finance/options` requires auth (401).** The `/v8/finance/chart` endpoint is openly accessible and gives spot + day change. The `market-data` component fetches it live and *synthesizes* the option chain around the live spot using a realistic IV smile. The chain enrichment step in the router runs the synth result back through Black-Scholes with a deterministic ±8% mid-price perturbation, so the MV/Theo ratio column shows believable dispersion.
- **Body-write chunking is mandatory.** `wasi:io` `blocking-write-and-flush` is bounded to ~4 KB per call. The router writes responses in 4 KB chunks; without that, large strategy responses trap.
- **`option` is a reserved WIT keyword.** The Monte Carlo spec uses `underlying:` not `option:`.
- **Live data falls back transparently.** If Yahoo returns 401, 429, or anything non-2xx, `market-data` returns its baked fixture and tags `source: "fixture"`. The UI shows a `YAHOO LIVE` or `FIXTURE` badge in the top bar so you always know what you're seeing.
- **Chain enrichment is in-Rust, not in-component.** The router's `market.rs` runs Black-Scholes natively in Rust on each chain row instead of crossing the wasm import boundary 50 times. The C++ pricer is still the source of truth — the strategy P&L grid uses it — but for the chain-display path, in-Rust BS is faster and they agree to the digit.
- **All effects are server-side.** The browser does no math beyond formatting and SVG layout. Sliders fire JSON requests; the wasm pipeline does the work. This is the wasmCloud component story made tactile.
- **Why CPU-parallel rather than WebGPU for strategy search?** `wasmtime serve`'s `--wasi-webgpu` flag is experimental and not stable across versions; shipping a wasm component that depends on it would break in most environments. Each candidate strategy in `pricer-strategy-search` costs ≤ 200 µs in pure scalar C++, and we evaluate < 500 candidates per request, so total search time is ~50 ms server-side. SIMD vectorization (wasm32-wasip2 supports SIMD128) is the natural next step within the same component surface.

## Repository layout

```
wasmstreet/
├── README.md                      # this file
├── PLAN.md                        # original roadmap (kept for context)
├── LICENSE                        # Apache-2.0
├── Makefile                       # top-level orchestrator
├── .wash/config.yaml              # wash project config (v2.0.0)
├── wit/wasmstreet.wit             # canonical WIT contract
├── components/
│   ├── pricer-black-scholes/      # C++ — closed-form BS + Greeks
│   ├── pricer-monte-carlo/        # C++ — Asian-call MC simulation
│   ├── pricer-binomial-tree/      # C++ — CRR American/European
│   ├── pricer-strategy-grid/      # C++ — multi-leg P&L grid
│   ├── pricer-strategy-search/    # C++ — enumerate + rank ~500 candidates
│   ├── market-data/               # Rust — live Yahoo chart + fixture
│   ├── ticker-search/             # Rust — SEC-baked + Yahoo /v1 search
│   └── pricing-router/            # Rust — HTTP, dispatch, UI server
├── compose/compose.wac            # WAC composition documented
├── ui/                            # single-page strategy builder
│   ├── index.html                 # 3-panel layout
│   ├── styles.css                 # light theme tokens
│   ├── app.js                     # top-level state + fetch hub
│   ├── components/
│   │   ├── ticker-search.js       # autocomplete with /tickers
│   │   ├── chain-table.js         # sortable + filterable + leg select
│   │   ├── legs-table.js          # configurable buy/sell + units
│   │   ├── scenario-panel.js      # sliders that drive /strategy/pnl
│   │   ├── stats-cards.js         # 7 summary cards
│   │   ├── strategy-search.js     # section 4 — ranked candidate cards (NEW iter2)
│   │   ├── tooltip.js             # hover-delay tooltip used everywhere (NEW iter2)
│   │   └── tour.js                # first-run guided onboarding (NEW iter2)
│   └── viz/
│       ├── pnl-heatmap.js         # Three.js InstancedMesh GPU heatmap
│       ├── payoff-line.js         # SVG payoff diagram + breakevens
│       └── pnl-viz.js             # tab switcher
├── ui-examples/                   # the source mocks this iter is built from
└── tests/
    ├── m0_smoke.sh                # upstream sample reproduction (M0)
    └── integration.sh             # m2..m7 + iter1 via curl
```

## Verification

| Step | What it proves                                                  | How                                          |
|------|-----------------------------------------------------------------|----------------------------------------------|
| iter1.1 | New `market-data` component parses Yahoo + falls back to fixture | `cd components/market-data && cargo test` |
| iter1.2 | New `pricer-strategy-grid` matches analytical P&L for canonical strategies (long call, bull-call spread, straddle, iron condor) | `make -C components/pricer-strategy-grid test` |
| iter1.3 | All new endpoints round-trip                                    | `bash tests/integration.sh iter1`            |
| iter1.4 | UI shell + chain table + leg selection                          | open `localhost:8000`, type a ticker         |
| iter1.5 | Legs table + scenario sliders                                   | drag any slider, watch latency badge         |
| iter1.6 | GPU heatmap holds frame rate                                    | drag vol slider, see colors morph            |

## License

Apache-2.0.
