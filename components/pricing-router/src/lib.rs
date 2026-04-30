// pricing-router — wasi:http/incoming-handler that dispatches /price requests
// to imported pricer interfaces (black-scholes for now; mc + bt added later).

wit_bindgen::generate!({
    world: "router",
    path: "wit",
    generate_all,
});

use exports::wasi::http::incoming_handler::Guest;
use serde::{Deserialize, Serialize};
use wasi::http::types::{
    Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam,
};

mod market;
mod strategy;
mod strategy_search;
mod ui;

struct Router;
export!(Router);

#[derive(Debug, Deserialize)]
struct PriceRequest {
    spot: f64,
    strike: f64,
    vol: f64,
    rate: f64,
    time: f64,
    #[serde(default = "default_model")]
    model: String,
    // monte-carlo only
    #[serde(default = "default_paths")]
    num_paths: u32,
    #[serde(default = "default_steps")]
    num_steps: u32,
    #[serde(default)]
    seed: u64,
    // binomial-tree only
    #[serde(default = "default_bt_steps")]
    steps: u32,
    #[serde(default)]
    american: bool,
    #[serde(default = "default_option_type")]
    option_type: String,
}

fn default_model() -> String {
    "black-scholes".to_string()
}
fn default_paths() -> u32 {
    100_000
}
fn default_steps() -> u32 {
    252
}
fn default_bt_steps() -> u32 {
    1000
}
fn default_option_type() -> String {
    "call".to_string()
}

#[derive(Debug, Serialize)]
struct GreeksJson {
    delta: f64,
    gamma: f64,
    vega: f64,
    theta: f64,
    rho: f64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "model")]
enum PriceResponse {
    #[serde(rename = "black-scholes")]
    BlackScholes {
        call_price: f64,
        put_price: f64,
        greeks: GreeksJson,
    },
    #[serde(rename = "monte-carlo")]
    MonteCarlo {
        price: f64,
        std_error: f64,
        sample_paths: Vec<Vec<f64>>,
        num_paths: u32,
        num_steps: u32,
    },
    #[serde(rename = "binomial-tree")]
    BinomialTree {
        price: f64,
        steps: u32,
        american: bool,
        option_type: String,
        node_values: Vec<f64>,
        node_spots: Vec<f64>,
    },
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

impl Guest for Router {
    fn handle(req: IncomingRequest, response_out: ResponseOutparam) {
        let method = format!("{:?}", req.method());
        let path = req
            .path_with_query()
            .unwrap_or_else(|| "/".to_string());

        let (status, content_type, body_bytes) = route(&method, &path, &req);

        let headers = Fields::new();
        let _ = headers.set(
            &"content-type".to_string(),
            &[content_type.as_bytes().to_vec()],
        );
        let _ = headers.set(
            &"access-control-allow-origin".to_string(),
            &[b"*".to_vec()],
        );

        let response = OutgoingResponse::new(headers);
        response.set_status_code(status).expect("valid status");

        let body_handle = response.body().expect("body once");
        ResponseOutparam::set(response_out, Ok(response));

        // Write body after handing off the response.
        let stream = body_handle.write().expect("write stream once");
        // blocking-write-and-flush is bounded to ~4096 bytes per call; chunk.
        const CHUNK: usize = 4096;
        let mut offset = 0;
        while offset < body_bytes.len() {
            let end = (offset + CHUNK).min(body_bytes.len());
            stream
                .blocking_write_and_flush(&body_bytes[offset..end])
                .expect("blocking write");
            offset = end;
        }
        drop(stream);
        OutgoingBody::finish(body_handle, None).expect("finish body");
    }
}

fn route(method: &str, path: &str, req: &IncomingRequest) -> (u16, &'static str, Vec<u8>) {
    // CORS preflight
    if method.contains("Options") {
        return (204, "text/plain", Vec::new());
    }

    // Strip query string for matching
    let pure_path = path.split('?').next().unwrap_or(path);

    let is_post = method.contains("Post");
    let is_get = method.contains("Get");
    if is_post && pure_path == "/price" {
        return handle_price(req);
    }
    if is_get && pure_path == "/health" {
        return (200, "text/plain", b"ok\n".to_vec());
    }
    if is_get && pure_path == "/quote" {
        let ticker = query_param(path, "ticker").unwrap_or("SPY".to_string());
        return handle_quote(&ticker);
    }
    if is_get && pure_path == "/tickers" {
        let q = query_param(path, "q").unwrap_or_default();
        return handle_tickers(&q);
    }
    if is_get && pure_path == "/stock" {
        let ticker = match query_param(path, "ticker") {
            Some(t) if !t.is_empty() => t,
            _ => return error_json(400, "missing ?ticker="),
        };
        return handle_stock(&ticker);
    }
    if is_get && pure_path == "/chain" {
        let ticker = match query_param(path, "ticker") {
            Some(t) if !t.is_empty() => t,
            _ => return error_json(400, "missing ?ticker="),
        };
        return handle_chain(&ticker);
    }
    if is_post && pure_path == "/strategy/pnl" {
        return handle_strategy_pnl(req);
    }
    if is_post && pure_path == "/strategy/search" {
        return handle_strategy_search(req);
    }
    if is_get {
        return ui::serve(pure_path);
    }
    (
        404,
        "application/json",
        br#"{"error":"not found"}"#.to_vec(),
    )
}

fn handle_tickers(q: &str) -> (u16, &'static str, Vec<u8>) {
    use wasmstreet::pricing::tickers::search as ts_search;
    match ts_search(&q.to_string(), 10) {
        Ok(r) => {
            // Map the WIT result into the JSON shape the UI already expects.
            // We add `evaluated` and `used_yahoo` so the UI can show "live
            // searched Yahoo" feedback when the local index missed.
            let body = serde_json::json!({
                "matches": r.matches.iter().map(|m| serde_json::json!({
                    "ticker": m.symbol,
                    "name":   m.name,
                    "source": m.source,
                })).collect::<Vec<_>>(),
                "evaluated":  r.evaluated,
                "used_yahoo": r.used_yahoo,
            });
            (200, "application/json", serde_json::to_vec(&body).unwrap())
        }
        Err(e) => error_json(500, &format!("tickers: {e}")),
    }
}

fn handle_quote(ticker: &str) -> (u16, &'static str, Vec<u8>) {
    // Legacy /quote: keep returning a chain-like fixture for backward compat
    // with M7 integration tests. Browser uses /chain (live + enriched) now.
    use wasmstreet::pricing::quote::get_chain;
    match get_chain(&ticker.to_string()) {
        Ok(c) => {
            // Convert WIT chain to a small JSON shape with calls+puts at one expiration
            let body = serde_json::json!({
                "ticker": c.ticker,
                "spot": c.spot,
                "rate": c.rate,
                "time": c.calls.first().map(|x| x.days_to_exp / 365.0).unwrap_or(0.0),
                "source": c.source,
                "calls": c.calls.iter().take(9).map(|x| serde_json::json!({
                    "strike": x.strike, "bid": x.bid, "ask": x.ask, "mid": (x.bid + x.ask) / 2.0,
                    "iv": x.iv,
                })).collect::<Vec<_>>(),
                "puts":  c.puts.iter().take(9).map(|x| serde_json::json!({
                    "strike": x.strike, "bid": x.bid, "ask": x.ask, "mid": (x.bid + x.ask) / 2.0,
                    "iv": x.iv,
                })).collect::<Vec<_>>(),
            });
            (200, "application/json", serde_json::to_vec(&body).unwrap())
        }
        Err(e) => error_json(500, &format!("quote: {e}")),
    }
}

fn handle_stock(ticker: &str) -> (u16, &'static str, Vec<u8>) {
    use wasmstreet::pricing::quote::get_stock;
    match get_stock(&ticker.to_string()) {
        Ok(q) => {
            let body = serde_json::to_vec(&market::StockJson {
                ticker: q.ticker,
                name: q.name,
                spot: q.spot,
                day_change: q.day_change,
                day_change_pct: q.day_change_pct,
                as_of: q.as_of,
                source: q.source,
            })
            .expect("serialize stock");
            (200, "application/json", body)
        }
        Err(e) => error_json(500, &format!("stock: {e}")),
    }
}

fn handle_chain(ticker: &str) -> (u16, &'static str, Vec<u8>) {
    use wasmstreet::pricing::quote::get_chain;
    let chain = match get_chain(&ticker.to_string()) {
        Ok(c) => c,
        Err(e) => return error_json(500, &format!("chain: {e}")),
    };

    let spot = chain.spot;
    let rate = chain.rate;

    let enrich = |c: &wasmstreet::pricing::quote::OptionContract, is_call: bool| {
        let t = c.days_to_exp / 365.0;
        let bs = market::bs_full(spot, c.strike, c.iv, rate, t);
        let theo = if is_call { bs.call } else { bs.put };
        let mid = (c.bid + c.ask) / 2.0;
        let ratio = if theo > 0.0 { mid / theo } else { 0.0 };
        let delta = if is_call { bs.delta } else { bs.delta - 1.0 };
        let theta = if is_call {
            bs.theta
        } else {
            bs.theta + rate * c.strike * (-rate * t).exp()
        };
        market::EnrichedContract {
            strike: c.strike,
            bid: c.bid,
            ask: c.ask,
            last: c.last,
            mid,
            iv: c.iv,
            volume: c.volume,
            open_interest: c.open_interest,
            expiration: c.expiration.clone(),
            days_to_exp: c.days_to_exp,
            theoretical_price: theo,
            market_to_theo_ratio: ratio,
            delta,
            gamma: bs.gamma,
            vega: bs.vega,
            theta,
            rho: bs.rho,
        }
    };

    let calls: Vec<_> = chain.calls.iter().map(|c| enrich(c, true)).collect();
    let puts:  Vec<_> = chain.puts .iter().map(|c| enrich(c, false)).collect();

    let exps: Vec<_> = chain
        .expirations
        .iter()
        .map(|d| {
            let days = chain
                .calls
                .iter()
                .find(|c| c.expiration == *d)
                .map(|c| c.days_to_exp)
                .unwrap_or(0.0);
            market::ExpiryEntry { date: d.clone(), days }
        })
        .collect();

    let out = market::EnrichedChain {
        ticker: chain.ticker,
        name: chain.name,
        spot: chain.spot,
        day_change: chain.day_change,
        day_change_pct: chain.day_change_pct,
        rate: chain.rate,
        as_of: chain.as_of,
        source: chain.source,
        expirations: exps,
        calls,
        puts,
    };

    let body = serde_json::to_vec(&out).expect("serialize enriched chain");
    (200, "application/json", body)
}

fn handle_strategy_pnl(req: &IncomingRequest) -> (u16, &'static str, Vec<u8>) {
    let body = match read_body(req) {
        Ok(b) => b,
        Err(e) => return error_json(400, &format!("read body: {e}")),
    };
    let parsed: strategy::StrategyRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error_json(400, &format!("invalid json: {e}")),
    };
    match strategy::handle(parsed) {
        Ok(resp) => {
            let body = serde_json::to_vec(&resp).expect("serialize strategy");
            (200, "application/json", body)
        }
        Err(e) => error_json(400, &e),
    }
}

fn handle_strategy_search(req: &IncomingRequest) -> (u16, &'static str, Vec<u8>) {
    let body = match read_body(req) {
        Ok(b) => b,
        Err(e) => return error_json(400, &format!("read body: {e}")),
    };
    let parsed: strategy_search::SearchRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error_json(400, &format!("invalid json: {e}")),
    };
    match strategy_search::handle(parsed) {
        Ok(resp) => {
            let body = serde_json::to_vec(&resp).expect("serialize search");
            (200, "application/json", body)
        }
        Err(e) => error_json(400, &e),
    }
}

fn query_param(path: &str, key: &str) -> Option<String> {
    let qs = path.split_once('?').map(|x| x.1).unwrap_or("");
    qs.split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| url_decode(v))
}

fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' { out.push(' '); i += 1; }
        else if b == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte as char);
                i += 3;
            } else { out.push(b as char); i += 1; }
        } else { out.push(b as char); i += 1; }
    }
    out
}

fn handle_price(req: &IncomingRequest) -> (u16, &'static str, Vec<u8>) {
    let body = match read_body(req) {
        Ok(b) => b,
        Err(e) => return error_json(400, &format!("read body: {e}")),
    };
    let parsed: PriceRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error_json(400, &format!("invalid json: {e}")),
    };
    dispatch(&parsed)
}

fn dispatch(p: &PriceRequest) -> (u16, &'static str, Vec<u8>) {
    use wasmstreet::pricing::binomial_tree::{price as price_bt, BtSpec, OptionType};
    use wasmstreet::pricing::black_scholes::price_european;
    use wasmstreet::pricing::monte_carlo::{price_asian_call, McSpec};
    use wasmstreet::pricing::types::OptionSpec;

    let spec = OptionSpec {
        spot: p.spot,
        strike: p.strike,
        vol: p.vol,
        rate: p.rate,
        time: p.time,
    };

    match p.model.as_str() {
        "black-scholes" => match price_european(spec) {
            Ok(r) => {
                let resp = PriceResponse::BlackScholes {
                    call_price: r.call_price,
                    put_price: r.put_price,
                    greeks: GreeksJson {
                        delta: r.greeks.delta,
                        gamma: r.greeks.gamma,
                        vega: r.greeks.vega,
                        theta: r.greeks.theta,
                        rho: r.greeks.rho,
                    },
                };
                let body = serde_json::to_vec(&resp).expect("serialize ok");
                (200, "application/json", body)
            }
            Err(msg) => error_json(400, &msg),
        },
        "monte-carlo" => {
            let mc = McSpec {
                underlying: spec,
                num_paths: p.num_paths.max(1),
                num_steps: p.num_steps.max(1),
                seed: if p.seed == 0 { 0x9E3779B97F4A7C15 } else { p.seed },
            };
            match price_asian_call(mc) {
                Ok(r) => {
                    let viz_p = r.viz_paths as usize;
                    let viz_s = r.viz_steps as usize;
                    let mut paths_2d: Vec<Vec<f64>> = Vec::with_capacity(viz_p);
                    for i in 0..viz_p {
                        let start = i * viz_s;
                        let end = start + viz_s;
                        paths_2d.push(r.sample_paths[start..end].to_vec());
                    }
                    let resp = PriceResponse::MonteCarlo {
                        price: r.price,
                        std_error: r.std_error,
                        sample_paths: paths_2d,
                        num_paths: r.num_paths,
                        num_steps: r.num_steps,
                    };
                    let body = serde_json::to_vec(&resp).expect("serialize ok");
                    (200, "application/json", body)
                }
                Err(msg) => error_json(400, &msg),
            }
        }
        "binomial-tree" => {
            let kind = if p.option_type.eq_ignore_ascii_case("put") {
                OptionType::Put
            } else {
                OptionType::Call
            };
            let bt = BtSpec {
                underlying: spec,
                steps: p.steps.max(1),
                american: p.american,
                kind,
            };
            match price_bt(bt) {
                Ok(r) => {
                    let resp = PriceResponse::BinomialTree {
                        price: r.price,
                        steps: r.steps,
                        american: p.american,
                        option_type: p.option_type.to_lowercase(),
                        node_values: r.node_values.to_vec(),
                        node_spots: r.node_spots.to_vec(),
                    };
                    let body = serde_json::to_vec(&resp).expect("serialize ok");
                    (200, "application/json", body)
                }
                Err(msg) => error_json(400, &msg),
            }
        }
        other => error_json(400, &format!("unknown model: {other}")),
    }
}

fn read_body(req: &IncomingRequest) -> Result<Vec<u8>, String> {
    let body = req.consume().map_err(|_| "consume failed".to_string())?;
    let stream = body.stream().map_err(|_| "stream failed".to_string())?;
    let mut buf = Vec::with_capacity(1024);
    loop {
        match stream.blocking_read(8192) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break;
                }
                buf.extend_from_slice(&chunk);
            }
            Err(wasi::io::streams::StreamError::Closed) => break,
            Err(e) => return Err(format!("read error: {e:?}")),
        }
    }
    Ok(buf)
}

fn error_json(status: u16, msg: &str) -> (u16, &'static str, Vec<u8>) {
    let body = serde_json::to_vec(&ErrorResponse {
        error: msg.to_string(),
    })
    .unwrap_or_default();
    (status, "application/json", body)
}
