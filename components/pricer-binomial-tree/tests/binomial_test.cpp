// Native unit tests for the binomial tree pricer.

#include "../src/binomial.h"

#include <cmath>
#include <cstdio>

namespace {

int g_failures = 0;

void check_close(const char* label, double actual, double expected, double tol) {
    const double diff = std::abs(actual - expected);
    if (diff > tol) {
        std::fprintf(stderr, "FAIL  %-60s  actual=%.6f  expected=%.6f  diff=%.3e  tol=%.3e\n",
                     label, actual, expected, diff, tol);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok    %-60s  %.6f\n", label, actual);
    }
}

void check_true(const char* label, bool cond) {
    if (!cond) { std::fprintf(stderr, "FAIL  %s\n", label); ++g_failures; }
    else       { std::fprintf(stderr, "ok    %s\n", label); }
}

}  // namespace

int main() {
    using bt::OptionSpec;
    using bt::OptionType;
    using bt::price;
    using bt::Spec;

    // --------------------------------------------------------------
    // 1. American call on non-dividend-paying stock = European call.
    //    Convergence: with enough steps both should approach BS = 10.4506.
    // --------------------------------------------------------------
    {
        OptionSpec o{100, 100, 0.2, 0.05, 1.0};
        Spec euro_call{o, 1000, false, OptionType::Call};
        Spec amer_call{o, 1000, true,  OptionType::Call};
        auto re = price(euro_call);
        auto ra = price(amer_call);
        check_close("european call (1000 steps) ~ BS 10.4506",
                    re.price, 10.4506, 0.05);
        check_close("american call == european call (no div)",
                    ra.price, re.price, 1e-9);
    }

    // --------------------------------------------------------------
    // 2. American put > European put for the same parameters
    //    (early exercise has positive value).
    // --------------------------------------------------------------
    {
        OptionSpec o{100, 100, 0.2, 0.05, 1.0};
        Spec euro_put{o, 1000, false, OptionType::Put};
        Spec amer_put{o, 1000, true,  OptionType::Put};
        auto re = price(euro_put);
        auto ra = price(amer_put);
        check_true("american put > european put", ra.price > re.price);
        // European put should converge to BS = 5.5735
        check_close("european put (1000 steps) ~ BS 5.5735",
                    re.price, 5.5735, 0.05);
    }

    // --------------------------------------------------------------
    // 3. Convergence: increasing steps tightens to BS price.
    // --------------------------------------------------------------
    {
        OptionSpec o{100, 100, 0.2, 0.05, 1.0};
        auto p100  = price(Spec{o,  100, false, OptionType::Call});
        auto p500  = price(Spec{o,  500, false, OptionType::Call});
        auto p1000 = price(Spec{o, 1000, false, OptionType::Call});
        const double e100  = std::abs(p100.price  - 10.4506);
        const double e500  = std::abs(p500.price  - 10.4506);
        const double e1000 = std::abs(p1000.price - 10.4506);
        check_true("|err(500)| <= |err(100)| (loose)", e500  <= e100  * 1.5);
        check_true("|err(1000)| <= |err(500)|", e1000 <= e500);
    }

    // --------------------------------------------------------------
    // 4. Tree size matches expectation: (N+1)(N+2)/2 nodes.
    // --------------------------------------------------------------
    {
        OptionSpec o{100, 100, 0.2, 0.05, 1.0};
        Spec s{o, 100, true, OptionType::Put};
        auto r = price(s);
        const std::size_t expected = (100 + 1) * (100 + 2) / 2;
        check_true("node_values length = (N+1)(N+2)/2", r.node_values.size() == expected);
        check_true("node_spots length  = (N+1)(N+2)/2",  r.node_spots .size() == expected);
    }

    // --------------------------------------------------------------
    // 5. Degenerate inputs.
    // --------------------------------------------------------------
    {
        OptionSpec o{100, 100, 0.2, 0.05, 1.0};
        auto bad = price(Spec{o, 0, false, OptionType::Call});
        check_true("zero steps -> NaN", std::isnan(bad.price));
    }
    {
        OptionSpec o{0, 100, 0.2, 0.05, 1.0};
        auto bad = price(Spec{o, 100, false, OptionType::Call});
        check_true("zero spot -> NaN", std::isnan(bad.price));
    }

    if (g_failures > 0) {
        std::fprintf(stderr, "\n%d FAILURE(S)\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "\nAll binomial tests passed.\n");
    return 0;
}
