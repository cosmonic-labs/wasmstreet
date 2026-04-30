// Native unit tests for the Monte Carlo Asian-call pricer.

#include "../src/monte_carlo.h"

#include <cmath>
#include <cstdio>

namespace {

int g_failures = 0;

void check_close(const char* label, double actual, double expected, double tol) {
    const double diff = std::abs(actual - expected);
    if (diff > tol) {
        std::fprintf(stderr, "FAIL  %-50s  actual=%.6f  expected=%.6f  diff=%.3e  tol=%.3e\n",
                     label, actual, expected, diff, tol);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok    %-50s  %.6f\n", label, actual);
    }
}

void check_in_range(const char* label, double actual, double lo, double hi) {
    if (actual < lo || actual > hi) {
        std::fprintf(stderr, "FAIL  %-50s  actual=%.6f  range=[%.4f, %.4f]\n",
                     label, actual, lo, hi);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok    %-50s  %.6f in [%.4f, %.4f]\n",
                     label, actual, lo, hi);
    }
}

void check_true(const char* label, bool cond) {
    if (!cond) { std::fprintf(stderr, "FAIL  %s\n", label); ++g_failures; }
    else       { std::fprintf(stderr, "ok    %s\n", label); }
}

}  // namespace

int main() {
    using mc::McSpec;
    using mc::OptionSpec;
    using mc::simulate;

    // ----------------------------------------------------------------
    // Canonical Asian call: S=K=100, sigma=0.2, r=0.05, T=1, n=252.
    // Reference price ~5.61 (cf. Kemna-Vorst geometric Asian and standard
    // arithmetic Asian numerical references). With 100k paths the SE is
    // around 0.025; we accept a generous range.
    // ----------------------------------------------------------------
    {
        McSpec s{{100, 100, 0.2, 0.05, 1.0}, 100000, 252, 42};
        auto r = simulate(s);
        check_in_range("canonical asian price",         r.price,        5.0,  6.5);
        check_true   ("std-error positive and small",   r.std_error > 0 && r.std_error < 0.05);
        check_true   ("sample_paths count = 50",        r.sample_paths.size() == 50);
        check_true   ("sample_paths[0] length = 50",    r.sample_paths[0].size() == 50);
    }

    // ----------------------------------------------------------------
    // Determinism: same seed → identical price + identical first path.
    // ----------------------------------------------------------------
    {
        McSpec s1{{100, 100, 0.2, 0.05, 1.0}, 5000, 100, 12345};
        McSpec s2 = s1;
        auto r1 = simulate(s1);
        auto r2 = simulate(s2);
        check_close ("determinism: same price across runs", r1.price, r2.price, 1e-12);
        check_close ("determinism: same first path[0]",
                     r1.sample_paths[0][0], r2.sample_paths[0][0], 1e-12);
    }

    // ----------------------------------------------------------------
    // ITM call has higher price than OTM.
    // ----------------------------------------------------------------
    {
        McSpec itm{{110, 100, 0.2, 0.05, 1.0}, 50000, 100, 7};
        McSpec otm{{ 90, 100, 0.2, 0.05, 1.0}, 50000, 100, 7};
        auto r_itm = simulate(itm);
        auto r_otm = simulate(otm);
        check_true("ITM > OTM (Asian call price monotonic in S)", r_itm.price > r_otm.price);
    }

    // ----------------------------------------------------------------
    // Asian call is cheaper than European call (averaging dampens vol).
    // We use the analytical European reference: 10.4506.
    // ----------------------------------------------------------------
    {
        McSpec s{{100, 100, 0.2, 0.05, 1.0}, 100000, 252, 99};
        auto r = simulate(s);
        check_true("Asian call cheaper than European call (10.45)", r.price < 10.45);
    }

    // ----------------------------------------------------------------
    // Degenerate inputs return NaN.
    // ----------------------------------------------------------------
    {
        McSpec bad{{100, 100, 0.2, 0.05, 1.0}, 0, 100, 1};
        auto r = simulate(bad);
        check_true("zero paths returns NaN", std::isnan(r.price));
    }
    {
        McSpec bad{{100, 100, 0.2, 0.05, 0.0}, 100, 100, 1};
        auto r = simulate(bad);
        check_true("zero time returns NaN",  std::isnan(r.price));
    }

    if (g_failures > 0) {
        std::fprintf(stderr, "\n%d FAILURE(S)\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "\nAll Monte Carlo tests passed.\n");
    return 0;
}
