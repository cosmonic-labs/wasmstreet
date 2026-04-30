#pragma once
// Monte Carlo simulation for arithmetic-average Asian call options.
// Pure C++ — no WASI deps, native-testable.
//
// Streaming: paths are simulated one at a time and only the discounted payoff
// is accumulated. Memory is O(num_steps) for the running path, plus a small
// downsampled snapshot of the first N paths for visualization (50x50 default).

#include <cmath>
#include <cstdint>
#include <random>
#include <vector>

namespace mc {

struct OptionSpec {
    double spot;
    double strike;
    double vol;
    double rate;
    double time;
};

struct McSpec {
    OptionSpec option;
    uint32_t num_paths;
    uint32_t num_steps;
    uint64_t seed;
};

struct McResult {
    double price;
    double std_error;
    std::vector<std::vector<double>> sample_paths;  // viz_paths × viz_steps
    uint32_t num_paths;
    uint32_t num_steps;
};

namespace detail {
    constexpr uint32_t VIZ_PATHS = 50;
    constexpr uint32_t VIZ_STEPS = 50;
}

// Validate inputs without throwing (we are -fno-exceptions).
inline bool valid(const McSpec& s) {
    const auto& o = s.option;
    return o.spot > 0.0 && o.strike > 0.0 && o.vol > 0.0 && o.time > 0.0
           && s.num_paths > 0 && s.num_steps > 0;
}

// Run the simulation.
//
// On invalid input: returns NaN price.
inline McResult simulate(const McSpec& s) {
    McResult out{};
    out.num_paths = s.num_paths;
    out.num_steps = s.num_steps;

    if (!valid(s)) {
        out.price = std::nan("");
        out.std_error = std::nan("");
        return out;
    }

    const double dt    = s.option.time / static_cast<double>(s.num_steps);
    const double drift = (s.option.rate - 0.5 * s.option.vol * s.option.vol) * dt;
    const double diff  = s.option.vol * std::sqrt(dt);
    const double disc  = std::exp(-s.option.rate * s.option.time);

    std::mt19937_64 rng(s.seed ? s.seed : 0x9E3779B97F4A7C15ULL);
    std::normal_distribution<double> normal(0.0, 1.0);

    // Pre-allocate path storage for the visualization snapshot.
    const uint32_t viz_paths = std::min<uint32_t>(detail::VIZ_PATHS, s.num_paths);
    const uint32_t viz_steps = std::min<uint32_t>(detail::VIZ_STEPS, s.num_steps);
    out.sample_paths.assign(viz_paths, std::vector<double>(viz_steps, 0.0));
    // Step subsampling: pick `viz_steps` indices roughly uniformly.
    // step_idx_of(k) maps k in [0, viz_steps) to a step in [0, num_steps-1].
    const uint32_t denom = (viz_steps > 1) ? (viz_steps - 1) : 1;
    auto step_idx_of = [&](uint32_t k) -> uint32_t {
        if (viz_steps <= 1 || s.num_steps <= 1) return s.num_steps - 1;
        // Integer math to avoid std::round dependencies.
        return (k * (s.num_steps - 1) + (denom / 2)) / denom;
    };

    double sum_payoff   = 0.0;
    double sum_payoff_2 = 0.0;

    std::vector<double> current_path;
    current_path.reserve(s.num_steps);

    for (uint32_t i = 0; i < s.num_paths; ++i) {
        double S = s.option.spot;
        double running_sum = 0.0;
        const bool record = i < viz_paths;
        if (record) current_path.clear();

        for (uint32_t k = 0; k < s.num_steps; ++k) {
            const double z = normal(rng);
            S *= std::exp(drift + diff * z);
            running_sum += S;
            if (record) current_path.push_back(S);
        }

        const double avg = running_sum / static_cast<double>(s.num_steps);
        const double payoff = std::max(avg - s.option.strike, 0.0);
        sum_payoff   += payoff;
        sum_payoff_2 += payoff * payoff;

        if (record) {
            for (uint32_t k = 0; k < viz_steps; ++k) {
                const uint32_t idx = step_idx_of(k);
                out.sample_paths[i][k] = current_path[idx];
            }
        }
    }

    const double n    = static_cast<double>(s.num_paths);
    const double mean = sum_payoff / n;
    out.price = disc * mean;

    if (s.num_paths > 1) {
        const double var = (sum_payoff_2 - n * mean * mean) / (n - 1.0);
        const double sem = (var > 0.0) ? std::sqrt(var / n) : 0.0;
        out.std_error = disc * sem;
    } else {
        out.std_error = 0.0;
    }

    return out;
}

}  // namespace mc
