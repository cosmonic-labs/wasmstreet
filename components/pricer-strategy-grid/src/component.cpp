// strategy-grid pricer component glue.

#include "bindings/strategy_grid_pricer_cpp.h"
#include "strategy.h"

#include <expected>
#include <utility>
#include <vector>

namespace exports::wasmstreet::pricing::strategy {

static strat::Side cvt_side(OptionSide s) {
    return (s == OptionSide::kBuy) ? strat::Side::Buy : strat::Side::Sell;
}
static strat::Kind cvt_kind(OptionKind k) {
    return (k == OptionKind::kCall) ? strat::Kind::Call : strat::Kind::Put;
}

static wit::vector<double> to_wit(const std::vector<double>& src) {
    auto v = wit::vector<double>::allocate(src.size());
    for (std::size_t i = 0; i < src.size(); ++i) v.initialize(i, double(src[i]));
    return v;
}

std::expected<GridResult, wit::string>
ComputePnl(wit::vector<Leg> legs, Scenario scen) {
    std::vector<strat::Leg> input;
    input.reserve(legs.size());
    for (std::size_t i = 0; i < legs.size(); ++i) {
        const Leg& l = legs[i];
        input.push_back(strat::Leg{
            cvt_side(l.side),
            cvt_kind(l.kind),
            l.strike,
            l.expiration_days,
            l.iv,
            l.units,
            l.entry_premium,
        });
    }
    strat::Scenario s{
        scen.spot, scen.rate, scen.vol,
        scen.price_min, scen.price_max, scen.price_steps,
        scen.days_min,  scen.days_max,  scen.day_steps,
    };
    auto r = strat::compute(input, s);

    GridResult out{
        to_wit(r.pnl),
        r.rows,
        r.cols,
        to_wit(r.price_axis),
        to_wit(r.day_axis),
        r.max_profit,
        r.max_loss,
        r.profit_pct,
        r.pop_at_horizon,
        to_wit(r.breakeven_prices),
        r.net_premium,
        r.net_delta,
        r.net_gamma,
        r.net_vega,
        r.net_theta,
    };
    return out;
}

}  // namespace exports::wasmstreet::pricing::strategy
