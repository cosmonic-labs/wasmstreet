// strategy_search.rs — POST /strategy/search orchestrator.

use serde::{Deserialize, Serialize};

use crate::wasmstreet::pricing::search::{
    self as ws, RankedStrategy, SearchConfig, SearchContract, SearchLeg, SearchResult,
};
use crate::wasmstreet::pricing::strategy::{OptionKind, OptionSide};

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub spot: f64,
    pub rate: f64,
    pub scenario_vol: f64,
    pub price_min: f64,
    pub price_max: f64,
    pub price_steps: u32,
    pub days_min: f64,
    pub days_max: f64,
    pub day_steps: u32,
    #[serde(default = "default_max_results")]
    pub max_results: u32,
    #[serde(default = "default_scoring")]
    pub scoring: String,
    pub contracts: Vec<SearchContractJson>,
}
fn default_max_results() -> u32 { 10 }
fn default_scoring() -> String { "balanced".to_string() }

#[derive(Debug, Deserialize)]
pub struct SearchContractJson {
    pub kind: String,
    pub strike: f64,
    pub expiration_days: f64,
    pub iv: f64,
    pub mid: f64,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub evaluated: u32,
    pub elapsed_ms: u32,
    pub scoring: String,
    pub ranked: Vec<RankedJson>,
}

#[derive(Debug, Serialize)]
pub struct RankedJson {
    pub name: String,
    pub kind_key: String,
    pub legs: Vec<LegJson>,
    pub max_profit: f64,
    pub max_loss: f64,
    pub profit_pct: f64,
    pub pop_at_horizon: f64,
    pub net_premium: f64,
    pub score: f64,
}

#[derive(Debug, Serialize)]
pub struct LegJson {
    pub side: String,
    pub kind: String,
    pub strike: f64,
    pub expiration_days: f64,
    pub iv: f64,
    pub units: u32,
    pub entry_premium: f64,
}

pub fn handle(req: SearchRequest) -> Result<SearchResponse, String> {
    let scoring = req.scoring.clone();
    let contracts: Vec<SearchContract> = req
        .contracts
        .into_iter()
        .map(|c| SearchContract {
            kind: parse_kind(&c.kind),
            strike: c.strike,
            expiration_days: c.expiration_days,
            iv: c.iv,
            mid: c.mid,
        })
        .collect();

    let cfg = SearchConfig {
        spot: req.spot,
        rate: req.rate,
        scenario_vol: req.scenario_vol,
        price_min: req.price_min,
        price_max: req.price_max,
        price_steps: req.price_steps,
        days_min: req.days_min,
        days_max: req.days_max,
        day_steps: req.day_steps,
        max_results: req.max_results,
        scoring: scoring.clone(),
    };

    let r: SearchResult = ws::search(&contracts, &cfg)?;

    Ok(SearchResponse {
        evaluated: r.evaluated,
        elapsed_ms: r.elapsed_ms,
        scoring,
        ranked: r.ranked.into_iter().map(rank_to_json).collect(),
    })
}

fn rank_to_json(r: RankedStrategy) -> RankedJson {
    RankedJson {
        name: r.name,
        kind_key: r.kind_key,
        legs: r.legs.into_iter().map(leg_to_json).collect(),
        max_profit: r.max_profit,
        max_loss: r.max_loss,
        profit_pct: r.profit_pct,
        pop_at_horizon: r.pop_at_horizon,
        net_premium: r.net_premium,
        score: r.score,
    }
}

fn leg_to_json(l: SearchLeg) -> LegJson {
    LegJson {
        side: side_str(l.side),
        kind: kind_str(l.kind),
        strike: l.strike,
        expiration_days: l.expiration_days,
        iv: l.iv,
        units: l.units,
        entry_premium: l.entry_premium,
    }
}

fn parse_kind(s: &str) -> OptionKind {
    match s.to_lowercase().as_str() {
        "put" => OptionKind::Put,
        _ => OptionKind::Call,
    }
}
fn side_str(s: OptionSide) -> String {
    match s { OptionSide::Buy => "buy".into(), OptionSide::Sell => "sell".into() }
}
fn kind_str(k: OptionKind) -> String {
    match k { OptionKind::Call => "call".into(), OptionKind::Put => "put".into() }
}
