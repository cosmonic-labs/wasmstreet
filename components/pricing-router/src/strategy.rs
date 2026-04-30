// strategy.rs — POST /strategy/pnl orchestrator.
//
// Marshals the JSON request to the WIT call wasmstreet:pricing/strategy
// .compute-pnl, then repackages the result back to JSON.

use serde::{Deserialize, Serialize};

use crate::wasmstreet::pricing::strategy::{
    self as sg, GridResult, Leg as WitLeg, OptionKind, OptionSide, Scenario as WitScenario,
};

#[derive(Debug, Deserialize)]
pub struct StrategyRequest {
    pub underlying: Underlying,
    pub scenario: ScenarioJson,
    pub legs: Vec<LegJson>,
}

#[derive(Debug, Deserialize)]
pub struct Underlying {
    pub spot: f64,
    pub rate: f64,
    pub vol: f64,
}

#[derive(Debug, Deserialize)]
pub struct ScenarioJson {
    pub price_min: f64,
    pub price_max: f64,
    pub price_steps: u32,
    pub days_min: f64,
    pub days_max: f64,
    pub day_steps: u32,
}

#[derive(Debug, Deserialize)]
pub struct LegJson {
    pub side: String,
    pub kind: String,
    pub strike: f64,
    pub expiration_days: f64,
    pub iv: f64,
    pub units: u32,
    pub entry_premium: f64,
}

#[derive(Debug, Serialize)]
pub struct StrategyResponse {
    pub pnl_grid: Vec<f64>,
    pub rows: u32,
    pub cols: u32,
    pub price_axis: Vec<f64>,
    pub day_axis: Vec<f64>,
    pub max_profit: f64,
    pub max_loss: f64,
    pub profit_pct: f64,
    pub pop_at_horizon: f64,
    pub breakeven_prices: Vec<f64>,
    pub net_premium: f64,
    pub net_delta: f64,
    pub net_gamma: f64,
    pub net_vega: f64,
    pub net_theta: f64,
}

pub fn handle(req: StrategyRequest) -> Result<StrategyResponse, String> {
    let wit_legs: Vec<WitLeg> = req
        .legs
        .iter()
        .map(|l| WitLeg {
            side: parse_side(&l.side),
            kind: parse_kind(&l.kind),
            strike: l.strike,
            expiration_days: l.expiration_days,
            iv: l.iv,
            units: l.units,
            entry_premium: l.entry_premium,
        })
        .collect();

    let scen = WitScenario {
        spot: req.underlying.spot,
        rate: req.underlying.rate,
        vol: req.underlying.vol,
        price_min: req.scenario.price_min,
        price_max: req.scenario.price_max,
        price_steps: req.scenario.price_steps,
        days_min: req.scenario.days_min,
        days_max: req.scenario.days_max,
        day_steps: req.scenario.day_steps,
    };

    let r: GridResult = sg::compute_pnl(&wit_legs, scen)?;
    Ok(StrategyResponse {
        pnl_grid: r.pnl,
        rows: r.rows,
        cols: r.cols,
        price_axis: r.price_axis,
        day_axis: r.day_axis,
        max_profit: r.max_profit,
        max_loss: r.max_loss,
        profit_pct: r.profit_pct,
        pop_at_horizon: r.pop_at_horizon,
        breakeven_prices: r.breakeven_prices,
        net_premium: r.net_premium,
        net_delta: r.net_delta,
        net_gamma: r.net_gamma,
        net_vega: r.net_vega,
        net_theta: r.net_theta,
    })
}

fn parse_side(s: &str) -> OptionSide {
    match s.to_lowercase().as_str() {
        "sell" | "short" => OptionSide::Sell,
        _ => OptionSide::Buy,
    }
}

fn parse_kind(s: &str) -> OptionKind {
    match s.to_lowercase().as_str() {
        "put" => OptionKind::Put,
        _ => OptionKind::Call,
    }
}
