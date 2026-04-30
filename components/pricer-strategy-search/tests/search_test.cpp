// Native unit tests for the strategy-search engine.

#include "../src/search.h"

#include <cstdio>
#include <set>

namespace {

int g_failures = 0;

void check_true(const char* label, bool cond) {
    if (!cond) { std::fprintf(stderr, "FAIL  %s\n", label); ++g_failures; }
    else       { std::fprintf(stderr, "ok    %s\n", label); }
}

}  // namespace

int main() {
    using namespace search;

    // Build a small synthetic chain around spot=100.
    // 5 strikes per side at one expiration (30d).
    std::vector<Contract> chain;
    const double spot = 100.0;
    const double exp = 30.0;
    const double base_iv = 0.22;
    auto bs_call = [](double S, double K, double sigma, double r, double t){
        if (t <= 0 || sigma <= 0) return std::max(S - K, 0.0);
        const double sqrtT = std::sqrt(t);
        const double d1 = (std::log(S/K) + (r + 0.5*sigma*sigma)*t) / (sigma*sqrtT);
        const double d2 = d1 - sigma*sqrtT;
        return S * 0.5*(1.0+std::erf(d1/std::sqrt(2.0)))
               - K * std::exp(-r*t) * 0.5*(1.0+std::erf(d2/std::sqrt(2.0)));
    };
    auto bs_put = [&](double S, double K, double sigma, double r, double t){
        return bs_call(S,K,sigma,r,t) - S + K * std::exp(-r*t);
    };
    for (double k : {90.0, 95.0, 100.0, 105.0, 110.0}) {
        const double t = exp / 365.0;
        chain.push_back({Kind::Call, k, exp, base_iv, bs_call(spot, k, base_iv, 0.05, t)});
        chain.push_back({Kind::Put,  k, exp, base_iv, bs_put (spot, k, base_iv, 0.05, t)});
    }

    Config cfg{spot, 0.05, base_iv, 80.0, 120.0, 21, 0.0, 30.0, 11, 10, "balanced"};
    auto r = search::search(chain, cfg);

    check_true("at least 30 candidates evaluated", r.evaluated >= 30);
    check_true("returned <= 10 ranked",            r.ranked.size() <= 10);
    check_true("ranked is non-empty",              !r.ranked.empty());

    // Top result should have a positive score.
    if (!r.ranked.empty()) {
        check_true("top result has positive score", r.ranked[0].score > 0.0);
        check_true("top result has at least one leg", !r.ranked[0].legs.empty());
        check_true("top result name is non-empty",   !r.ranked[0].name.empty());
    }

    // Ensure ranked is sorted descending by score.
    for (std::size_t i = 1; i < r.ranked.size(); ++i) {
        if (r.ranked[i - 1].score < r.ranked[i].score) {
            std::fprintf(stderr, "FAIL ranked not sorted at index %zu\n", i);
            ++g_failures;
            break;
        }
    }
    if (g_failures == 0) std::fprintf(stderr, "ok    ranked sorted descending by score\n");

    // Should generate diverse strategy kinds.
    std::set<std::string> kinds;
    for (auto& c : r.ranked) kinds.insert(c.kind_key);
    check_true("at least 2 distinct strategy kinds in top results", kinds.size() >= 2);

    // Income scoring should prefer credit (negative net_premium isn't credit; positive is).
    Config cfg_income = cfg;
    cfg_income.scoring = "income";
    cfg_income.max_results = 5;
    auto inc = search::search(chain, cfg_income);
    if (!inc.ranked.empty()) {
        // Income scoring is constrained: every result must be a credit strategy.
        int credit_count = 0;
        for (auto& c : inc.ranked) {
            std::fprintf(stderr, "      [income] %s  net=%.2f  pp=%.1f%%  score=%.2f\n",
                         c.name.c_str(), c.net_premium, c.profit_pct, c.score);
            if (c.net_premium > 0) ++credit_count;
        }
        check_true("income scoring: all results are credits", credit_count == (int)inc.ranked.size());
    }

    if (g_failures > 0) {
        std::fprintf(stderr, "\n%d FAILURE(S)\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "\nAll search tests passed.\n");
    return 0;
}
