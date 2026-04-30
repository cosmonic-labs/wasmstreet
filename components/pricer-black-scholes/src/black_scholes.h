#pragma once
// Black-Scholes closed-form European option pricing + Greeks.
// Pure C++ — no WASI types, native-testable.

#include <cmath>

namespace bs {

struct OptionSpec {
    double spot;    // S
    double strike;  // K
    double vol;     // sigma (annualized)
    double rate;    // r (continuous, annualized)
    double time;    // T (years)
};

struct Greeks {
    double delta;
    double gamma;
    double vega;
    double theta;   // per year
    double rho;
};

struct Pricing {
    double call_price;
    double put_price;
    Greeks greeks;
};

// Standard normal CDF via std::erf. -fno-exceptions safe.
inline double norm_cdf(double x) {
    return 0.5 * (1.0 + std::erf(x / std::sqrt(2.0)));
}

// Standard normal PDF.
inline double norm_pdf(double x) {
    static constexpr double inv_sqrt_2pi = 0.3989422804014327;
    return inv_sqrt_2pi * std::exp(-0.5 * x * x);
}

// Compute call/put prices and the five Greeks.
//
// Returns NaN-filled struct on degenerate inputs (non-positive spot/strike,
// non-positive time, non-positive vol). Caller checks std::isnan(call_price).
inline Pricing price(const OptionSpec& s) {
    Pricing out{};
    if (!(s.spot > 0.0) || !(s.strike > 0.0) || !(s.time > 0.0) || !(s.vol > 0.0)) {
        out.call_price = std::nan("");
        out.put_price  = std::nan("");
        return out;
    }
    const double sqrtT  = std::sqrt(s.time);
    const double d1 = (std::log(s.spot / s.strike) + (s.rate + 0.5 * s.vol * s.vol) * s.time)
                       / (s.vol * sqrtT);
    const double d2 = d1 - s.vol * sqrtT;

    const double Nd1 = norm_cdf(d1);
    const double Nd2 = norm_cdf(d2);
    const double Nmd1 = norm_cdf(-d1);
    const double Nmd2 = norm_cdf(-d2);
    const double pdf_d1 = norm_pdf(d1);

    const double disc  = std::exp(-s.rate * s.time);

    out.call_price = s.spot * Nd1 - s.strike * disc * Nd2;
    out.put_price  = s.strike * disc * Nmd2 - s.spot * Nmd1;

    // Greeks for the CALL (the canonical convention).
    out.greeks.delta = Nd1;
    out.greeks.gamma = pdf_d1 / (s.spot * s.vol * sqrtT);
    out.greeks.vega  = s.spot * pdf_d1 * sqrtT;                                // per 1.0 vol
    out.greeks.theta = -(s.spot * pdf_d1 * s.vol) / (2.0 * sqrtT)
                        - s.rate * s.strike * disc * Nd2;                       // per year
    out.greeks.rho   = s.strike * s.time * disc * Nd2;                          // per 1.0 rate

    return out;
}

}  // namespace bs
