// market-data — exports wasmstreet:market/quote.
//
// get_stock(ticker)  → live spot from Yahoo Finance v8/finance/chart, with
//                       a fixture fallback. 10s in-memory cache.
// get_chain(ticker)  → synthesized chain around the latest spot. 60s cache.
//
// The component never refuses a request; on any error it returns the
// fixture and tags `source: "fixture"` so the UI can show what happened.
//
// Native cargo tests cover the parser + chain synthesizer. The wasm-only
// Guest implementation, HTTP fetch, and clocks live below `wasm_guest`.

pub mod fixture;
pub mod synth;
pub mod yahoo;

#[cfg(target_arch = "wasm32")]
mod wasm_guest;
