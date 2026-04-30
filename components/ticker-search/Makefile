# ticker-search — Rust component (cargo-driven, no WASI SDK needed).

WASM_TARGET := target/wasm32-wasip2/release/ticker_search.wasm

.PHONY: all wasm test clean regen-data

all: wasm

wasm:
	cargo build --target wasm32-wasip2 --release

test:
	cargo test --lib

# Refresh the baked SEC table from the live SEC EDGAR file. The output
# (data/sec_tickers.json + src/sec_data.rs) is committed; this is a
# manual one-time refresh, not a per-build step. SEC requires a
# descriptive User-Agent or it'll 403.
SEC_URL := https://www.sec.gov/files/company_tickers.json
SEC_UA  := WasmStreet Demo dev@example.com

regen-data:
	@mkdir -p data
	curl -sf -H 'User-Agent: $(SEC_UA)' -o data/sec_tickers.json $(SEC_URL)
	@echo "Fetched $$(wc -c < data/sec_tickers.json) bytes"
	python3 scripts/gen_sec_data.py
	@echo "Regenerated src/sec_data.rs"

clean:
	cargo clean
