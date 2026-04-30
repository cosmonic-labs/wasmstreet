// search.rs — local autocomplete over the baked SEC universe.
//
// Tier 1: prefix match on the symbol  (best UX, "AAP" → AAPL first)
// Tier 2: substring match on the symbol
// Tier 3: substring match on the company name
//
// All three are case-insensitive. We stop early once we've collected
// `limit` results.

use crate::sec_data::SEC_TICKERS;

#[derive(Debug, Clone)]
pub struct LocalMatch {
    pub symbol: &'static str,
    pub name: &'static str,
}

pub fn local_search(query: &str, limit: usize) -> Vec<LocalMatch> {
    let q = query.trim().to_uppercase();
    if q.is_empty() {
        // Empty query: return the first `limit` of the universe — a tour
        // of the most well-known names roughly because the SEC file is
        // sorted by CIK which correlates with size for the leaders.
        return SEC_TICKERS
            .iter()
            .take(limit)
            .map(|(s, n)| LocalMatch { symbol: s, name: n })
            .collect();
    }

    let mut prefix    = Vec::new();
    let mut substring = Vec::new();
    let mut name_hit  = Vec::new();

    for &(symbol, name) in SEC_TICKERS.iter() {
        if symbol.starts_with(&q) {
            prefix.push(LocalMatch { symbol, name });
            if prefix.len() >= limit { break; }
        }
    }
    if prefix.len() < limit {
        for &(symbol, name) in SEC_TICKERS.iter() {
            if !symbol.starts_with(&q) && symbol.contains(&q) {
                substring.push(LocalMatch { symbol, name });
                if prefix.len() + substring.len() >= limit { break; }
            }
        }
    }
    if prefix.len() + substring.len() < limit {
        // Name-substring is the most expensive scan; only do it if we
        // haven't already filled the limit from symbol matches. Bound
        // it to the first 4000 entries (the most-liquid names) to keep
        // the worst-case latency under 1 ms.
        let upper_q = q.as_str();
        for (idx, &(symbol, name)) in SEC_TICKERS.iter().enumerate() {
            if idx > 4000 { break; }
            if !symbol.starts_with(&q) && !symbol.contains(&q)
               && name.to_uppercase().contains(upper_q) {
                name_hit.push(LocalMatch { symbol, name });
                if prefix.len() + substring.len() + name_hit.len() >= limit { break; }
            }
        }
    }

    let mut all = Vec::with_capacity(limit);
    for m in prefix.into_iter().chain(substring).chain(name_hit) {
        if all.len() >= limit { break; }
        all.push(m);
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_aapl_by_prefix() {
        let r = local_search("AAPL", 5);
        assert!(r.iter().any(|m| m.symbol == "AAPL"));
    }

    #[test]
    fn prefix_wins_over_substring() {
        let r = local_search("BA", 5);
        // "BA" itself should win over things like "ABBA" if both exist
        assert!(!r.is_empty());
        assert!(r[0].symbol.starts_with("BA"));
    }

    #[test]
    fn empty_query_returns_top_n() {
        let r = local_search("", 10);
        assert_eq!(r.len(), 10);
    }

    #[test]
    fn name_substring_match() {
        // Apple Inc. — search by name should land AAPL even if symbol differs
        let r = local_search("apple", 5);
        assert!(r.iter().any(|m| m.symbol == "AAPL"),
                "expected AAPL in results: {:?}", r.iter().map(|m| m.symbol).collect::<Vec<_>>());
    }

    #[test]
    fn universe_is_large() {
        // Sanity: we baked the whole SEC list.
        assert!(SEC_TICKERS.len() >= 10_000);
    }
}
