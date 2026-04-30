#!/usr/bin/env bash
# M0 — verify the upstream C++ WASI HTTP sample builds and serves.
set -euo pipefail

UPSTREAM_DIR="${UPSTREAM_DIR:-/tmp/upstream-cpp-sample}"
PORT="${PORT:-8181}"
WASM="$UPSTREAM_DIR/http-server.wasm"
WASMTIME="${WASMTIME:-wasmtime}"

if [ ! -f "$WASM" ]; then
  echo "FAIL: $WASM does not exist (did 'make m0-build' run?)"
  exit 1
fi

# Start the server in the background.
"$WASMTIME" serve -Scli "$WASM" --addr "127.0.0.1:$PORT" >/tmp/wasmtime-m0.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# Give it a moment to start.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs "http://127.0.0.1:$PORT/hello" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

OUT=$(curl -fs "http://127.0.0.1:$PORT/hello")
echo "  /hello -> $OUT"

if echo "$OUT" | grep -q "Hello from C++ WebAssembly Component"; then
  echo "PASS: M0 upstream sample serves expected greeting"
else
  echo "FAIL: unexpected response from /hello: $OUT"
  cat /tmp/wasmtime-m0.log
  exit 1
fi
