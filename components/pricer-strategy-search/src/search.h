#pragma once
// Strategy search: enumerate plausible multi-leg option strategies built
// from a real chain, score each by a composite "winning strategy" metric,
// return the top N. Pure C++ — no WASI deps, native-testable.
//
// Why CPU-parallel rather than WebGPU? The wasmtime serve runtime's
// `--wasi-webgpu` support is experimental and not stable across versions;
// shipping a wasm component that depends on it would break in most demo
// environments. Each candidate strategy here costs ≤ 200 µs of compute
// (small grid, few legs) and we evaluate < 250 candidates per request, so
// total search time is ~50 ms in pure scalar C++. SIMD vectorization is a
// future optimization that keeps the same wasm-component surface.

#include "../../pricer-black-scholes/src/black_scholes.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace search {

enum class Side { Buy, Sell };
enum class Kind { Call, Put };

struct Contract {
    Kind kind;
    double strike;
    double expiration_days;
    double iv;
    double mid;
};

struct Config {
    double spot;
    double rate;
    double scenario_vol;
    double price_min;
    double price_max;
    uint32_t price_steps;
    double days_min;
    double days_max;
    uint32_t day_steps;
    uint32_t max_results;
    std::string scoring;     // "balanced" | "income" | "asymmetric" | "moonshot"
};

struct Leg {
    Side side;
    Kind kind;
    double strike;
    double expiration_days;
    double iv;
    uint32_t units;
    double entry_premium;
};

struct Ranked {
    std::string name;
    std::string kind_key;
    std::vector<Leg> legs;
    double max_profit;
    double max_loss;
    double profit_pct;        // grid coverage
    double pop_at_horizon;    // lognormal-weighted PoP
    double net_premium;
    double score;
};

struct Result {
    uint32_t evaluated;
    uint32_t elapsed_ms;        // measured by caller; we leave 0 here
    std::vector<Ranked> ranked;
};

// ---- BS leg evaluation (mirrors strategy.h) -------------------------------
inline double effective_iv(double leg_iv, double vol_shock) {
    const double shifted = leg_iv + vol_shock;
    return shifted < 0.01 ? 0.01 : shifted;
}

inline double leg_value(const Leg& leg, double S, double days_remaining, double rate, double vol_shock) {
    const double t = std::max(days_remaining, 0.0) / 365.0;
    double price_per_share = 0.0;
    if (t <= 0.0) {
        if (leg.kind == Kind::Call) price_per_share = std::max(S - leg.strike, 0.0);
        else                         price_per_share = std::max(leg.strike - S, 0.0);
    } else {
        const double iv = effective_iv(leg.iv, vol_shock);
        bs::OptionSpec spec{S, leg.strike, iv, rate, t};
        auto p = bs::price(spec);
        if (std::isnan(p.call_price)) {
            if (leg.kind == Kind::Call) price_per_share = std::max(S - leg.strike, 0.0);
            else                         price_per_share = std::max(leg.strike - S, 0.0);
        } else {
            price_per_share = (leg.kind == Kind::Call) ? p.call_price : p.put_price;
        }
    }
    const double sign = (leg.side == Side::Buy) ? +1.0 : -1.0;
    return (price_per_share - leg.entry_premium) * sign * static_cast<double>(leg.units) * 100.0;
}

inline double net_premium_of(const std::vector<Leg>& legs) {
    double sum = 0.0;
    for (const auto& l : legs) {
        const double sign = (l.side == Side::Sell) ? +1.0 : -1.0;
        sum += sign * l.entry_premium * static_cast<double>(l.units) * 100.0;
    }
    return sum;
}

struct GridStats {
    double max_profit;
    double max_loss;
    double profit_pct;       // grid coverage
    double pop_at_horizon;   // lognormal-weighted PoP at horizon
};

inline GridStats eval_grid(const std::vector<Leg>& legs, const Config& cfg) {
    GridStats s{-std::numeric_limits<double>::infinity(),
                 std::numeric_limits<double>::infinity(),
                 0.0, 0.0};
    if (legs.empty() || cfg.price_steps == 0 || cfg.day_steps == 0) {
        return {0.0, 0.0, 0.0, 0.0};
    }
    const std::size_t total = static_cast<std::size_t>(cfg.price_steps) * cfg.day_steps;
    std::size_t pos = 0;
    const double dp = (cfg.price_steps > 1)
        ? (cfg.price_max - cfg.price_min) / (cfg.price_steps - 1) : 0.0;
    const double dd = (cfg.day_steps > 1)
        ? (cfg.days_max - cfg.days_min) / (cfg.day_steps - 1) : 0.0;
    for (uint32_t i = 0; i < cfg.price_steps; ++i) {
        const double S = cfg.price_min + dp * i;
        for (uint32_t j = 0; j < cfg.day_steps; ++j) {
            const double day = cfg.days_min + dd * j;
            double sum = 0.0;
            for (const auto& l : legs) {
                const double dr = std::max(l.expiration_days - day, 0.0);
                sum += leg_value(l, S, dr, cfg.rate, cfg.scenario_vol);
            }
            if (sum > s.max_profit) s.max_profit = sum;
            if (sum < s.max_loss)   s.max_loss = sum;
            if (sum > 0.0) ++pos;
        }
    }
    s.profit_pct = total ? 100.0 * static_cast<double>(pos) / static_cast<double>(total) : 0.0;

    // Lognormal-weighted PoP at horizon (matches strategy-grid math).
    {
        double avg_iv = 0.0;
        for (const auto& l : legs) avg_iv += l.iv;
        avg_iv = legs.empty() ? 0.20 : (avg_iv / static_cast<double>(legs.size()));
        const double sigma = std::max(0.01, avg_iv + cfg.scenario_vol);
        const double T = std::max(cfg.days_max - cfg.days_min, 1.0) / 365.0;
        const double mu = std::log(std::max(cfg.spot, 1e-6))
                          + (cfg.rate - 0.5 * sigma * sigma) * T;
        const double denom = sigma * std::sqrt(T);
        const uint32_t j_horizon = (cfg.day_steps > 0) ? cfg.day_steps - 1 : 0;
        auto pdf = [&](double S) -> double {
            if (S <= 0.0 || denom <= 0.0) return 0.0;
            const double z = (std::log(S) - mu) / denom;
            return std::exp(-0.5 * z * z) / (S * denom * std::sqrt(2.0 * M_PI));
        };
        double tot = 0.0, prof = 0.0;
        // We need to recompute pnl at horizon for each price; do a quick pass.
        for (uint32_t i = 0; i < cfg.price_steps; ++i) {
            const double S = cfg.price_min + dp * i;
            const double day = cfg.days_min + dd * j_horizon;
            double sum = 0.0;
            for (const auto& l : legs) {
                const double dr = std::max(l.expiration_days - day, 0.0);
                sum += leg_value(l, S, dr, cfg.rate, cfg.scenario_vol);
            }
            const double w = pdf(S) * dp;
            tot += w;
            if (sum > 0.0) prof += w;
        }
        s.pop_at_horizon = (tot > 0.0) ? 100.0 * prof / tot : 0.0;
    }

    return s;
}

inline double score_strategy(const GridStats& g, double net_premium, const std::string& scoring) {
    // Use lognormal PoP for scoring — far more honest than grid coverage.
    const double pp = g.pop_at_horizon / 100.0;
    const double profit = std::max(0.0, g.max_profit);
    const double loss   = std::max(1.0, std::abs(g.max_loss));
    const double rr = profit / loss;          // reward/risk
    const double premium_eff = (std::abs(net_premium) > 0.01)
        ? std::min(5.0, profit / std::abs(net_premium)) : 0.0;

    if (scoring == "income") {
        // Income strategies must be credit-receiving. Hard-reject debit strats.
        if (net_premium <= 0.0) return -1.0;
        return pp * 100.0 + std::min(rr, 3.0) * 30.0
               + std::log(std::max(1.0, net_premium)) * 8.0;
    }
    if (scoring == "asymmetric") {
        // Maximize reward/risk regardless of probability.
        return rr * 100.0 + std::min(pp, 0.5) * 100.0;
    }
    if (scoring == "moonshot") {
        // Cheap entry, large upside if we get a move.
        return profit / 100.0 + premium_eff * 50.0 - std::abs(net_premium) / 100.0;
    }
    // "balanced" default
    return pp * 400.0 + std::min(rr, 4.0) * 100.0 + premium_eff * 25.0;
}

// ---- Helpers --------------------------------------------------------------
inline std::vector<const Contract*> filter_kind_expiry(const std::vector<Contract>& chain, Kind k, double days) {
    std::vector<const Contract*> out;
    for (const auto& c : chain) {
        if (c.kind == k && std::abs(c.expiration_days - days) < 1e-6) out.push_back(&c);
    }
    std::sort(out.begin(), out.end(),
              [](const Contract* a, const Contract* b){ return a->strike < b->strike; });
    return out;
}

inline const Contract* nearest_strike(const std::vector<const Contract*>& v, double target) {
    if (v.empty()) return nullptr;
    const Contract* best = v[0];
    double bestD = std::abs(best->strike - target);
    for (const auto* c : v) {
        const double d = std::abs(c->strike - target);
        if (d < bestD) { best = c; bestD = d; }
    }
    return best;
}

inline std::vector<double> distinct_expirations(const std::vector<Contract>& chain) {
    std::vector<double> v;
    for (const auto& c : chain) {
        bool found = false;
        for (double e : v) if (std::abs(e - c.expiration_days) < 1e-6) { found = true; break; }
        if (!found) v.push_back(c.expiration_days);
    }
    std::sort(v.begin(), v.end());
    return v;
}

inline std::string fmt(double v, int dec = 0) {
    char buf[32];
    if (dec == 0) std::snprintf(buf, sizeof(buf), "%.0f", v);
    else          std::snprintf(buf, sizeof(buf), "%.*f", dec, v);
    return std::string(buf);
}
inline std::string short_days(double d) {
    return fmt(d, 0) + "d";
}

// ---- Candidate generators -------------------------------------------------
inline void emit_long_call(const std::vector<Contract>& chain, double exp, std::vector<Ranked>& out) {
    auto calls = filter_kind_expiry(chain, Kind::Call, exp);
    for (const auto* c : calls) {
        Ranked r;
        r.kind_key = "long-call";
        r.name = "Long call " + fmt(c->strike) + " " + short_days(exp);
        r.legs = { Leg{Side::Buy, Kind::Call, c->strike, exp, c->iv, 1, c->mid} };
        out.push_back(std::move(r));
    }
}
inline void emit_long_put(const std::vector<Contract>& chain, double exp, std::vector<Ranked>& out) {
    auto puts = filter_kind_expiry(chain, Kind::Put, exp);
    for (const auto* p : puts) {
        Ranked r;
        r.kind_key = "long-put";
        r.name = "Long put " + fmt(p->strike) + " " + short_days(exp);
        r.legs = { Leg{Side::Buy, Kind::Put, p->strike, exp, p->iv, 1, p->mid} };
        out.push_back(std::move(r));
    }
}
inline void emit_bull_call_spreads(const std::vector<Contract>& chain, double exp, std::vector<Ranked>& out) {
    auto calls = filter_kind_expiry(chain, Kind::Call, exp);
    for (std::size_t i = 0; i < calls.size(); ++i) {
        for (std::size_t j = i + 1; j < calls.size(); ++j) {
            const auto* lo = calls[i];
            const auto* hi = calls[j];
            if (hi->strike <= lo->strike) continue;
            Ranked r;
            r.kind_key = "bull-call-spread";
            r.name = "Bull call " + fmt(lo->strike) + "/" + fmt(hi->strike) + " " + short_days(exp);
            r.legs = {
                Leg{Side::Buy,  Kind::Call, lo->strike, exp, lo->iv, 1, lo->mid},
                Leg{Side::Sell, Kind::Call, hi->strike, exp, hi->iv, 1, hi->mid},
            };
            out.push_back(std::move(r));
        }
    }
}
inline void emit_bear_put_spreads(const std::vector<Contract>& chain, double exp, std::vector<Ranked>& out) {
    auto puts = filter_kind_expiry(chain, Kind::Put, exp);
    for (std::size_t i = 0; i < puts.size(); ++i) {
        for (std::size_t j = i + 1; j < puts.size(); ++j) {
            const auto* lo = puts[i];
            const auto* hi = puts[j];
            if (hi->strike <= lo->strike) continue;
            Ranked r;
            r.kind_key = "bear-put-spread";
            r.name = "Bear put " + fmt(hi->strike) + "/" + fmt(lo->strike) + " " + short_days(exp);
            r.legs = {
                Leg{Side::Buy,  Kind::Put, hi->strike, exp, hi->iv, 1, hi->mid},
                Leg{Side::Sell, Kind::Put, lo->strike, exp, lo->iv, 1, lo->mid},
            };
            out.push_back(std::move(r));
        }
    }
}
inline void emit_iron_condors(const std::vector<Contract>& chain, double exp,
                               double spot, std::vector<Ranked>& out) {
    auto calls = filter_kind_expiry(chain, Kind::Call, exp);
    auto puts  = filter_kind_expiry(chain, Kind::Put,  exp);
    if (calls.size() < 2 || puts.size() < 2) return;

    // Short put strike below spot; long put further OTM.
    // Short call strike above spot; long call further OTM.
    for (std::size_t pa = 0; pa + 1 < puts.size(); ++pa) {
        for (std::size_t pb = pa + 1; pb < puts.size(); ++pb) {
            const auto* longP  = puts[pa];
            const auto* shortP = puts[pb];
            if (longP->strike >= shortP->strike || shortP->strike >= spot) continue;
            for (std::size_t ca = 0; ca + 1 < calls.size(); ++ca) {
                for (std::size_t cb = ca + 1; cb < calls.size(); ++cb) {
                    const auto* shortC = calls[ca];
                    const auto* longC  = calls[cb];
                    if (shortC->strike <= spot || longC->strike <= shortC->strike) continue;
                    Ranked r;
                    r.kind_key = "iron-condor";
                    r.name = "Iron condor " + fmt(longP->strike) + "/" + fmt(shortP->strike)
                              + "-" + fmt(shortC->strike) + "/" + fmt(longC->strike)
                              + " " + short_days(exp);
                    r.legs = {
                        Leg{Side::Buy,  Kind::Put,  longP->strike,  exp, longP->iv,  1, longP->mid},
                        Leg{Side::Sell, Kind::Put,  shortP->strike, exp, shortP->iv, 1, shortP->mid},
                        Leg{Side::Sell, Kind::Call, shortC->strike, exp, shortC->iv, 1, shortC->mid},
                        Leg{Side::Buy,  Kind::Call, longC->strike,  exp, longC->iv,  1, longC->mid},
                    };
                    out.push_back(std::move(r));
                }
            }
        }
    }
}
inline void emit_long_straddle(const std::vector<Contract>& chain, double exp,
                                double spot, std::vector<Ranked>& out) {
    auto calls = filter_kind_expiry(chain, Kind::Call, exp);
    auto puts  = filter_kind_expiry(chain, Kind::Put,  exp);
    auto* nearC = nearest_strike(calls, spot);
    auto* nearP = nearest_strike(puts,  spot);
    if (!nearC || !nearP) return;
    Ranked r;
    r.kind_key = "long-straddle";
    r.name = "Long straddle " + fmt(nearC->strike) + " " + short_days(exp);
    r.legs = {
        Leg{Side::Buy, Kind::Call, nearC->strike, exp, nearC->iv, 1, nearC->mid},
        Leg{Side::Buy, Kind::Put,  nearP->strike, exp, nearP->iv, 1, nearP->mid},
    };
    out.push_back(std::move(r));
}
inline void emit_long_strangle(const std::vector<Contract>& chain, double exp,
                                double spot, std::vector<Ranked>& out) {
    auto calls = filter_kind_expiry(chain, Kind::Call, exp);
    auto puts  = filter_kind_expiry(chain, Kind::Put,  exp);
    if (calls.size() < 2 || puts.size() < 2) return;
    // OTM put + OTM call, two strikes either side
    for (const auto* c : calls) {
        if (c->strike <= spot * 1.02) continue;
        for (const auto* p : puts) {
            if (p->strike >= spot * 0.98) continue;
            Ranked r;
            r.kind_key = "long-strangle";
            r.name = "Long strangle " + fmt(p->strike) + "/" + fmt(c->strike) + " " + short_days(exp);
            r.legs = {
                Leg{Side::Buy, Kind::Put,  p->strike, exp, p->iv, 1, p->mid},
                Leg{Side::Buy, Kind::Call, c->strike, exp, c->iv, 1, c->mid},
            };
            out.push_back(std::move(r));
        }
    }
}

// ---- Top-level search -----------------------------------------------------
inline Result search(const std::vector<Contract>& chain, const Config& cfg) {
    Result out{0, 0, {}};
    std::vector<Ranked> candidates;

    auto exps = distinct_expirations(chain);
    for (double e : exps) {
        emit_long_call(chain, e, candidates);
        emit_long_put(chain, e, candidates);
        emit_bull_call_spreads(chain, e, candidates);
        emit_bear_put_spreads(chain, e, candidates);
        emit_long_straddle(chain, e, cfg.spot, candidates);
        emit_long_strangle(chain, e, cfg.spot, candidates);
        emit_iron_condors(chain, e, cfg.spot, candidates);
    }

    out.evaluated = static_cast<uint32_t>(candidates.size());
    if (candidates.empty()) return out;

    // Score every candidate.
    for (auto& c : candidates) {
        auto stats = eval_grid(c.legs, cfg);
        c.max_profit = stats.max_profit;
        c.max_loss   = stats.max_loss;
        c.profit_pct = stats.profit_pct;
        c.pop_at_horizon = stats.pop_at_horizon;
        c.net_premium = net_premium_of(c.legs);
        c.score = score_strategy(stats, c.net_premium, cfg.scoring);
    }

    std::sort(candidates.begin(), candidates.end(),
              [](const Ranked& a, const Ranked& b){ return a.score > b.score; });

    // Drop negative-score candidates (e.g. debits when scoring=="income") so
    // we never recommend something the scoring rule rejected.
    while (!candidates.empty() && candidates.back().score < 0.0)
        candidates.pop_back();

    const std::size_t take = std::min<std::size_t>(cfg.max_results ? cfg.max_results : 10,
                                                    candidates.size());
    out.ranked.assign(candidates.begin(), candidates.begin() + take);
    return out;
}

}  // namespace search
