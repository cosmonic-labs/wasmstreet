#!/usr/bin/env bash
# integration.sh — end-to-end tests against `wasmtime serve build/wasmstreet.wasm`.
#
# Usage: tests/integration.sh [m2|m3|m4|m5|m6|m7|all]
# The argument scopes which tests run (later milestones are additive).

set -euo pipefail

WASMSTREET_WASM="${WASMSTREET_WASM:-build/wasmstreet.wasm}"
PORT="${PORT:-8765}"
HOST="127.0.0.1"
BASE="http://$HOST:$PORT"
SCOPE="${1:-all}"

if [ ! -f "$WASMSTREET_WASM" ]; then
  echo "FAIL: $WASMSTREET_WASM not found (did you run 'make compose'?)"
  exit 1
fi

# Spin up wasmtime serve in the background.
wasmtime serve -Scli -Shttp "$WASMSTREET_WASM" --addr "$HOST:$PORT" >/tmp/wasmstreet-it.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# Wait for it to come up.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs "$BASE/health" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

if ! curl -fs "$BASE/health" >/dev/null; then
  echo "FAIL: server did not come up"
  cat /tmp/wasmstreet-it.log
  exit 1
fi

PASS=0
FAIL=0

# helper: assert numeric value within tolerance
# usage: assert_close LABEL ACTUAL EXPECTED TOL
assert_close() {
  local label=$1 actual=$2 expected=$3 tol=$4
  awk -v a="$actual" -v e="$expected" -v t="$tol" -v lbl="$label" '
    BEGIN {
      d = (a - e); if (d < 0) d = -d;
      if (d > t) { printf "FAIL %s actual=%s expected=%s diff=%s tol=%s\n", lbl, a, e, d, t; exit 1 }
      else      { printf "ok   %s = %s\n", lbl, a; exit 0 }
    }'
}

run() {
  local name=$1; shift
  if "$@"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "  >> $name failed"; fi
}

# -------------------------------------------------------------------- M2
test_m2() {
  echo "== M2: black-scholes pricing =="
  local body
  body=$(curl -fs -X POST "$BASE/price" \
    -H 'Content-Type: application/json' \
    -d '{"spot":100,"strike":100,"vol":0.2,"rate":0.05,"time":1.0,"model":"black-scholes"}')
  echo "  body: $body"
  local call put delta gamma vega theta rho
  call=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['call_price'])")
  put=$(printf  '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['put_price'])")
  delta=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['greeks']['delta'])")
  gamma=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['greeks']['gamma'])")
  vega=$(printf  '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['greeks']['vega'])")
  theta=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['greeks']['theta'])")
  rho=$(printf   '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['greeks']['rho'])")

  run "call price"  assert_close "call_price"  "$call"  10.4506   1e-3
  run "put price"   assert_close "put_price"   "$put"    5.5735   1e-3
  run "delta"       assert_close "delta"       "$delta"  0.6368   1e-3
  run "gamma"       assert_close "gamma"       "$gamma"  0.01876  1e-4
  run "vega"        assert_close "vega"        "$vega"  37.524    1e-2
  run "theta"       assert_close "theta"       "$theta" -6.4140   1e-2
  run "rho"         assert_close "rho"         "$rho"   53.2325   1e-2
}

# -------------------------------------------------------------------- M3
test_m3() {
  echo "== M3: monte-carlo pricing =="
  local body
  body=$(curl -fs -X POST "$BASE/price" \
    -H 'Content-Type: application/json' \
    -d '{"spot":100,"strike":100,"vol":0.2,"rate":0.05,"time":1.0,"model":"monte-carlo","seed":42}')
  echo "  body: $(printf '%s' "$body" | head -c 200)..."
  local price npaths nsteps
  price=$(printf  '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['price'])")
  npaths=$(printf '%s' "$body" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['sample_paths']))")
  nsteps=$(printf '%s' "$body" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['sample_paths'][0]))")

  # Asian arithmetic call should be cheaper than European call at same params.
  # Loose bound: 3.0 < price < 8.0
  awk -v p="$price" 'BEGIN { if (p > 3.0 && p < 8.0) exit 0; print "FAIL price out of range: " p; exit 1 }' \
    && { echo "ok   asian price in [3, 8]: $price"; PASS=$((PASS+1)); } \
    || FAIL=$((FAIL+1))
  awk -v n="$npaths" 'BEGIN { exit !(n == 50) }' \
    && { echo "ok   sample_paths length = 50"; PASS=$((PASS+1)); } \
    || { echo "FAIL sample_paths length = $npaths"; FAIL=$((FAIL+1)); }
  awk -v n="$nsteps" 'BEGIN { exit !(n == 50) }' \
    && { echo "ok   sample_paths[0] length = 50"; PASS=$((PASS+1)); } \
    || { echo "FAIL sample_paths[0] length = $nsteps"; FAIL=$((FAIL+1)); }
}

# -------------------------------------------------------------------- M4
test_m4() {
  echo "== M4: binomial-tree pricing =="
  local body_amer body_euro
  body_amer=$(curl -fs -X POST "$BASE/price" \
    -H 'Content-Type: application/json' \
    -d '{"spot":100,"strike":100,"vol":0.2,"rate":0.05,"time":1.0,"model":"binomial-tree","american":true,"option_type":"put","steps":500}')
  body_euro=$(curl -fs -X POST "$BASE/price" \
    -H 'Content-Type: application/json' \
    -d '{"spot":100,"strike":100,"vol":0.2,"rate":0.05,"time":1.0,"model":"binomial-tree","american":false,"option_type":"put","steps":500}')

  local p_amer p_euro
  p_amer=$(printf '%s' "$body_amer" | python3 -c "import json,sys; print(json.load(sys.stdin)['price'])")
  p_euro=$(printf '%s' "$body_euro" | python3 -c "import json,sys; print(json.load(sys.stdin)['price'])")

  awk -v a="$p_amer" -v e="$p_euro" 'BEGIN { if (a > e) exit 0; print "FAIL american put ("a") <= european put ("e")"; exit 1 }' \
    && { echo "ok   american put > european put: $p_amer > $p_euro"; PASS=$((PASS+1)); } \
    || FAIL=$((FAIL+1))
}

# -------------------------------------------------------------------- M5
test_m5() {
  echo "== M5: ui assets =="
  for path in / /shell/shell.css /shell/shell.js /sections/pricing/pricing.js; do
    if curl -fs -o /dev/null -w '%{http_code}' "$BASE$path" | grep -q '200'; then
      echo "ok   GET $path = 200"; PASS=$((PASS+1))
    else
      echo "FAIL GET $path"; FAIL=$((FAIL+1))
    fi
  done
}

# -------------------------------------------------------------------- M7
test_m7() {
  echo "== M7: market data =="
  if ! curl -fs "$BASE/quote?ticker=SPY" >/dev/null; then
    echo "FAIL /quote did not respond"; FAIL=$((FAIL+1)); return
  fi
  local body
  body=$(curl -fs "$BASE/quote?ticker=SPY")
  echo "  body: $(printf '%s' "$body" | head -c 200)..."
  if printf '%s' "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'spot' in d and 'calls' in d and 'puts' in d and len(d['calls']) > 0"; then
    echo "ok   /quote returns spot+calls+puts"; PASS=$((PASS+1))
  else
    echo "FAIL /quote response shape"; FAIL=$((FAIL+1))
  fi

  # Pull a contract and price it through all 3 models in parallel
  local strike vol
  strike=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['calls'][4]['strike'])")
  vol=$(printf    '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['calls'][4]['iv'])")
  local spot rate time
  spot=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['spot'])")
  rate=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['rate'])")
  time=$(printf '%s' "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['time'])")
  for model in black-scholes monte-carlo binomial-tree; do
    local r
    r=$(curl -fs -X POST "$BASE/price" -H 'Content-Type: application/json' \
      -d "{\"spot\":$spot,\"strike\":$strike,\"vol\":$vol,\"rate\":$rate,\"time\":$time,\"model\":\"$model\",\"steps\":200,\"option_type\":\"call\",\"num_paths\":2000,\"num_steps\":50,\"seed\":42}" 2>&1)
    if printf '%s' "$r" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('model') == '$model'"; then
      echo "ok   chain priced by $model"; PASS=$((PASS+1))
    else
      echo "FAIL $model on chain strike $strike: $r"; FAIL=$((FAIL+1))
    fi
  done
}

# -------------------------------------------------------------------- iter1: tickers + chain + strategy/pnl
test_iter1() {
  echo "== iter1: /tickers (autocomplete via ticker-search component) =="
  local body
  body=$(curl -fsS "$BASE/tickers?q=AAPL")
  if printf '%s' "$body" | python3 -c "
import json,sys
d = json.load(sys.stdin)
m = d.get('matches', [])
assert m, 'empty matches'
# AAPL prefix query should put AAPL itself first.
assert m[0]['ticker'] == 'AAPL', f'expected AAPL first, got: {m[:3]}'
# Component reports 10K+ entries scanned.
assert d.get('evaluated', 0) >= 10_000, f'evaluated={d.get(\"evaluated\")}'
print(f'AAPL first; universe={d[\"evaluated\"]} entries')
"; then
    echo "ok   /tickers?q=AAPL → AAPL first, 10K+ universe scanned"; PASS=$((PASS+1))
  else
    echo "FAIL /tickers shape: $body"; FAIL=$((FAIL+1))
  fi

  echo "== iter1: /tickers name match (apple → AAPL) =="
  body=$(curl -fsS "$BASE/tickers?q=apple")
  if printf '%s' "$body" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert any(x['ticker'] == 'AAPL' for x in d.get('matches', [])), \
    f'AAPL missing for name search: {[x[\"ticker\"] for x in d.get(\"matches\",[])]}'
print(f'name search ok: {[x[\"ticker\"] for x in d[\"matches\"]]}')"; then
    echo "ok   /tickers?q=apple finds AAPL by name"; PASS=$((PASS+1))
  else
    echo "FAIL /tickers name search: $body"; FAIL=$((FAIL+1))
  fi

  echo "== iter1: /chain (enriched) =="
  body=$(curl -fsS "$BASE/chain?ticker=AAPL")
  if printf '%s' "$body" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert 'ticker' in d and 'spot' in d and 'calls' in d
assert d['ticker'] == 'AAPL'
assert len(d['calls']) > 0
c0 = d['calls'][0]
for k in ['theoretical_price', 'market_to_theo_ratio', 'delta', 'gamma', 'vega', 'theta', 'iv']:
    assert k in c0, f'missing {k}'
# Source field
assert d['source'] in ('yahoo', 'fixture')
print(f\"chain: {len(d['calls'])} calls, src={d['source']}\")
"; then
    echo "ok   /chain returns enriched contracts"; PASS=$((PASS+1))
  else
    echo "FAIL /chain shape"; FAIL=$((FAIL+1))
  fi

  echo "== iter1: /strategy/pnl long call =="
  body=$(curl -fsS -X POST "$BASE/strategy/pnl" \
    -H 'Content-Type: application/json' \
    -d '{"underlying":{"spot":100,"rate":0.05,"vol":0.20},
         "scenario":{"price_min":80,"price_max":120,"price_steps":21,"days_min":0,"days_max":30,"day_steps":11},
         "legs":[{"side":"buy","kind":"call","strike":100,"expiration_days":30,"iv":0.20,"units":1,"entry_premium":4.20}]}')
  if printf '%s' "$body" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert d['rows'] == 21
assert d['cols'] == 11
assert len(d['pnl_grid']) == 21*11
assert d['max_loss'] < 0
assert d['max_profit'] > 0
assert -421 < d['net_premium'] < -419   # exact: -420
assert len(d['breakeven_prices']) >= 1
print(f\"max_profit={d['max_profit']:.2f} max_loss={d['max_loss']:.2f} breakevens={d['breakeven_prices']}\")
"; then
    echo "ok   /strategy/pnl long-call sanity checks"; PASS=$((PASS+1))
  else
    echo "FAIL /strategy/pnl: $body"; FAIL=$((FAIL+1))
  fi

  echo "== iter1: /strategy/pnl bull call spread =="
  body=$(curl -fsS -X POST "$BASE/strategy/pnl" \
    -H 'Content-Type: application/json' \
    -d '{"underlying":{"spot":100,"rate":0.05,"vol":0.20},
         "scenario":{"price_min":80,"price_max":130,"price_steps":51,"days_min":0,"days_max":30,"day_steps":31},
         "legs":[{"side":"buy", "kind":"call","strike":100,"expiration_days":30,"iv":0.20,"units":1,"entry_premium":4.20},
                 {"side":"sell","kind":"call","strike":110,"expiration_days":30,"iv":0.18,"units":1,"entry_premium":1.50}]}')
  if printf '%s' "$body" | python3 -c "
import json,sys
d = json.load(sys.stdin)
# Bull call spread: max profit ~ 730, max loss ~ -270
assert 720 < d['max_profit'] < 740, f\"max_profit={d['max_profit']}\"
assert -280 < d['max_loss'] < -260, f\"max_loss={d['max_loss']}\"
print(f\"bull call spread: profit={d['max_profit']:.2f} loss={d['max_loss']:.2f}\")
"; then
    echo "ok   /strategy/pnl bull-call max profit/loss"; PASS=$((PASS+1))
  else
    echo "FAIL /strategy/pnl bull call spread"; FAIL=$((FAIL+1))
  fi

  echo "== iter2: /strategy/search ranks ≥ 100 candidates =="
  if python3 -c "
import json, urllib.request
chain = json.loads(urllib.request.urlopen('$BASE/chain?ticker=AAPL').read())
contracts = [{'kind':'call','strike':c['strike'],'expiration_days':c['days_to_exp'],'iv':c['iv'],'mid':c['mid']} for c in chain['calls']]
contracts += [{'kind':'put','strike':p['strike'],'expiration_days':p['days_to_exp'],'iv':p['iv'],'mid':p['mid']} for p in chain['puts']]
req = {'spot': chain['spot'], 'rate': chain['rate'], 'scenario_vol': 0.22,
       'price_min': chain['spot']*0.85, 'price_max': chain['spot']*1.15, 'price_steps': 20,
       'days_min': 0, 'days_max': 30, 'day_steps': 6,
       'max_results': 5, 'scoring': 'balanced', 'contracts': contracts}
r = urllib.request.urlopen(urllib.request.Request('$BASE/strategy/search', method='POST',
    headers={'Content-Type':'application/json'}, data=json.dumps(req).encode())).read()
out = json.loads(r)
assert out['evaluated'] >= 100, f'evaluated too low: {out[\"evaluated\"]}'
assert len(out['ranked']) >= 1
top = out['ranked'][0]
assert top['name'] and top['legs']
# score must be sorted descending
for i in range(1, len(out['ranked'])):
    assert out['ranked'][i-1]['score'] >= out['ranked'][i]['score'], 'not sorted'
print(f'evaluated={out[\"evaluated\"]} top={top[\"name\"]} score={top[\"score\"]:.1f}')
"; then
    echo "ok   /strategy/search ranks candidates"; PASS=$((PASS+1))
  else
    echo "FAIL /strategy/search"; FAIL=$((FAIL+1))
  fi
}

# Dispatch
case "$SCOPE" in
  m2) test_m2 ;;
  m3) test_m2; test_m3 ;;
  m4) test_m2; test_m3; test_m4 ;;
  m5) test_m2; test_m3; test_m4; test_m5 ;;
  m6) test_m2; test_m3; test_m4; test_m5 ;;
  m7) test_m2; test_m3; test_m4; test_m5; test_m7 ;;
  iter1) test_iter1 ;;
  all|*) test_m2; test_m3; test_m4; test_m7; test_iter1 ;;
esac

echo
echo "Passed: $PASS   Failed: $FAIL"
[ $FAIL -eq 0 ]
