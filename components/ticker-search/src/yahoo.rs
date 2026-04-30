// yahoo.rs — parse Yahoo's /v1/finance/search response.
//
// This endpoint returns the full Yahoo symbol universe (foreign equities,
// ADRs, OTC, crypto, FX) and works without auth. Used as a fallback when
// the local SEC index returns no hits.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct SearchResponse {
    #[serde(default)]
    pub quotes: Vec<Quote>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub shortname: Option<String>,
    #[serde(default)]
    pub longname: Option<String>,
    #[serde(default)]
    pub quote_type: Option<String>,    // "EQUITY", "ETF", "MUTUALFUND", "INDEX", ...
    #[serde(default)]
    pub exchange: Option<String>,
}

#[derive(Debug, Clone)]
pub struct YahooMatch {
    pub symbol: String,
    pub name: String,
}

pub fn parse_search(body: &[u8]) -> Result<Vec<YahooMatch>, String> {
    let resp: SearchResponse =
        serde_json::from_slice(body).map_err(|e| format!("yahoo search json: {e}"))?;
    let mut out = Vec::new();
    for q in resp.quotes {
        let symbol = match q.symbol { Some(s) if !s.is_empty() => s, _ => continue };
        // Skip kinds we never want to suggest as option underlyings.
        match q.quote_type.as_deref() {
            Some("EQUITY") | Some("ETF") => {}
            _ => continue,
        }
        let name = q.longname.or(q.shortname).unwrap_or_else(|| symbol.clone());
        out.push(YahooMatch { symbol, name });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_response() {
        let body = br#"{"explains":[],"count":3,"quotes":[
            {"exchange":"NMS","shortname":"Apple Inc.","quoteType":"EQUITY","symbol":"AAPL","index":"quotes","score":2289299,"typeDisp":"Equity","longname":"Apple Inc.","exchDisp":"NASDAQ","sector":"Technology","sectorDisp":"Technology","industry":"Consumer Electronics","industryDisp":"Consumer Electronics","dispSecIndFlag":true,"isYahooFinance":true},
            {"exchange":"NMS","shortname":"Apple Hospitality REIT, Inc.","quoteType":"EQUITY","symbol":"APLE","index":"quotes","score":20105,"typeDisp":"Equity","longname":"Apple Hospitality REIT, Inc.","exchDisp":"NASDAQ","isYahooFinance":true},
            {"exchange":"PNK","shortname":"Apple Tree Capital","quoteType":"PNK","symbol":"APLD","index":"quotes","score":11,"typeDisp":"Equity"}
        ]}"#;
        let r = parse_search(body).unwrap();
        // The PNK / non-EQUITY entry filtered out; first two stay.
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].symbol, "AAPL");
        assert_eq!(r[1].symbol, "APLE");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_search(b"not json").is_err());
    }

    #[test]
    fn empty_quotes_ok() {
        let body = br#"{"quotes":[]}"#;
        let r = parse_search(body).unwrap();
        assert!(r.is_empty());
    }
}
