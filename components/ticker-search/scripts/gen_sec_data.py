#!/usr/bin/env python3
"""Regenerate src/sec_data.rs from data/sec_tickers.json."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INPUT  = os.path.join(ROOT, "data", "sec_tickers.json")
OUTPUT = os.path.join(ROOT, "src",  "sec_data.rs")

def main():
    with open(INPUT) as f:
        src = json.load(f)
    rows = sorted({(v["ticker"], v["title"].strip()) for v in src.values()})
    out = [
        "// AUTO-GENERATED from data/sec_tickers.json. Do not edit by hand.",
        "// Regenerate with: make -C components/ticker-search regen-data",
        "",
        "pub const SEC_TICKERS: &[(&str, &str)] = &[",
    ]
    for t, n in rows:
        t_e = t.replace("\\", "\\\\").replace('"', '\\"')
        n_e = n.replace("\\", "\\\\").replace('"', '\\"')
        out.append(f'    ("{t_e}", "{n_e}"),')
    out.append("];")
    out.append("")
    with open(OUTPUT, "w") as f:
        f.write("\n".join(out))
    print(f"wrote {len(rows)} rows -> {OUTPUT}")

if __name__ == "__main__":
    main()
