// yahoo.rs — parsing Yahoo Finance v8/finance/chart responses.
//
// Yahoo's options endpoint requires authentication, but the chart endpoint
// is openly accessible (subject to rate limits). We use it for live spot,
// previous close, and the official long-name for the ticker. The option
// chain is then synthesized around the live spot in synth.rs using a
// realistic IV smile — that's the strongest available demo without
// paying for an options-chain feed.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ChartResponse {
    pub chart: Chart,
}

#[derive(Debug, Deserialize)]
pub struct Chart {
    pub result: Option<Vec<ChartResult>>,
    pub error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ChartResult {
    pub meta: ChartMeta,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartMeta {
    pub symbol: String,
    pub regular_market_price: Option<f64>,
    pub chart_previous_close: Option<f64>,
    pub previous_close: Option<f64>,
    pub regular_market_time: Option<i64>,
    pub long_name: Option<String>,
    pub short_name: Option<String>,
    pub currency: Option<String>,
    pub exchange_name: Option<String>,
}

/// Parsed result from a /v8/finance/chart call: enough to render a stock card.
#[derive(Debug, Clone)]
pub struct ParsedQuote {
    pub ticker: String,
    pub name: String,
    pub spot: f64,
    pub previous_close: f64,
    pub day_change: f64,
    pub day_change_pct: f64,
    pub as_of_unix: i64,
}

pub fn parse_chart(body: &[u8]) -> Result<ParsedQuote, String> {
    let resp: ChartResponse = serde_json::from_slice(body)
        .map_err(|e| format!("yahoo chart json: {e}"))?;
    if let Some(err) = resp.chart.error {
        return Err(format!("yahoo chart error: {err}"));
    }
    let result = resp
        .chart
        .result
        .and_then(|mut v| v.pop())
        .ok_or_else(|| "yahoo chart: no result".to_string())?;
    let m = result.meta;

    let spot = m
        .regular_market_price
        .ok_or_else(|| "yahoo chart: missing regular_market_price".to_string())?;
    let previous_close = m.previous_close.or(m.chart_previous_close).unwrap_or(spot);
    let day_change = spot - previous_close;
    let day_change_pct = if previous_close > 0.0 {
        (day_change / previous_close) * 100.0
    } else {
        0.0
    };

    let name = m
        .long_name
        .or(m.short_name)
        .unwrap_or_else(|| m.symbol.clone());

    Ok(ParsedQuote {
        ticker: m.symbol,
        name,
        spot,
        previous_close,
        day_change,
        day_change_pct,
        as_of_unix: m.regular_market_time.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aapl_fixture() {
        let raw = include_bytes!("../tests/fixtures/chart_AAPL.json");
        let q = parse_chart(raw).expect("parse");
        assert_eq!(q.ticker, "AAPL");
        assert_eq!(q.name, "Apple Inc.");
        assert!((q.spot - 192.45).abs() < 1e-6);
        assert!((q.previous_close - 190.67).abs() < 1e-6);
        assert!((q.day_change - 1.78).abs() < 1e-6);
        assert!((q.day_change_pct - 0.9335).abs() < 1e-3);
    }

    #[test]
    fn rejects_invalid_json() {
        let bad = b"not json";
        assert!(parse_chart(bad).is_err());
    }

    #[test]
    fn rejects_missing_price() {
        let body = br#"{"chart":{"result":[{"meta":{"symbol":"X"}}],"error":null}}"#;
        let r = parse_chart(body);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("regular_market_price"));
    }
}
