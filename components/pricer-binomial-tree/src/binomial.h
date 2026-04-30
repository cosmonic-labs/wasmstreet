#pragma once
// Cox-Ross-Rubinstein binomial tree for European and American options.
// Pure C++ — no WASI deps, native-testable.
//
// The tree is recombining: at level n there are n+1 nodes. We store the option
// value v[n][i] for level n (0 <= n <= steps) and node i (0 <= i <= n) in a
// flat triangular array indexed as n*(n+1)/2 + i. Same layout for the spot
// prices at each node.

#include <cmath>
#include <cstdint>
#include <vector>

namespace bt {

enum class OptionType { Call, Put };

struct OptionSpec {
    double spot;
    double strike;
    double vol;
    double rate;
    double time;
};

struct Spec {
    OptionSpec underlying;
    uint32_t steps;
    bool american;
    OptionType kind;
};

struct Result {
    double price;
    uint32_t steps;
    std::vector<double> node_values;  // size (steps+1)*(steps+2)/2
    std::vector<double> node_spots;
};

inline std::size_t tri_size(uint32_t steps) {
    return (static_cast<std::size_t>(steps) + 1) * (static_cast<std::size_t>(steps) + 2) / 2;
}

inline std::size_t tri_idx(uint32_t n, uint32_t i) {
    return static_cast<std::size_t>(n) * (n + 1) / 2 + i;
}

inline bool valid(const Spec& s) {
    return s.underlying.spot > 0.0 && s.underlying.strike > 0.0
           && s.underlying.vol > 0.0 && s.underlying.time > 0.0
           && s.steps > 0;
}

inline double payoff(OptionType k, double S, double K) {
    if (k == OptionType::Call) return (S > K) ? (S - K) : 0.0;
    return (K > S) ? (K - S) : 0.0;
}

// Price a CRR tree. Fills node_values and node_spots, both of size tri_size(steps).
inline Result price(const Spec& s) {
    Result out{};
    out.steps = s.steps;
    if (!valid(s)) {
        out.price = std::nan("");
        return out;
    }

    const uint32_t N = s.steps;
    const double dt = s.underlying.time / static_cast<double>(N);
    const double u  = std::exp(s.underlying.vol * std::sqrt(dt));
    const double d  = 1.0 / u;
    const double r  = s.underlying.rate;
    const double disc = std::exp(-r * dt);
    const double p  = (std::exp(r * dt) - d) / (u - d);
    if (p <= 0.0 || p >= 1.0) {
        out.price = std::nan("");
        return out;
    }

    const std::size_t total = tri_size(N);
    out.node_values.assign(total, 0.0);
    out.node_spots .assign(total, 0.0);

    // Forward pass: spot at every node.
    for (uint32_t n = 0; n <= N; ++n) {
        for (uint32_t i = 0; i <= n; ++i) {
            // Node (n, i) means i down-moves and (n - i) up-moves from S0.
            const double S = s.underlying.spot * std::pow(u, static_cast<double>(n - i))
                                                * std::pow(d, static_cast<double>(i));
            out.node_spots[tri_idx(n, i)] = S;
        }
    }

    // Terminal payoff.
    for (uint32_t i = 0; i <= N; ++i) {
        const double S = out.node_spots[tri_idx(N, i)];
        out.node_values[tri_idx(N, i)] = payoff(s.kind, S, s.underlying.strike);
    }

    // Backward induction.
    for (int32_t n = static_cast<int32_t>(N) - 1; n >= 0; --n) {
        for (uint32_t i = 0; i <= static_cast<uint32_t>(n); ++i) {
            const double v_up   = out.node_values[tri_idx(n + 1, i)];
            const double v_down = out.node_values[tri_idx(n + 1, i + 1)];
            double cont = disc * (p * v_up + (1.0 - p) * v_down);
            if (s.american) {
                const double S = out.node_spots[tri_idx(n, i)];
                const double exercise = payoff(s.kind, S, s.underlying.strike);
                if (exercise > cont) cont = exercise;
            }
            out.node_values[tri_idx(n, i)] = cont;
        }
    }

    out.price = out.node_values[tri_idx(0, 0)];
    return out;
}

}  // namespace bt
