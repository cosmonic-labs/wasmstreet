// wasm_guest.rs — wasm-only WIT export + Yahoo HTTP fetch.

#![allow(clippy::let_and_return)]

wit_bindgen::generate!({
    world: "market-data",
    path: "wit",
    generate_all,
});

use std::cell::RefCell;
use std::collections::HashMap;

use exports::wasmstreet::pricing::quote::{Guest, OptionChain, OptionContract, StockQuote};

use crate::{fixture, synth, yahoo};

struct MarketData;
export!(MarketData);

const QUOTE_TTL_NANOS:    u64 =  10 * 1_000_000_000;
const CHAIN_TTL_NANOS:    u64 =  60 * 1_000_000_000;
const HTTP_TIMEOUT_NANOS: u64 =   5 * 1_000_000_000;

thread_local! {
    static QUOTE_CACHE: RefCell<HashMap<String, (u64, yahoo::ParsedQuote)>> =
        RefCell::new(HashMap::new());
    static CHAIN_CACHE: RefCell<HashMap<String, (u64, synth::Chain)>> =
        RefCell::new(HashMap::new());
}

impl Guest for MarketData {
    fn get_stock(ticker: String) -> Result<StockQuote, String> {
        let q = fetch_or_fixture(&ticker);
        Ok(StockQuote {
            ticker: q.ticker,
            name: q.name,
            spot: q.spot,
            day_change: q.day_change,
            day_change_pct: q.day_change_pct,
            as_of: format_iso8601(q.as_of_unix),
            source: q.source,
        })
    }

    fn get_chain(ticker: String) -> Result<OptionChain, String> {
        let key = ticker.to_uppercase();
        let now = mono_now_nanos();

        let cached = CHAIN_CACHE.with(|c| {
            let map = c.borrow();
            map.get(&key)
                .filter(|(t, _)| now.saturating_sub(*t) < CHAIN_TTL_NANOS)
                .map(|(_, v)| v.clone())
        });
        if let Some(c) = cached {
            return Ok(chain_to_wit(c));
        }

        let quote = fetch_or_fixture(&ticker);
        let as_of_iso = format_iso8601(quote.as_of_unix);
        let parsed = yahoo::ParsedQuote {
            ticker: quote.ticker.clone(),
            name: quote.name.clone(),
            spot: quote.spot,
            previous_close: quote.previous_close,
            day_change: quote.day_change,
            day_change_pct: quote.day_change_pct,
            as_of_unix: quote.as_of_unix,
        };
        let chain = synth::synthesize(&parsed, &quote.source, &as_of_iso);

        CHAIN_CACHE.with(|c| {
            c.borrow_mut().insert(key, (now, chain.clone()));
        });

        Ok(chain_to_wit(chain))
    }
}

#[derive(Clone)]
struct InternalQuote {
    ticker: String,
    name: String,
    spot: f64,
    previous_close: f64,
    day_change: f64,
    day_change_pct: f64,
    as_of_unix: i64,
    source: String,
}

fn fetch_or_fixture(ticker: &str) -> InternalQuote {
    let key = ticker.to_uppercase();
    let now = mono_now_nanos();

    if let Some(q) = QUOTE_CACHE.with(|c| {
        let map = c.borrow();
        map.get(&key)
            .filter(|(t, _)| now.saturating_sub(*t) < QUOTE_TTL_NANOS)
            .map(|(_, v)| v.clone())
    }) {
        return parsed_to_internal(q, "yahoo");
    }

    match yahoo_fetch(&key) {
        Ok(parsed) => {
            QUOTE_CACHE.with(|c| {
                c.borrow_mut().insert(key.clone(), (now, parsed.clone()));
            });
            parsed_to_internal(parsed, "yahoo")
        }
        Err(_e) => {
            let parsed = fixture::lookup(&key).unwrap_or_else(|| yahoo::ParsedQuote {
                ticker: key.clone(),
                name: key.clone(),
                spot: 100.0,
                previous_close: 99.0,
                day_change: 1.0,
                day_change_pct: 1.01,
                as_of_unix: 1714408800,
            });
            parsed_to_internal(parsed, "fixture")
        }
    }
}

fn parsed_to_internal(p: yahoo::ParsedQuote, source: &str) -> InternalQuote {
    InternalQuote {
        ticker: p.ticker,
        name: p.name,
        spot: p.spot,
        previous_close: p.previous_close,
        day_change: p.day_change,
        day_change_pct: p.day_change_pct,
        as_of_unix: p.as_of_unix,
        source: source.to_string(),
    }
}

fn chain_to_wit(c: synth::Chain) -> OptionChain {
    OptionChain {
        ticker: c.ticker,
        name: c.name,
        spot: c.spot,
        day_change: c.day_change,
        day_change_pct: c.day_change_pct,
        rate: c.rate,
        as_of: format_iso8601(c.as_of_unix),
        source: c.source,
        expirations: c.expirations,
        calls: c.calls.into_iter().map(contract_to_wit).collect(),
        puts:  c.puts .into_iter().map(contract_to_wit).collect(),
    }
}

fn contract_to_wit(c: synth::Contract) -> OptionContract {
    OptionContract {
        strike: c.strike,
        bid: c.bid,
        ask: c.ask,
        last: c.last,
        iv: c.iv,
        volume: c.volume,
        open_interest: c.open_interest,
        expiration: c.expiration,
        days_to_exp: c.days_to_exp,
    }
}

fn yahoo_fetch(ticker: &str) -> Result<yahoo::ParsedQuote, String> {
    use wasi::http::outgoing_handler::handle;
    use wasi::http::types::{Fields, Method, OutgoingRequest, RequestOptions, Scheme};

    let path_with_query = format!(
        "/v8/finance/chart/{}?range=1d&interval=1d",
        url_encode(ticker)
    );

    let headers = Fields::new();
    let _ = headers.set(
        &"User-Agent".to_string(),
        &[b"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15".to_vec()],
    );
    let _ = headers.set(&"Accept".to_string(), &[b"application/json".to_vec()]);

    let req = OutgoingRequest::new(headers);
    req.set_method(&Method::Get).map_err(|_| "set method".to_string())?;
    req.set_scheme(Some(&Scheme::Https)).map_err(|_| "set scheme".to_string())?;
    req.set_authority(Some("query1.finance.yahoo.com"))
        .map_err(|_| "set authority".to_string())?;
    req.set_path_with_query(Some(&path_with_query))
        .map_err(|_| "set path".to_string())?;

    let opts = RequestOptions::new();
    let _ = opts.set_connect_timeout(Some(HTTP_TIMEOUT_NANOS));
    let _ = opts.set_first_byte_timeout(Some(HTTP_TIMEOUT_NANOS));

    let future = handle(req, Some(opts)).map_err(|e| format!("handle: {e:?}"))?;
    future.subscribe().block();

    let resp = future
        .get()
        .ok_or("no response")?
        .map_err(|_| "future already taken".to_string())?
        .map_err(|e| format!("http error: {e:?}"))?;

    let status = resp.status();
    if !(200..300).contains(&status) {
        return Err(format!("yahoo http {status}"));
    }

    let body = resp.consume().map_err(|_| "consume".to_string())?;
    let stream = body.stream().map_err(|_| "body stream".to_string())?;
    let mut buf = Vec::with_capacity(64 * 1024);
    loop {
        match stream.blocking_read(64 * 1024) {
            Ok(chunk) => {
                if chunk.is_empty() { break; }
                buf.extend_from_slice(&chunk);
                if buf.len() > 2 * 1024 * 1024 {
                    return Err("body too large".to_string());
                }
            }
            Err(wasi::io::streams::StreamError::Closed) => break,
            Err(e) => return Err(format!("read: {e:?}")),
        }
    }
    drop(stream);

    yahoo::parse_chart(&buf)
}

fn url_encode(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect()
}

fn mono_now_nanos() -> u64 {
    wasi::clocks::monotonic_clock::now()
}

fn format_iso8601(unix_seconds: i64) -> String {
    if unix_seconds <= 0 {
        return "1970-01-01T00:00:00Z".to_string();
    }
    let total_days = unix_seconds / 86400;
    let secs_of_day = unix_seconds.rem_euclid(86400);
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    let (year, month, day) = civil_from_days(total_days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
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
