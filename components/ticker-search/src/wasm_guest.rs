// wasm_guest.rs — wasm-only WIT export + Yahoo HTTP fetch.

#![allow(clippy::let_and_return)]

wit_bindgen::generate!({
    world: "ticker-search",
    path: "wit",
    generate_all,
});

use std::cell::RefCell;
use std::collections::HashMap;

use exports::wasmstreet::pricing::tickers::{Guest, TickerMatch, TickerResults};

use crate::{search, yahoo};

struct TickerSearch;
export!(TickerSearch);

const YAHOO_TTL_NANOS:    u64 =  60 * 1_000_000_000;
const HTTP_TIMEOUT_NANOS: u64 =   3 * 1_000_000_000;

thread_local! {
    static YAHOO_CACHE: RefCell<HashMap<String, (u64, Vec<yahoo::YahooMatch>)>> =
        RefCell::new(HashMap::new());
}

impl Guest for TickerSearch {
    fn search(query: String, limit: u32) -> Result<TickerResults, String> {
        let n = limit.max(1) as usize;
        let local = search::local_search(&query, n);

        let mut matches: Vec<TickerMatch> = local
            .iter()
            .map(|m| TickerMatch {
                symbol: m.symbol.to_string(),
                name: m.name.to_string(),
                source: "local".to_string(),
            })
            .collect();

        let mut used_yahoo = false;

        // Fall through to Yahoo only when local came back empty AND the
        // query is at least 2 characters (avoid hammering Yahoo on every
        // single-letter keystroke).
        if matches.is_empty() && query.trim().len() >= 2 {
            used_yahoo = true;
            match yahoo_search(&query) {
                Ok(extra) => {
                    for y in extra.into_iter().take(n) {
                        matches.push(TickerMatch {
                            symbol: y.symbol,
                            name: y.name,
                            source: "yahoo".to_string(),
                        });
                    }
                }
                Err(_e) => {
                    // Silent on Yahoo failure — the empty result speaks for itself.
                }
            }
        }

        Ok(TickerResults {
            matches,
            evaluated: crate::sec_data::SEC_TICKERS.len() as u32,
            used_yahoo,
        })
    }
}

fn yahoo_search(query: &str) -> Result<Vec<yahoo::YahooMatch>, String> {
    let key = query.trim().to_uppercase();
    let now = mono_now_nanos();

    if let Some(hit) = YAHOO_CACHE.with(|c| {
        let m = c.borrow();
        m.get(&key)
            .filter(|(t, _)| now.saturating_sub(*t) < YAHOO_TTL_NANOS)
            .map(|(_, v)| v.clone())
    }) {
        return Ok(hit);
    }

    let body = http_get_yahoo(&key)?;
    let parsed = yahoo::parse_search(&body)?;
    YAHOO_CACHE.with(|c| {
        c.borrow_mut().insert(key, (now, parsed.clone()));
    });
    Ok(parsed)
}

fn http_get_yahoo(query: &str) -> Result<Vec<u8>, String> {
    use wasi::http::outgoing_handler::handle;
    use wasi::http::types::{Fields, Method, OutgoingRequest, RequestOptions, Scheme};

    let q = url_encode(query);
    let path_with_query = format!("/v1/finance/search?q={q}&quotesCount=10&newsCount=0");

    let headers = Fields::new();
    let _ = headers.set(
        &"User-Agent".to_string(),
        &[b"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15".to_vec()],
    );
    let _ = headers.set(&"Accept".to_string(), &[b"application/json".to_vec()]);

    let req = OutgoingRequest::new(headers);
    req.set_method(&Method::Get).map_err(|_| "set method".to_string())?;
    req.set_scheme(Some(&Scheme::Https)).map_err(|_| "set scheme".to_string())?;
    req.set_authority(Some("query1.finance.yahoo.com")).map_err(|_| "set authority".to_string())?;
    req.set_path_with_query(Some(&path_with_query)).map_err(|_| "set path".to_string())?;

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
    let mut buf = Vec::with_capacity(8192);
    loop {
        match stream.blocking_read(8192) {
            Ok(chunk) => {
                if chunk.is_empty() { break; }
                buf.extend_from_slice(&chunk);
                if buf.len() > 256 * 1024 {
                    return Err("body too large".to_string());
                }
            }
            Err(wasi::io::streams::StreamError::Closed) => break,
            Err(e) => return Err(format!("read: {e:?}")),
        }
    }
    drop(stream);
    Ok(buf)
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
            out.push(c);
        } else {
            for b in c.to_string().bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

fn mono_now_nanos() -> u64 {
    wasi::clocks::monotonic_clock::now()
}
