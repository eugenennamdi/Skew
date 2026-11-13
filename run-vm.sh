#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  SKEW v2 // 24/7 Production Launcher (Celo 42220)      "
echo "========================================================"

# 1. Load environment configuration from .env or textile-stitch/stitch.env if present & lock secret file permissions
for ENV_FILE in ".env" "textile-stitch/stitch.env"; do
  if [ -f "$ENV_FILE" ]; then
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
done

if [ -z "${STITCH_PRIVATE_KEY:-}" ]; then
  echo "[!] STITCH_PRIVATE_KEY is not set."
  echo "    For zero-secret sandbox / telemetry mode, run: npm start"
  echo "    For live Celo Mainnet execution, export STITCH_PRIVATE_KEY or configure .env"
  exit 1
fi

# 2. Ensure Node.js >= 20 and dependencies are installed
if [ ! -d "node_modules/ethers" ]; then
  echo "[+] Installing Node dependencies..."
  npm ci --no-audit --no-fund
fi

# 3. Run self-check against Celo Mainnet & Textile RFQ
echo "[+] Running Skew Desk self-check against Celo Mainnet (Chain ID 42220)..."
SKEW_POLICY_FILE="$(pwd)/skew-policy.json" node skew-desk.mjs --check

# 4. Stop any previous skew-desk or skew-stitch processes
echo "[+] Stopping any previous instances..."
pkill -f "node skew-desk.mjs" 2>/dev/null || true
pkill -f "skew-stitch" 2>/dev/null || true
sleep 2

# 5. Fetch & cryptographically verify SHA-256 of Engine 1 (./skew-stitch) if on Linux x86_64
EXPECTED_STITCH_SHA256="caa5f515672f0b06b48a584cb857862dbf3138e143757675fc097f81f486338d"
if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
  if [ -x "./skew-stitch" ] && echo "${EXPECTED_STITCH_SHA256}  ./skew-stitch" | sha256sum -c --status - 2>/dev/null; then
    echo "[+] Verified existing ./skew-stitch binary matches pinned SHA-256."
  else
    RELEASE_URL="https://github.com/eugenennamdi/Skew/releases/download/v2.0.0/skew-stitch-linux-amd64"
    echo "[+] Fetching pre-compiled Linux binary ./skew-stitch..."
    if curl -fsSL "$RELEASE_URL" -o ./skew-stitch.new; then
      if echo "${EXPECTED_STITCH_SHA256}  ./skew-stitch.new" | sha256sum -c --status -; then
        mv ./skew-stitch.new ./skew-stitch
        chmod 700 ./skew-stitch
        echo "[+] SHA-256 verified for ./skew-stitch."
      else
        rm -f ./skew-stitch.new
        echo "[!] SECURITY ABORT: Downloaded ./skew-stitch.new failed SHA-256 verification!" >&2
        exit 1
      fi
    else
      rm -f ./skew-stitch.new
    fi
  fi
fi

if [ -x "./skew-stitch" ]; then
  echo "[+] Starting Engine 1 (./skew-stitch) in background..."
  cp stitch.toml stitch.runtime.toml
  chmod 600 "$(pwd)/rfq-api.key" "$(pwd)/textile-stitch/rfq-api.key" 2>/dev/null || true
  # ponytail: keep repo-root ./rfq-api.key authoritative so fresh `skew-stitch connect` keys are never overwritten by stale sub-dir keys
  if [ ! -s "$(pwd)/rfq-api.key" ] && [ -s "$(pwd)/textile-stitch/rfq-api.key" ]; then
    cp -f "$(pwd)/textile-stitch/rfq-api.key" "$(pwd)/rfq-api.key"
    chmod 600 "$(pwd)/rfq-api.key"
  fi
  if [ -s "$(pwd)/rfq-api.key" ] && [ -d "$(pwd)/textile-stitch" ]; then
    cp -f "$(pwd)/rfq-api.key" "$(pwd)/textile-stitch/rfq-api.key"
  fi
  export STITCH_RFQ_API_KEY_FILE="$(pwd)/rfq-api.key"
  STITCH_PRIVATE_KEY="$STITCH_PRIVATE_KEY" \
  STITCH_RFQ_API_KEY_FILE="$(pwd)/rfq-api.key" \
  SKEW_POLICY_FILE="$(pwd)/skew-policy.json" \
  SKEW_GAMMA_BPS="${SKEW_GAMMA_BPS:-6}" \
  RUST_LOG=info \
    setsid nohup ./skew-stitch --config ./stitch.runtime.toml </dev/null > skew-stitch.log 2>&1 &
  echo "    -> PID $! | Logs: tail -f $(pwd)/skew-stitch.log"
fi

# 6. Start Engine 2 (Autonomous Cross-Venue Arbitrage, Multi-Currency Treasury, Bounded Gemini LLM & Dashboard)
echo "[+] Starting Engine 2 (skew-desk.mjs) in background..."
STITCH_PRIVATE_KEY="$STITCH_PRIVATE_KEY" \
GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}" \
SKEW_POLICY_FILE="$(pwd)/skew-policy.json" \
LIVE=1 \
AUTO_REFILL=1 \
ENABLE_USAT="${ENABLE_USAT:-1}" \
ENABLE_ERC8021_TAG="${ENABLE_ERC8021_TAG:-0}" \
TARGET_CORRIDOR_USD="${TARGET_CORRIDOR_USD:-5}" \
MAX_SLICE_USDT="${MAX_SLICE_USDT:-400}" \
MIN_EDGE_USD="${MIN_EDGE_USD:-0.012}" \
MIN_EDGE_BPS="${MIN_EDGE_BPS:-0.55}" \
MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS="${MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS:-2.5}" \
MIN_UNI_TO_TEXTILE_DEX_FIRST_USD="${MIN_UNI_TO_TEXTILE_DEX_FIRST_USD:-0.045}" \
MAX_DAILY_LOSS_USD="${MAX_DAILY_LOSS_USD:-1.00}" \
MAX_CONSECUTIVE_LOSSES="${MAX_CONSECUTIVE_LOSSES:-2}" \
CHASE_INTERVAL_MS="${CHASE_INTERVAL_MS:-1000}" \
SCAN_INTERVAL_MS="${SCAN_INTERVAL_MS:-6000}" \
BIND_HOST="${BIND_HOST:-127.0.0.1}" \
PORT="${PORT:-8080}" \
  setsid nohup node skew-desk.mjs </dev/null > skew-desk.log 2>&1 &
echo "    -> PID $! | Logs: tail -f $(pwd)/skew-desk.log | Web UI (loopback): http://${BIND_HOST:-127.0.0.1}:${PORT:-8080}"
