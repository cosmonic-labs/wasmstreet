// Native unit tests for the multi-leg strategy P&L grid.

#include "../src/strategy.h"

#include <algorithm>
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

void check_in_range(const char* label, double actual, double lo, double hi) {
    if (actual < lo || actual > hi) {
        std::fprintf(stderr, "FAIL  %-60s  actual=%.6f range=[%.4f, %.4f]\n",
                     label, actual, lo, hi);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok    %-60s  %.6f in [%.4f, %.4f]\n",
                     label, actual, lo, hi);
    }
}

}  // namespace

int main() {
    using strat::compute;
    using strat::Kind;
    using strat::Leg;
    using strat::Scenario;
    using strat::Side;

    // --------------------------------------------------------------
    // 1. Long call, single leg. At expiry (j=cols-1, day=horizon=expiration_days),
    //    P&L = 100 * units * (max(S - K, 0) - premium). Spot-checked.
    //    Setup: K=100, premium=4.20, units=1, exp=30d. At S=110 at expiry,
    //    P&L should be 100 * (10 - 4.20) = $580.
    // --------------------------------------------------------------
    {
        std::vector<Leg> legs = {
            {Side::Buy, Kind::Call, 100.0, 30.0, 0.20, 1, 4.20},
        };
        Scenario s{100.0, 0.05, 0.20, 90.0, 110.0, 21, 0.0, 30.0, 31};
        auto r = compute(legs, s);
        // At i where price_axis[i] = 110.0 (the last index, since axis is 90..110)
        // and j = cols - 1, day = 30 (== exp days), days_remaining = 0.
        const std::size_t i = r.rows - 1;          // S = 110
        const std::size_t j = r.cols - 1;          // day = 30 (expiry)
        const double pnl_at_S110_exp = r.pnl[i * r.cols + j];
        check_close("long call: S=110 at expiry P&L = (10-4.20)*100",
                    pnl_at_S110_exp, 580.0, 1e-6);

        // At S=K=100, expiry, P&L = 100 * (0 - 4.20) = -420
        const std::size_t i_atk = r.rows / 2;      // S = 100
        const double pnl_at_K_exp = r.pnl[i_atk * r.cols + j];
        check_close("long call: S=K at expiry P&L = -premium*100",
                    pnl_at_K_exp, -420.0, 1e-6);

        // Net premium for a long call = -premium*100 (debit is negative credit).
        check_close("long call net premium", r.net_premium, -420.0, 1e-6);

        // Max profit on a long call grows with S, so it should be > 0. Max loss
        // (at expiry, S<=K) = -premium*100 = -420.
        check_close("long call max loss (at expiry)", r.max_loss, -420.0, 1.0);
    }

    // --------------------------------------------------------------
    // 2. Bull call spread: Buy K=100 @ 4.20, Sell K=110 @ 1.50.
    //    Net debit = (4.20 - 1.50) * 100 = $270 paid.
    //    Max profit = (110 - 100) * 100 - 270 = $730 (at S>=110, expiry).
    //    Max loss = -$270 (at S<=100, expiry).
    // --------------------------------------------------------------
    {
        std::vector<Leg> legs = {
            {Side::Buy,  Kind::Call, 100.0, 30.0, 0.20, 1, 4.20},
            {Side::Sell, Kind::Call, 110.0, 30.0, 0.18, 1, 1.50},
        };
        Scenario s{100.0, 0.05, 0.20, 80.0, 130.0, 51, 0.0, 30.0, 31};
        auto r = compute(legs, s);
        check_close("bull call spread net premium (debit -270)", r.net_premium, -270.0, 1e-6);
        // Max profit close to 730, max loss close to -270 (at expiry boundaries).
        check_in_range("bull call spread max profit ~ 730",  r.max_profit,  720.0,  740.0);
        check_in_range("bull call spread max loss  ~ -270",  r.max_loss,   -280.0, -260.0);

        // Breakeven at expiry should be ~K1 + net_debit_per_share = 100 + 2.70 = 102.70.
        check_true("bull call spread has at least one breakeven",
                   !r.breakeven_prices.empty());
        if (!r.breakeven_prices.empty()) {
            check_in_range("bull call spread breakeven ~ 102.70",
                           r.breakeven_prices[0], 102.0, 103.5);
        }
    }

    // --------------------------------------------------------------
    // 3. Long straddle (call + put at same K). At expiry, max loss is
    //    -100*(c+p), occurs at S = K.
    // --------------------------------------------------------------
    {
        std::vector<Leg> legs = {
            {Side::Buy, Kind::Call, 100.0, 30.0, 0.20, 1, 4.20},
            {Side::Buy, Kind::Put,  100.0, 30.0, 0.20, 1, 3.90},
        };
        Scenario s{100.0, 0.05, 0.20, 80.0, 120.0, 41, 0.0, 30.0, 31};
        auto r = compute(legs, s);
        check_close("long straddle net premium (debit -810)", r.net_premium, -810.0, 1e-6);
        // Max loss should be -810 at S=K, expiry. The grid sample at S=100, j=cols-1.
        const std::size_t mid_i = 20;  // axis 80..120 in 41 steps; index 20 = 100
        const std::size_t exp_j = r.cols - 1;
        check_close("straddle P&L at S=K, expiry = -810",
                    r.pnl[mid_i * r.cols + exp_j], -810.0, 1.0);
        // Two breakevens (one above K, one below).
        check_in_range("straddle has 2 breakevens at expiry",
                       static_cast<double>(r.breakeven_prices.size()), 2.0, 2.0);
    }

    // --------------------------------------------------------------
    // 4. Iron condor: short OTM call spread + short OTM put spread.
    //    Should have 2 inner-region profit zones bordered by breakevens.
    //    A correct iron condor produces 2 breakevens (one on each side
    //    of the profit envelope).
    // --------------------------------------------------------------
    {
        std::vector<Leg> legs = {
            {Side::Sell, Kind::Put,   95.0, 30.0, 0.22, 1, 1.20},
            {Side::Buy,  Kind::Put,   90.0, 30.0, 0.24, 1, 0.55},
            {Side::Sell, Kind::Call, 105.0, 30.0, 0.20, 1, 1.10},
            {Side::Buy,  Kind::Call, 110.0, 30.0, 0.18, 1, 0.50},
        };
        Scenario s{100.0, 0.05, 0.20, 80.0, 120.0, 81, 0.0, 30.0, 31};
        auto r = compute(legs, s);
        // Net credit: (sell premiums - buy premiums) * 100
        //   = (1.20 + 1.10 - 0.55 - 0.50) * 100 = 125
        check_close("iron condor net premium (credit +125)", r.net_premium, 125.0, 1e-6);
        // Two breakevens.
        check_in_range("iron condor has 2 breakevens at expiry",
                       static_cast<double>(r.breakeven_prices.size()), 2.0, 2.0);
        // Max profit = net credit = 125, occurs in the inner region at expiry.
        check_in_range("iron condor max profit ~ 125", r.max_profit, 120.0, 130.0);
        // Max loss = max wing - credit = (5.00 * 100) - 125 = 375
        check_in_range("iron condor max loss ~ -375", r.max_loss, -385.0, -365.0);
    }

    // --------------------------------------------------------------
    // 5. Empty legs returns zero grid.
    // --------------------------------------------------------------
    {
        std::vector<Leg> legs;
        Scenario s{100.0, 0.05, 0.20, 80.0, 120.0, 11, 0.0, 30.0, 6};
        auto r = compute(legs, s);
        check_true("empty legs: pnl all zero",
                   std::all_of(r.pnl.begin(), r.pnl.end(),
                               [](double v){ return v == 0.0; }));
        check_close("empty legs: max profit = 0", r.max_profit, 0.0, 1e-12);
        check_close("empty legs: max loss = 0",   r.max_loss,   0.0, 1e-12);
    }

    // --------------------------------------------------------------
    // 6. Vol shock (scenario.vol > 0 acts as additive IV shift):
    //    a long-vol position gets richer when vol shocks up; a short-vol
    //    position gets cheaper. We measure the off-expiry midpoint cell
    //    for a long straddle with and without a +20pp shock.
    // --------------------------------------------------------------
    {
        std::vector<Leg> legs = {
            {Side::Buy, Kind::Call, 100.0, 30.0, 0.20, 1, 4.20},
            {Side::Buy, Kind::Put,  100.0, 30.0, 0.20, 1, 3.90},
        };
        Scenario base    {100.0, 0.05, 0.00, 80.0, 120.0, 41, 0.0, 30.0, 31};  // no shock
        Scenario shocked {100.0, 0.05, 0.20, 80.0, 120.0, 41, 0.0, 30.0, 31};  // +20pp IV
        auto rb = compute(legs, base);
        auto rs = compute(legs, shocked);

        // Pick the cell at S=spot, day=0 (entry-ish): with shock, the legs
        // are worth MORE because higher IV → higher option price.
        const std::size_t mid_i = 20;  // S=100
        const std::size_t early_j = 0;
        const double pnl_base    = rb.pnl[mid_i * rb.cols + early_j];
        const double pnl_shocked = rs.pnl[mid_i * rs.cols + early_j];
        check_true("vol shock raises long-straddle mid-cell P&L",
                   pnl_shocked > pnl_base + 50.0);
    }

    // --------------------------------------------------------------
    // 7. Performance: 60×30 grid, 4 legs should run quickly.
    //    Sanity: compute returns within reason.
    // --------------------------------------------------------------
    {
        std::vector<Leg> legs = {
            {Side::Sell, Kind::Put,   95.0, 30.0, 0.22, 1, 1.20},
            {Side::Buy,  Kind::Put,   90.0, 30.0, 0.24, 1, 0.55},
            {Side::Sell, Kind::Call, 105.0, 30.0, 0.20, 1, 1.10},
            {Side::Buy,  Kind::Call, 110.0, 30.0, 0.18, 1, 0.50},
        };
        Scenario s{100.0, 0.05, 0.20, 80.0, 120.0, 60, 0.0, 30.0, 30};
        auto r = compute(legs, s);
        check_true("60x30 grid produced rows*cols = 1800 cells",
                   r.pnl.size() == 60 * 30);
    }

    if (g_failures > 0) {
        std::fprintf(stderr, "\n%d FAILURE(S)\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "\nAll strategy-grid tests passed.\n");
    return 0;
}
