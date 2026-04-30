# WasmStreet — top-level orchestrator

# Toolchain
WASI_SDK_PATH ?= $(HOME)/wasi-sdk/wasi-sdk-28.0-arm64-macos
export WASI_SDK_PATH

WAC          ?= wac
WASH         ?= wash
WASMTIME     ?= wasmtime
WASM_TOOLS   ?= wasm-tools
WKG          ?= wkg
WIT_BINDGEN  ?= wit-bindgen

# Output
BUILD_DIR := build
COMPOSED  := $(BUILD_DIR)/wasmstreet.wasm

# Component artifacts (each rule lives in the component subdir)
BS_WASM     := components/pricer-black-scholes/pricer-black-scholes.wasm
MC_WASM     := components/pricer-monte-carlo/pricer-monte-carlo.wasm
BT_WASM     := components/pricer-binomial-tree/pricer-binomial-tree.wasm
SG_WASM     := components/pricer-strategy-grid/pricer-strategy-grid.wasm
SS_WASM     := components/pricer-strategy-search/pricer-strategy-search.wasm
ROUTER_WASM := components/pricing-router/target/wasm32-wasip2/release/pricing_router.wasm
MARKET_WASM := components/market-data/target/wasm32-wasip2/release/market_data.wasm
TICKERS_WASM:= components/ticker-search/target/wasm32-wasip2/release/ticker_search.wasm

.PHONY: all
all: components-build $(COMPOSED)

# components-build builds whichever component subdirectories exist.
.PHONY: components-build
components-build:
	@if [ -d components/pricer-black-scholes ];  then $(MAKE) -C components/pricer-black-scholes wasm;  fi
	@if [ -d components/pricer-monte-carlo ];    then $(MAKE) -C components/pricer-monte-carlo wasm;    fi
	@if [ -d components/pricer-binomial-tree ];  then $(MAKE) -C components/pricer-binomial-tree wasm;  fi
	@if [ -d components/pricer-strategy-grid ];  then $(MAKE) -C components/pricer-strategy-grid wasm;  fi
	@if [ -d components/pricer-strategy-search ]; then $(MAKE) -C components/pricer-strategy-search wasm; fi
	@if [ -d components/market-data ];           then cd components/market-data    && cargo build --target wasm32-wasip2 --release; fi
	@if [ -d components/ticker-search ];         then cd components/ticker-search  && cargo build --target wasm32-wasip2 --release; fi
	@if [ -d components/pricing-router ];        then cd components/pricing-router && cargo build --target wasm32-wasip2 --release; fi

# ---- M0: upstream sample reproduction --------------------------------------
UPSTREAM_DIR := /tmp/upstream-cpp-sample

.PHONY: m0-clone m0-build m0-test
m0-clone:
	@if [ ! -d $(UPSTREAM_DIR) ]; then \
		git clone --depth=1 https://github.com/bytecodealliance/sample-wasi-http-cpp $(UPSTREAM_DIR); \
	fi

m0-build: m0-clone
	$(MAKE) -C $(UPSTREAM_DIR) WASI_SDK_PATH=$(WASI_SDK_PATH)

m0-test: m0-build
	@bash tests/m0_smoke.sh

# ---- Component build targets (filled in as milestones land) ----------------
.PHONY: components
components: $(BS_WASM) $(MC_WASM) $(BT_WASM) $(ROUTER_WASM)

$(BS_WASM):
	$(MAKE) -C components/pricer-black-scholes wasm

$(MC_WASM):
	$(MAKE) -C components/pricer-monte-carlo wasm

$(BT_WASM):
	$(MAKE) -C components/pricer-binomial-tree wasm

$(ROUTER_WASM):
	cd components/pricing-router && cargo build --target wasm32-wasip2 --release

$(MARKET_WASM):
	cd components/market-data && cargo build --target wasm32-wasip2 --release

# ---- Composition -----------------------------------------------------------
# PLUGS expands to whichever component .wasm files currently exist on disk.
# This lets earlier milestones compose with subsets and the latest builds
# include market-data + strategy-grid.
PLUGS := $(wildcard $(BS_WASM)) $(wildcard $(MC_WASM)) $(wildcard $(BT_WASM)) \
        $(wildcard $(SG_WASM)) $(wildcard $(SS_WASM)) $(wildcard $(MARKET_WASM)) \
        $(wildcard $(TICKERS_WASM))
PLUG_ARGS := $(foreach p,$(PLUGS),--plug $(p))

.PHONY: compose
compose: $(COMPOSED)

$(COMPOSED): $(ROUTER_WASM) $(PLUGS)
	@mkdir -p $(BUILD_DIR)
	@if [ -z "$(PLUGS)" ]; then echo "FAIL: no plug .wasm files found"; exit 1; fi
	$(WAC) plug $(PLUG_ARGS) $(ROUTER_WASM) -o $(COMPOSED)

# ---- Tests -----------------------------------------------------------------
.PHONY: test test-native test-integration
test: test-native test-integration

test-native:
	$(MAKE) -C components/pricer-black-scholes test
	$(MAKE) -C components/pricer-monte-carlo test
	$(MAKE) -C components/pricer-binomial-tree test
	@if [ -d components/pricer-strategy-grid ];   then $(MAKE) -C components/pricer-strategy-grid test;   fi
	@if [ -d components/pricer-strategy-search ]; then $(MAKE) -C components/pricer-strategy-search test; fi
	@if [ -d components/market-data ];          then cd components/market-data    && cargo test --lib; fi
	@if [ -d components/ticker-search ];        then cd components/ticker-search  && cargo test --lib; fi
	cd components/pricing-router && cargo test

test-integration: $(COMPOSED)
	bash tests/integration.sh iter1

# ---- Dev loop --------------------------------------------------------------
.PHONY: dev
dev: $(COMPOSED)
	$(WASMTIME) serve -Scli -Shttp $(COMPOSED) --addr 127.0.0.1:8000

# ---- Sizes / metrics -------------------------------------------------------
.PHONY: sizes
sizes:
	@echo "=== Stripped component sizes ==="
	@for f in $(BS_WASM) $(MC_WASM) $(BT_WASM) $(ROUTER_WASM) $(COMPOSED); do \
		if [ -f $$f ]; then \
			RAW=$$(wc -c < $$f); \
			$(WASM_TOOLS) strip $$f -o /tmp/_stripped.wasm 2>/dev/null || cp $$f /tmp/_stripped.wasm; \
			STRIPPED=$$(wc -c < /tmp/_stripped.wasm); \
			printf "%-60s raw: %10s   stripped: %10s\n" $$f $$RAW $$STRIPPED; \
		fi; \
	done; rm -f /tmp/_stripped.wasm

# ---- Clean -----------------------------------------------------------------
.PHONY: clean
clean:
	rm -rf $(BUILD_DIR)
	$(MAKE) -C components/pricer-black-scholes clean 2>/dev/null || true
	$(MAKE) -C components/pricer-monte-carlo clean 2>/dev/null || true
	$(MAKE) -C components/pricer-binomial-tree clean 2>/dev/null || true
	cd components/pricing-router && cargo clean 2>/dev/null || true
