// ticker-search — exports wasmstreet:pricing/tickers.search.
//
// Hybrid autocomplete:
//   1. Local prefix → substring → name-contains over the baked SEC universe
//      (~10 357 US-listed equities, ≤1 ms).
//   2. If local returns no symbol matches AND query length ≥ 2, fall through
//      to Yahoo's /v1/finance/search endpoint via wasi:http/outgoing-handler
//      to pick up foreign tickers, ADRs, OTC, etc.
//   3. Yahoo responses are cached in-memory for 60 s per query.

pub mod search;
pub mod sec_data;
pub mod yahoo;

#[cfg(target_arch = "wasm32")]
mod wasm_guest;
