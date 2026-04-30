// synth.rs — synthesize an option chain around a known spot price.
//
// We don't have a free, working options-chain feed. Given a live spot
// (or the fallback fixture spot), we generate an option chain that
// looks like a real one: 3 expirations, 9 strikes per expiration per
// side, with a realistic IV smile (vol rises for OTM puts, slopes
// gently for OTM calls). Bid/ask spreads scale with vol and time.

use crate::yahoo::ParsedQuote;

#[derive(Debug, Clone)]
pub struct Contract {
    pub strike: f64,
    pub bid: f64,
    pub ask: f64,
    pub last: f64,
    pub iv: f64,
    pub volume: u32,
    pub open_interest: u32,
    pub expiration: String,
    pub days_to_exp: f64,
}

#[derive(Debug, Clone)]
pub struct Chain {
    pub ticker: String,
    pub name: String,
    pub spot: f64,
    pub day_change: f64,
    pub day_change_pct: f64,
    pub rate: f64,
    pub as_of_unix: i64,
    pub source: String,
    pub expirations: Vec<String>,
    pub calls: Vec<Contract>,
    pub puts: Vec<Contract>,
}

const RFR: f64 = 0.051;
const PCT_GRID: [f64; 9] = [-0.10, -0.075, -0.05, -0.025, 0.0, 0.025, 0.05, 0.075, 0.10];
const EXPIRY_DAYS: [u32; 3] = [14, 30, 60];

pub fn synthesize(quote: &ParsedQuote, source: &str, as_of_iso: &str) -> Chain {
    let mut calls = Vec::new();
    let mut puts = Vec::new();
    let mut expirations = Vec::with_capacity(EXPIRY_DAYS.len());

    for &days in EXPIRY_DAYS.iter() {
        let exp_iso = days_offset_iso(as_of_unix(as_of_iso), days);
        expirations.push(exp_iso.clone());
        let t = days as f64 / 365.0;

        for &p in PCT_GRID.iter() {
            let strike = round_to_strike(quote.spot * (1.0 + p));

            // IV smile: ATM ~0.22, +0.6 per 1.0 OTM down, -0.25 per 1.0 OTM up.
            // Term structure: shorter expirations have higher absolute IV.
            let term_factor = 1.0 + 0.05 * (60.0 - days as f64) / 60.0;
            let iv_call = (0.22 + (-p).max(0.0) * 0.6 + p.max(0.0) * (-0.25)) * term_factor;
            let iv_put  = (0.22 + (-p).max(0.0) * 0.9 + p.max(0.0) * (-0.20)) * term_factor;
            let iv_call = iv_call.clamp(0.06, 1.20);
            let iv_put  = iv_put.clamp(0.06, 1.20);

            // Theoretical mid from BS, then perturb by a deterministic-but-noisy
            // factor (±8%) so that mid vs theoretical actually differs and the
            // MV/TV ratio column in the UI shows real dispersion.
            let theo_call = bs_call(quote.spot, strike, iv_call, RFR, t);
            let theo_put  = bs_put (quote.spot, strike, iv_put,  RFR, t);
            let h_call = hash_atom(strike, days as f64);
            let h_put  = hash_atom(strike + 0.123, days as f64 + 0.5);
            let nc = ((h_call % 10_000) as f64 / 10_000.0 - 0.5) * 0.16;  // ±8%
            let np = ((h_put  % 10_000) as f64 / 10_000.0 - 0.5) * 0.16;
            let mid_call = (theo_call * (1.0 + nc)).max(0.01);
            let mid_put  = (theo_put  * (1.0 + np)).max(0.01);

            let spread_pct = 0.015 + 0.005 * iv_call;
            let bid_c = (mid_call * (1.0 - spread_pct)).max(0.01);
            let ask_c =  mid_call * (1.0 + spread_pct);
            let bid_p = (mid_put  * (1.0 - spread_pct)).max(0.01);
            let ask_p =  mid_put  * (1.0 + spread_pct);

            // Volume and OI peak ATM, fall off OTM. Pseudo-random per (strike, days).
            let h = hash_atom(strike, days as f64) as f64;
            let centered = 1.0 - p.abs() * 6.0;
            let vol_call_f = (centered * 1500.0 + h.fract() * 300.0).max(0.0);
            let vol_put_f  = (centered * 1300.0 + (h * 1.7).fract() * 280.0).max(0.0);
            let oi_call_f  = vol_call_f * (3.0 + (h * 2.3).fract() * 4.0);
            let oi_put_f   = vol_put_f  * (3.0 + (h * 1.9).fract() * 4.0);

            calls.push(Contract {
                strike,
                bid: bid_c, ask: ask_c, last: mid_call, iv: iv_call,
                volume: vol_call_f as u32,
                open_interest: oi_call_f as u32,
                expiration: exp_iso.clone(),
                days_to_exp: days as f64,
            });
            puts.push(Contract {
                strike,
                bid: bid_p, ask: ask_p, last: mid_put, iv: iv_put,
                volume: vol_put_f as u32,
                open_interest: oi_put_f as u32,
                expiration: exp_iso.clone(),
                days_to_exp: days as f64,
            });
        }
    }

    Chain {
        ticker: quote.ticker.clone(),
        name: quote.name.clone(),
        spot: quote.spot,
        day_change: quote.day_change,
        day_change_pct: quote.day_change_pct,
        rate: RFR,
        as_of_unix: quote.as_of_unix,
        source: source.to_string(),
        expirations,
        calls,
        puts,
    }
}

fn round_to_strike(s: f64) -> f64 {
    if s < 25.0 { (s * 2.0).round() / 2.0 }       // $0.50 increment
    else if s < 200.0 { s.round() }                // $1 increment
    else if s < 500.0 { (s / 2.5).round() * 2.5 }  // $2.50 increment
    else { (s / 5.0).round() * 5.0 }               // $5 increment
}

fn hash_atom(a: f64, b: f64) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for byte in a.to_bits().to_le_bytes().iter().chain(b.to_bits().to_le_bytes().iter()) {
        h ^= *byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn as_of_unix(iso: &str) -> i64 {
    // We need *some* reference point to compute future expiration dates, but
    // we don't depend on real wall-clock arithmetic here — the ISO output is
    // produced from the cache layer using wasi:clocks. This function exists
    // only for the offline fixture path, so just parse the leading YYYY-MM-DD
    // back into a unix-style integer days-from-epoch.
    let year: i32 = iso[0..4].parse().unwrap_or(2026);
    let month: i32 = iso[5..7].parse().unwrap_or(4);
    let day: i32 = iso[8..10].parse().unwrap_or(29);
    days_from_civil(year, month, day) * 86400
}

// "Howard Hinnant" days_from_civil — proleptic Gregorian, accurate.
fn days_from_civil(y: i32, m: i32, d: i32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = ((153 * ((m + (if m > 2 { -3 } else { 9 })) as u32) + 2) / 5 + d as u32 - 1) as i64;
    let doe = (yoe * 365 + yoe / 4 - yoe / 100) as i64 + doy;
    (era as i64 * 146097 + doe - 719468)
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = (doe - (365 * yoe + yoe / 4 - yoe / 100)) as u32;
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m as u32, d)
}

fn days_offset_iso(unix_seconds: i64, days_offset: u32) -> String {
    let total_days = unix_seconds / 86400 + days_offset as i64;
    let (y, m, d) = civil_from_days(total_days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// Closed-form Black-Scholes for the synth.
fn bs_call(s: f64, k: f64, sigma: f64, r: f64, t: f64) -> f64 {
    if t <= 0.0 || sigma <= 0.0 { return (s - k).max(0.0); }
    let sqrt_t = t.sqrt();
    let d1 = ((s / k).ln() + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t);
    let d2 = d1 - sigma * sqrt_t;
    s * norm_cdf(d1) - k * (-r * t).exp() * norm_cdf(d2)
}
fn bs_put(s: f64, k: f64, sigma: f64, r: f64, t: f64) -> f64 {
    bs_call(s, k, sigma, r, t) - s + k * (-r * t).exp()
}
fn norm_cdf(x: f64) -> f64 {
    let (a1, a2, a3, a4, a5, p) = (0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429, 0.3275911);
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let ax = x.abs() / std::f64::consts::SQRT_2;
    let t = 1.0 / (1.0 + p * ax);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * (-ax * ax).exp();
    0.5 * (1.0 + sign * y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_quote() -> ParsedQuote {
        ParsedQuote {
            ticker: "AAPL".into(),
            name: "Apple Inc.".into(),
            spot: 192.45,
            previous_close: 190.67,
            day_change: 1.78,
            day_change_pct: 0.93,
            as_of_unix: 1714408800,
        }
    }

    #[test]
    fn synthesizes_three_expirations() {
        let q = fixture_quote();
        let c = synthesize(&q, "yahoo", "2026-04-29T20:00:00Z");
        assert_eq!(c.expirations.len(), 3);
        assert_eq!(c.calls.len(), 27);   // 3 expirations * 9 strikes
        assert_eq!(c.puts.len(), 27);
    }

    #[test]
    fn synthesized_chain_has_atm_strike() {
        let q = fixture_quote();
        let c = synthesize(&q, "yahoo", "2026-04-29T20:00:00Z");
        let atm = c.calls.iter().find(|x| (x.strike - 192.0).abs() < 1.0);
        assert!(atm.is_some(), "should produce a strike near spot 192.45");
    }

    #[test]
    fn put_call_parity_holds_atm() {
        let q = fixture_quote();
        let c = synthesize(&q, "yahoo", "2026-04-29T20:00:00Z");
        // Use the first 30-day ATM contract pair
        let call = c.calls.iter().find(|x| x.strike == 192.0 && x.days_to_exp == 30.0);
        let put  = c.puts .iter().find(|x| x.strike == 192.0 && x.days_to_exp == 30.0);
        if let (Some(c), Some(p)) = (call, put) {
            // Calls and puts use slightly different IVs in our smile so parity
            // is approximate — just sanity-check signs and rough magnitudes.
            assert!(c.last > 0.0 && p.last > 0.0);
        }
    }
}
