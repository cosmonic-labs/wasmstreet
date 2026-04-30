// strategy-search component glue.

#include "bindings/strategy_search_pricer_cpp.h"
#include "search.h"

#include <expected>
#include <utility>
#include <string>
#include <vector>

namespace exports::wasmstreet::pricing::search {

using strat_kind = ::wasmstreet::pricing::strategy::OptionKind;
using strat_side = ::wasmstreet::pricing::strategy::OptionSide;

static ::search::Kind cvt_kind(strat_kind k) {
    return (k == strat_kind::kCall) ? ::search::Kind::Call : ::search::Kind::Put;
}
static strat_kind cvt_kind_back(::search::Kind k) {
    return (k == ::search::Kind::Call) ? strat_kind::kCall : strat_kind::kPut;
}
static strat_side cvt_side_back(::search::Side s) {
    return (s == ::search::Side::Buy) ? strat_side::kBuy : strat_side::kSell;
}

static wit::string str_to_wit(const std::string& s) {
    return wit::string::from_view(std::string_view(s));
}

std::expected<SearchResult, wit::string>
Search(wit::vector<SearchContract> contracts, SearchConfig config) {
    std::vector<::search::Contract> chain;
    chain.reserve(contracts.size());
    for (std::size_t i = 0; i < contracts.size(); ++i) {
        const SearchContract& c = contracts[i];
        chain.push_back(::search::Contract{
            cvt_kind(c.kind), c.strike, c.expiration_days, c.iv, c.mid,
        });
    }

    ::search::Config cfg{
        config.spot, config.rate, config.scenario_vol,
        config.price_min, config.price_max, config.price_steps,
        config.days_min, config.days_max, config.day_steps,
        config.max_results,
        config.scoring.to_string(),
    };

    auto r = ::search::search(chain, cfg);

    auto ranked = wit::vector<RankedStrategy>::allocate(r.ranked.size());
    for (std::size_t i = 0; i < r.ranked.size(); ++i) {
        const auto& src = r.ranked[i];
        auto legs = wit::vector<SearchLeg>::allocate(src.legs.size());
        for (std::size_t k = 0; k < src.legs.size(); ++k) {
            const auto& sl = src.legs[k];
            legs.initialize(k, SearchLeg{
                cvt_side_back(sl.side),
                cvt_kind_back(sl.kind),
                sl.strike,
                sl.expiration_days,
                sl.iv,
                sl.units,
                sl.entry_premium,
            });
        }
        RankedStrategy rs{
            str_to_wit(src.name),
            str_to_wit(src.kind_key),
            std::move(legs),
            src.max_profit,
            src.max_loss,
            src.profit_pct,
            src.pop_at_horizon,
            src.net_premium,
            src.score,
        };
        ranked.initialize(i, std::move(rs));
    }

    SearchResult out{r.evaluated, r.elapsed_ms, std::move(ranked)};
    return out;
}

}  // namespace exports::wasmstreet::pricing::search
