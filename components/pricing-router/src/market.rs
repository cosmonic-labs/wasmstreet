// market.rs — chain enrichment.
//
// /chain calls the imported wasmstreet:pricing/quote.get_chain via the
// market-data component, then runs each contract through Black-Scholes
// (in-Rust) to fill `theoretical_price` and `market_to_theo_ratio`. The
// browser only sorts and filters what's already there.
//
// Keeping BS in-Rust here is a deliberate optimization: the chain has up
// to ~60 contracts; calling the wasm BS pricer per row would mean 60
// import-boundary crossings, which is wasteful. The pricer-black-scholes
// component is still the source of truth, used by /price and indirectly
// by the strategy-grid component.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct EnrichedContract {
    pub strike: f64,
    pub bid: f64,
    pub ask: f64,
    pub last: f64,
    pub mid: f64,
    pub iv: f64,
    pub volume: u32,
    pub open_interest: u32,
    pub expiration: String,
    pub days_to_exp: f64,

    // Server-computed enrichment
    pub theoretical_price: f64,
    pub market_to_theo_ratio: f64,
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,
    pub rho: f64,
}

#[derive(Debug, Serialize)]
pub struct EnrichedChain {
    pub ticker: String,
    pub name: String,
    pub spot: f64,
    pub day_change: f64,
    pub day_change_pct: f64,
    pub rate: f64,
    pub as_of: String,
    pub source: String,
    pub expirations: Vec<ExpiryEntry>,
    pub calls: Vec<EnrichedContract>,
    pub puts: Vec<EnrichedContract>,
}

#[derive(Debug, Serialize)]
pub struct ExpiryEntry {
    pub date: String,
    pub days: f64,
}

#[derive(Debug, Serialize)]
pub struct StockJson {
    pub ticker: String,
    pub name: String,
    pub spot: f64,
    pub day_change: f64,
    pub day_change_pct: f64,
    pub as_of: String,
    pub source: String,
}

// --- BS helpers (mirror of black_scholes.h, in Rust, with Greeks) ----------

#[derive(Debug, Clone, Copy)]
pub struct BsResult {
    pub call: f64,
    pub put: f64,
    pub delta: f64,   // call delta
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,   // call theta
    pub rho: f64,
}

pub fn bs_full(spot: f64, strike: f64, sigma: f64, rate: f64, time: f64) -> BsResult {
    if time <= 0.0 || sigma <= 0.0 || spot <= 0.0 || strike <= 0.0 {
        return BsResult {
            call: (spot - strike).max(0.0),
            put: (strike - spot).max(0.0),
            delta: 0.0, gamma: 0.0, vega: 0.0, theta: 0.0, rho: 0.0,
        };
    }
    let sqrt_t = time.sqrt();
    let d1 = ((spot / strike).ln() + (rate + 0.5 * sigma * sigma) * time) / (sigma * sqrt_t);
    let d2 = d1 - sigma * sqrt_t;
    let nd1 = norm_cdf(d1);
    let nd2 = norm_cdf(d2);
    let nmd1 = norm_cdf(-d1);
    let nmd2 = norm_cdf(-d2);
    let pdf = norm_pdf(d1);
    let disc = (-rate * time).exp();

    let call = spot * nd1 - strike * disc * nd2;
    let put  = strike * disc * nmd2 - spot * nmd1;
    let delta = nd1;
    let gamma = pdf / (spot * sigma * sqrt_t);
    let vega  = spot * pdf * sqrt_t;
    let theta = -(spot * pdf * sigma) / (2.0 * sqrt_t) - rate * strike * disc * nd2;
    let rho   = strike * time * disc * nd2;
    BsResult { call, put, delta, gamma, vega, theta, rho }
}

fn norm_cdf(x: f64) -> f64 {
    let (a1, a2, a3, a4, a5, p) = (0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429, 0.3275911);
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let ax = x.abs() / std::f64::consts::SQRT_2;
    let t = 1.0 / (1.0 + p * ax);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * (-ax * ax).exp();
    0.5 * (1.0 + sign * y)
}

fn norm_pdf(x: f64) -> f64 {
    const INV_SQRT_2PI: f64 = 0.3989422804014327;
    INV_SQRT_2PI * (-0.5 * x * x).exp()
}
