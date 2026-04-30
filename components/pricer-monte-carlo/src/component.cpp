// MC pricer component glue: exports wasmstreet:pricing/monte-carlo.

#include "bindings/mc_pricer_cpp.h"
#include "monte_carlo.h"

#include <cmath>
#include <expected>
#include <string_view>
#include <utility>

namespace exports::wasmstreet::pricing::monte_carlo {

std::expected<::wasmstreet::pricing::types::McResult, wit::string>
PriceAsianCall(McSpec spec) {
    mc::OptionSpec o{
        spec.underlying.spot, spec.underlying.strike, spec.underlying.vol,
        spec.underlying.rate, spec.underlying.time};
    mc::McSpec s{o, spec.num_paths, spec.num_steps, spec.seed};
    auto r = mc::simulate(s);
    if (std::isnan(r.price)) {
        return std::unexpected(wit::string::from_view(
            std::string_view("invalid mc input: paths/steps/time/spot/strike/vol must be > 0")));
    }

    const std::size_t viz_paths = r.sample_paths.size();
    const std::size_t viz_steps = (viz_paths > 0) ? r.sample_paths[0].size() : 0;
    const std::size_t total = viz_paths * viz_steps;

    auto flat = wit::vector<double>::allocate(total);
    for (std::size_t i = 0; i < viz_paths; ++i) {
        const auto& src = r.sample_paths[i];
        for (std::size_t k = 0; k < viz_steps; ++k) {
            flat.initialize(i * viz_steps + k, double(src[k]));
        }
    }

    ::wasmstreet::pricing::types::McResult out{
        r.price,
        r.std_error,
        std::move(flat),
        static_cast<uint32_t>(viz_paths),
        static_cast<uint32_t>(viz_steps),
        r.num_paths,
        r.num_steps,
    };
    return out;
}

}  // namespace exports::wasmstreet::pricing::monte_carlo
