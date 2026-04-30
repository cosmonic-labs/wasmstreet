#pragma once
// Multi-leg strategy P&L grid.
//
// For each (price, days-remaining) cell, evaluate every leg's mark-to-market
// option price using Black-Scholes (header-only, shared with pricer-black-
// scholes), apply leg side + units + entry premium, sum to net strategy P&L.
//
// Pure C++, no WASI deps — natively testable.

#include "../../pricer-black-scholes/src/black_scholes.h"

#include <cmath>
#include <cstdint>
#include <vector>

namespace strat {

enum class Side { Buy, Sell };
enum class Kind { Call, Put };

struct Leg {
    Side side;
    Kind kind;
    double strike;
    double expiration_days;   // total time to expiry at scenario t=0
    double iv;
    uint32_t units;           // number of contracts (multiply by 100 for share-equivalent)
    double entry_premium;     // per-share premium paid (Buy) or received (Sell)
};

struct Scenario {
    double spot;              // used for net-Greeks-at-spot AND lognormal PoP
    double rate;
    double vol;               // additive IV shock applied to every leg's iv
                              //   (slider -10%..+30%; baseline is 0% = use leg.iv as-is)
    double price_min;
    double price_max;
    uint32_t price_steps;
    double days_min;          // days from "now" forward
    double days_max;
    uint32_t day_steps;
};

// Effective IV used for forward marks: leg's IV plus the scenario shock,
// floored at 1% to avoid degenerate BS evaluations.
inline double effective_iv(double leg_iv, double vol_shock) {
    const double shifted = leg_iv + vol_shock;
    return (shifted < 0.01) ? 0.01 : shifted;
}

struct Result {
    std::vector<double> pnl;          // size = price_steps * day_steps, row-major (i=price, j=day)
    uint32_t rows;
    uint32_t cols;
    std::vector<double> price_axis;
    std::vector<double> day_axis;
    double max_profit;
    double max_loss;
    double profit_pct;                // share of cells with pnl > 0, in %
    double pop_at_horizon;            // lognormal-weighted probability of profit at horizon
    std::vector<double> breakeven_prices;  // along the price axis at j=cols-1 (latest day)
    double net_premium;               // negative if net debit, positive if net credit
    double net_delta, net_gamma, net_vega, net_theta;
};

// payoff per contract per share, signed by side. vol_shock is added to
// each leg's IV when computing forward marks (0 = use leg.iv as-is).
inline double leg_value(const Leg& leg, double S, double days_remaining,
                         double rate, double vol_shock = 0.0) {
    // Convert days remaining to years.
    const double t = std::max(days_remaining, 0.0) / 365.0;

    double price_per_share = 0.0;
    if (t <= 0.0) {
        // At-or-after-expiry: intrinsic only.
        if (leg.kind == Kind::Call) price_per_share = std::max(S - leg.strike, 0.0);
        else                         price_per_share = std::max(leg.strike - S, 0.0);
    } else {
        const double iv = effective_iv(leg.iv, vol_shock);
        bs::OptionSpec spec{S, leg.strike, iv, rate, t};
        auto p = bs::price(spec);
        if (std::isnan(p.call_price)) {
            // Defensive: degenerate inputs. Treat as intrinsic.
            if (leg.kind == Kind::Call) price_per_share = std::max(S - leg.strike, 0.0);
            else                         price_per_share = std::max(leg.strike - S, 0.0);
        } else {
            price_per_share = (leg.kind == Kind::Call) ? p.call_price : p.put_price;
        }
    }

    // Per-leg P&L from entry: (mark - entry) * sign * units * 100 shares per contract.
    const double sign = (leg.side == Side::Buy) ? +1.0 : -1.0;
    return (price_per_share - leg.entry_premium) * sign * static_cast<double>(leg.units) * 100.0;
}

inline double net_premium(const std::vector<Leg>& legs) {
    // Premium paid (Buy: +premium*units*100) minus received (Sell: -premium*units*100).
    // Returned with sign convention "credit positive": Sell increases net_premium.
    double sum = 0.0;
    for (const auto& l : legs) {
        const double sign = (l.side == Side::Sell) ? +1.0 : -1.0;
        sum += sign * l.entry_premium * static_cast<double>(l.units) * 100.0;
    }
    return sum;
}

inline std::vector<double> linspace(double lo, double hi, uint32_t n) {
    std::vector<double> v(n);
    if (n == 1) { v[0] = lo; return v; }
    const double step = (hi - lo) / static_cast<double>(n - 1);
    for (uint32_t i = 0; i < n; ++i) v[i] = lo + static_cast<double>(i) * step;
    return v;
}

inline std::vector<double> find_breakevens_at_t(const std::vector<Leg>& legs,
                                                 double rate,
                                                 double days_remaining,
                                                 double vol_shock,
                                                 const std::vector<double>& prices) {
    std::vector<double> result;
    if (prices.size() < 2) return result;
    auto pnl_at = [&](double S) {
        double sum = 0.0;
        for (const auto& l : legs) sum += leg_value(l, S, days_remaining, rate, vol_shock);
        return sum;
    };
    double prev_S = prices[0];
    double prev_v = pnl_at(prev_S);
    for (std::size_t i = 1; i < prices.size(); ++i) {
        const double cur_S = prices[i];
        const double cur_v = pnl_at(cur_S);
        if ((prev_v < 0.0 && cur_v > 0.0) || (prev_v > 0.0 && cur_v < 0.0)) {
            // Linear interpolation for the zero crossing.
            const double frac = prev_v / (prev_v - cur_v);
            result.push_back(prev_S + frac * (cur_S - prev_S));
        } else if (cur_v == 0.0) {
            result.push_back(cur_S);
        }
        prev_S = cur_S;
        prev_v = cur_v;
    }
    return result;
}

inline Result compute(const std::vector<Leg>& legs, const Scenario& s) {
    Result out{};
    out.rows = s.price_steps;
    out.cols = s.day_steps;
    out.price_axis = linspace(s.price_min, s.price_max, s.price_steps);
    out.day_axis   = linspace(s.days_min,  s.days_max,  s.day_steps);
    out.pnl.assign(static_cast<std::size_t>(s.price_steps) * static_cast<std::size_t>(s.day_steps), 0.0);

    if (legs.empty() || s.price_steps == 0 || s.day_steps == 0) {
        out.max_profit = 0.0;
        out.max_loss = 0.0;
        out.profit_pct = 0.0;
        out.net_premium = 0.0;
        out.net_delta = out.net_gamma = out.net_vega = out.net_theta = 0.0;
        return out;
    }

    // For each (i, j), compute net P&L. j here is the day index from days_min
    // (start of horizon) to days_max (end). Days-remaining for a given leg is
    // (leg.expiration_days - day_axis[j]).
    double max_p = -std::numeric_limits<double>::infinity();
    double min_p =  std::numeric_limits<double>::infinity();
    std::size_t pos_count = 0;
    const std::size_t total = static_cast<std::size_t>(s.price_steps) * s.day_steps;

    for (uint32_t i = 0; i < s.price_steps; ++i) {
        const double S = out.price_axis[i];
        for (uint32_t j = 0; j < s.day_steps; ++j) {
            const double day = out.day_axis[j];
            double sum = 0.0;
            for (const auto& l : legs) {
                const double days_rem = std::max(l.expiration_days - day, 0.0);
                sum += leg_value(l, S, days_rem, s.rate, s.vol);
            }
            out.pnl[static_cast<std::size_t>(i) * s.day_steps + j] = sum;
            if (sum > max_p) max_p = sum;
            if (sum < min_p) min_p = sum;
            if (sum > 0.0) ++pos_count;
        }
    }

    out.max_profit = max_p;
    out.max_loss = min_p;
    out.profit_pct = (total > 0)
        ? 100.0 * static_cast<double>(pos_count) / static_cast<double>(total)
        : 0.0;
    out.net_premium = net_premium(legs);

    // Breakevens along the price axis at j = cols - 1 (latest day in horizon).
    out.breakeven_prices = find_breakevens_at_t(
        legs, s.rate, /*days_remaining_at_horizon_end=*/0.0, s.vol, out.price_axis);

    // Real probability-of-profit at horizon, under risk-neutral lognormal:
    //   S_T ~ LogNormal(log(S0) + (r - 0.5σ²) T, σ √T)
    // Use the chain's at-the-money baseline IV as the diffusion vol — i.e.
    // average leg IV, since we don't have a separate "scenario underlying
    // vol" field. That matches the chain's smile when shock=0 and shifts
    // with the slider when shock != 0.
    {
        double avg_iv = 0.0;
        for (const auto& l : legs) avg_iv += l.iv;
        avg_iv = legs.empty() ? 0.20 : (avg_iv / static_cast<double>(legs.size()));
        const double sigma = std::max(0.01, avg_iv + s.vol);  // shock applies here too
        const double T = std::max(s.days_max - s.days_min, 1.0) / 365.0;
        const double mu = std::log(std::max(s.spot, 1e-6))
                          + (s.rate - 0.5 * sigma * sigma) * T;
        const double denom = sigma * std::sqrt(T);

        // Numerical-integrate the lognormal density over the price grid at
        // j = cols-1 (horizon). Trapezoid rule, weighted by P&L > 0.
        const uint32_t j_horizon = s.day_steps - 1;
        const double dp = (s.price_steps > 1)
            ? (s.price_max - s.price_min) / static_cast<double>(s.price_steps - 1)
            : 0.0;

        auto pdf = [&](double S) -> double {
            if (S <= 0.0 || denom <= 0.0) return 0.0;
            const double z = (std::log(S) - mu) / denom;
            return std::exp(-0.5 * z * z) / (S * denom * std::sqrt(2.0 * M_PI));
        };

        double total = 0.0, profit = 0.0;
        for (uint32_t i = 0; i < s.price_steps; ++i) {
            const double S = out.price_axis[i];
            const double w = pdf(S) * dp;
            total += w;
            if (out.pnl[static_cast<std::size_t>(i) * s.day_steps + j_horizon] > 0.0) {
                profit += w;
            }
        }
        out.pop_at_horizon = (total > 0.0) ? 100.0 * profit / total : 0.0;
    }

    // Net Greeks at scenario spot (t = expiration_days for each leg).
    out.net_delta = out.net_gamma = out.net_vega = out.net_theta = 0.0;
    for (const auto& l : legs) {
        const double t = std::max(l.expiration_days, 1e-6) / 365.0;
        const double iv = effective_iv(l.iv, s.vol);
        bs::OptionSpec spec{s.spot, l.strike, iv, s.rate, t};
        auto p = bs::price(spec);
        if (std::isnan(p.call_price)) continue;
        const double sign = (l.side == Side::Buy) ? +1.0 : -1.0;
        const double mult = sign * static_cast<double>(l.units) * 100.0;
        // Greeks above are for a CALL (per black_scholes.h convention). For PUT,
        // delta_put = delta_call - 1; gamma/vega same; theta differs slightly
        // (we omit dividends so put theta = call theta + r*K*exp(-rT)).
        double delta = p.greeks.delta;
        double theta = p.greeks.theta;
        if (l.kind == Kind::Put) {
            delta = delta - 1.0;
            theta = theta + s.rate * l.strike * std::exp(-s.rate * t);
        }
        out.net_delta += mult * delta;
        out.net_gamma += mult * p.greeks.gamma;
        out.net_vega  += mult * p.greeks.vega;
        out.net_theta += mult * theta;
    }

    return out;
}

}  // namespace strat
