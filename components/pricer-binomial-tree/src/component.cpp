// BT pricer component glue: exports wasmstreet:pricing/binomial-tree.

#include "bindings/bt_pricer_cpp.h"
#include "binomial.h"

#include <cmath>
#include <expected>
#include <string_view>
#include <utility>

namespace exports::wasmstreet::pricing::binomial_tree {

std::expected<BtResult, wit::string>
Price(BtSpec spec) {
    bt::OptionSpec o{
        spec.underlying.spot, spec.underlying.strike, spec.underlying.vol,
        spec.underlying.rate, spec.underlying.time};
    bt::Spec s{o, spec.steps, spec.american,
               (spec.kind == OptionType::kCall) ? bt::OptionType::Call : bt::OptionType::Put};
    auto r = bt::price(s);
    if (std::isnan(r.price)) {
        return std::unexpected(wit::string::from_view(
            std::string_view("invalid binomial input: spot/strike/vol/time/steps must be > 0; non-arbitrage condition required")));
    }

    // Copy std::vector<double> -> wit::vector<double>.
    auto values = wit::vector<double>::allocate(r.node_values.size());
    for (std::size_t i = 0; i < r.node_values.size(); ++i)
        values.initialize(i, double(r.node_values[i]));

    auto spots = wit::vector<double>::allocate(r.node_spots.size());
    for (std::size_t i = 0; i < r.node_spots.size(); ++i)
        spots.initialize(i, double(r.node_spots[i]));

    BtResult out{r.price, r.steps, std::move(values), std::move(spots)};
    return out;
}

}  // namespace exports::wasmstreet::pricing::binomial_tree
