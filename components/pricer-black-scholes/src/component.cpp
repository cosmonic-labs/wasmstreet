// Thin WIT-bindgen glue: exports `wasmstreet:pricing/black-scholes.price-european`
// and delegates to the pure-C++ math in black_scholes.h.
//
// Lives intentionally small. All testable logic is in black_scholes.h.

#include "bindings/bs_pricer_cpp.h"
#include "black_scholes.h"

#include <cmath>
#include <expected>
#include <string_view>

namespace exports::wasmstreet::pricing::black_scholes {

std::expected<::wasmstreet::pricing::types::BsResult, wit::string>
PriceEuropean(::wasmstreet::pricing::types::OptionSpec spec) {
    bs::OptionSpec in{spec.spot, spec.strike, spec.vol, spec.rate, spec.time};
    auto p = bs::price(in);
    if (std::isnan(p.call_price)) {
        return std::unexpected(
            wit::string::from_view(std::string_view("invalid input: spot/strike/vol/time must be > 0")));
    }
    ::wasmstreet::pricing::types::Greeks g{
        p.greeks.delta, p.greeks.gamma, p.greeks.vega, p.greeks.theta, p.greeks.rho};
    ::wasmstreet::pricing::types::BsResult out{p.call_price, p.put_price, g};
    return out;
}

}  // namespace exports::wasmstreet::pricing::black_scholes
