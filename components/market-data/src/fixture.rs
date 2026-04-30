// fixture.rs — static stock metadata for the offline path.
//
// When Yahoo is unreachable we still want a believable demo. The fixture
// returns plausible spot prices for a small set of well-known tickers;
// `synth.rs` then builds the full chain around it.

use crate::yahoo::ParsedQuote;

const STOCKS: &[(&str, &str, f64, f64)] = &[
    // (ticker, long-name, spot, previous-close)
    ("AAPL", "Apple Inc.",                      192.45, 190.67),
    ("MSFT", "Microsoft Corporation",           412.31, 410.55),
    ("GOOGL","Alphabet Inc. Class A",           158.42, 157.91),
    ("AMZN", "Amazon.com, Inc.",                187.10, 184.62),
    ("META", "Meta Platforms, Inc.",            512.34, 506.78),
    ("NVDA", "NVIDIA Corporation",              135.20, 131.46),
    ("TSLA", "Tesla, Inc.",                     188.10, 186.55),
    ("AMD",  "Advanced Micro Devices, Inc.",    156.20, 154.00),
    ("NFLX", "Netflix, Inc.",                   639.72, 632.10),
    ("AVGO", "Broadcom Inc.",                  1342.15, 1325.50),
    ("SPY",  "SPDR S&P 500 ETF Trust",          524.30, 521.80),
    ("QQQ",  "Invesco QQQ Trust",               446.80, 444.10),
    ("IWM",  "iShares Russell 2000 ETF",        202.45, 201.10),
    ("DIA",  "SPDR Dow Jones Industrial",       399.20, 397.45),
    ("VTI",  "Vanguard Total Stock Market ETF", 256.80, 255.40),
];

pub fn lookup(ticker: &str) -> Option<ParsedQuote> {
    let upper = ticker.to_uppercase();
    STOCKS.iter().find(|(s, _, _, _)| *s == upper).map(|(s, n, sp, pc)| {
        let day_change = sp - pc;
        let day_change_pct = if *pc > 0.0 { (day_change / pc) * 100.0 } else { 0.0 };
        ParsedQuote {
            ticker: (*s).to_string(),
            name: (*n).to_string(),
            spot: *sp,
            previous_close: *pc,
            day_change,
            day_change_pct,
            as_of_unix: 1714408800, // a fixed reference for offline
        }
    })
}
