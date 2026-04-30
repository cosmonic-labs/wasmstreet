// Native unit tests for the pure-C++ Black-Scholes math.
// Compile with system clang++ — no WASI involvement.
//
// Reference values cross-checked against:
//   Hull, "Options, Futures, and Other Derivatives", 11th ed., Examples 15.6, 19.x
//   plus put-call parity which is a hard algebraic identity.

#include "../src/black_scholes.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace {

int g_failures = 0;

void check_close(const char* label, double actual, double expected, double tol) {
    const double diff = std::abs(actual - expected);
    if (diff > tol) {
        std::fprintf(stderr,
                     "FAIL  %-50s  actual=%.10f  expected=%.10f  diff=%.3e  tol=%.3e\n",
                     label, actual, expected, diff, tol);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok    %-50s  %.6f\n", label, actual);
    }
}

void check_true(const char* label, bool cond) {
    if (!cond) {
        std::fprintf(stderr, "FAIL  %s\n", label);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok    %s\n", label);
    }
}

}  // namespace

int main() {
    using bs::OptionSpec;
    using bs::price;

    // ------------------------------------------------------------------
    // Canonical case: S=100, K=100, sigma=0.2, r=0.05, T=1
    // BS call price = 10.4506; put = 5.5735 (standard textbook value).
    // ------------------------------------------------------------------
    {
        OptionSpec s{100.0, 100.0, 0.2, 0.05, 1.0};
        auto p = price(s);
        check_close("canonical call price",        p.call_price,        10.4506, 1e-3);
        check_close("canonical put price",         p.put_price,          5.5735, 1e-3);
        check_close("canonical delta (call)",      p.greeks.delta,       0.6368, 1e-3);
        check_close("canonical gamma",             p.greeks.gamma,       0.01876, 1e-4);
        check_close("canonical vega (per 1.0)",    p.greeks.vega,        37.524, 1e-2);
        // Theta per year for ATM 1y call ~ -6.41
        check_close("canonical theta (per year)",  p.greeks.theta,      -6.4140, 1e-2);
        check_close("canonical rho",               p.greeks.rho,        53.2325, 1e-2);
    }

    // ------------------------------------------------------------------
    // Put-call parity: C - P = S - K * exp(-rT).
    // Must hold exactly (within rounding).
    // ------------------------------------------------------------------
    {
        OptionSpec s{105.0, 95.0, 0.25, 0.04, 0.5};
        auto p = price(s);
        const double parity_lhs = p.call_price - p.put_price;
        const double parity_rhs = s.spot - s.strike * std::exp(-s.rate * s.time);
        check_close("put-call parity (105/95/0.25/0.04/0.5)",
                    parity_lhs, parity_rhs, 1e-9);
    }
    {
        // Far OTM call
        OptionSpec s{50.0, 100.0, 0.3, 0.05, 2.0};
        auto p = price(s);
        const double parity_lhs = p.call_price - p.put_price;
        const double parity_rhs = s.spot - s.strike * std::exp(-s.rate * s.time);
        check_close("put-call parity (50/100/0.3/0.05/2.0)",
                    parity_lhs, parity_rhs, 1e-9);
        check_true("OTM call price is positive but small",
                   p.call_price > 0.0 && p.call_price < 5.0);
    }

    // ------------------------------------------------------------------
    // Boundary behavior: K=0 limits → call = S, delta = 1.
    // We test as K → very small (proper K=0 is rejected).
    // ------------------------------------------------------------------
    {
        OptionSpec s{100.0, 0.01, 0.2, 0.05, 1.0};
        auto p = price(s);
        check_close("near-zero strike: call ~ S",    p.call_price, 100.0, 0.05);
        check_close("near-zero strike: delta ~ 1",   p.greeks.delta, 1.0,    1e-6);
    }

    // ------------------------------------------------------------------
    // Greeks consistency: delta ∈ [0, 1] for calls; gamma >= 0; vega >= 0.
    // ------------------------------------------------------------------
    {
        OptionSpec s{100.0, 110.0, 0.3, 0.03, 0.25};
        auto p = price(s);
        check_true("delta in [0,1]",  p.greeks.delta >= 0.0 && p.greeks.delta <= 1.0);
        check_true("gamma >= 0",      p.greeks.gamma >= 0.0);
        check_true("vega  >= 0",      p.greeks.vega  >= 0.0);
        check_true("call price >= 0", p.call_price   >= 0.0);
        check_true("put price >= 0",  p.put_price    >= 0.0);
    }

    // ------------------------------------------------------------------
    // Degenerate inputs return NaN, not garbage.
    // ------------------------------------------------------------------
    {
        OptionSpec bad{-1.0, 100.0, 0.2, 0.05, 1.0};
        auto p = price(bad);
        check_true("negative spot returns NaN call", std::isnan(p.call_price));
    }
    {
        OptionSpec bad{100.0, 100.0, 0.2, 0.05, 0.0};
        auto p = price(bad);
        check_true("zero time returns NaN call",     std::isnan(p.call_price));
    }
    {
        OptionSpec bad{100.0, 100.0, 0.0, 0.05, 1.0};
        auto p = price(bad);
        check_true("zero vol returns NaN call",      std::isnan(p.call_price));
    }

    if (g_failures > 0) {
        std::fprintf(stderr, "\n%d FAILURE(S)\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "\nAll Black-Scholes tests passed.\n");
    return 0;
}
