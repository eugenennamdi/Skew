#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  SKEW v2 // 24/7 Production Launcher (Celo 42220)      "
echo "========================================================"

# 1. Load environment configuration from .env or textile-stitch/stitch.env if present
for ENV_FILE in ".env" "textile-stitch/stitch.env"; do
  if [ -f "$ENV_FILE" ]; then
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
node skew-desk.mjs --check

# 4. Stop any previous skew-desk or skew-stitch processes
echo "[+] Stopping any previous instances..."
pkill -f "node skew-desk.mjs" 2>/dev/null || true
pkill -f "skew-stitch" 2>/dev/null || true
sleep 2

# 5. Fetch pre-compiled Linux binary of Engine 1 (./skew-stitch) if on Linux x86_64
if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
  RELEASE_URL="https://github.com/eugenennamdi/Skew/releases/download/v2.0.0/skew-stitch-linux-amd64"
  echo "[+] Fetching pre-compiled Linux binary ./skew-stitch..."
  if curl -fsSL "$RELEASE_URL" -o ./skew-stitch.new; then
    mv ./skew-stitch.new ./skew-stitch
    chmod +x ./skew-stitch
  else
    rm -f ./skew-stitch.new
  fi
fi

if [ -x "./skew-stitch" ]; then
  echo "[+] Starting Engine 1 (./skew-stitch) in background..."
  cp stitch.toml stitch.runtime.toml
  STITCH_PRIVATE_KEY="$STITCH_PRIVATE_KEY" \
  STITCH_RFQ_API_KEY_FILE="${STITCH_RFQ_API_KEY_FILE:-$(pwd)/textile-stitch/rfq-api.key}" \
  SKEW_GAMMA_BPS="${SKEW_GAMMA_BPS:-30}" \
  RUST_LOG=info \
    setsid nohup ./skew-stitch --config stitch.runtime.toml </dev/null > skew-stitch.log 2>&1 &
  echo "    -> PID $! | Logs: tail -f $(pwd)/skew-stitch.log"
fi

# 6. Start Engine 2 (Autonomous Cross-Venue Arbitrage, Multi-Currency Treasury & Dashboard)
echo "[+] Starting Engine 2 (skew-desk.mjs) in background..."
STITCH_PRIVATE_KEY="$STITCH_PRIVATE_KEY" LIVE=1 AUTO_REFILL=1 MIN_EDGE_USD="${MIN_EDGE_USD:-0.01}" PORT="${PORT:-8080}" \
  setsid nohup node skew-desk.mjs </dev/null > skew-desk.log 2>&1 &
echo "    -> PID $! | Logs: tail -f $(pwd)/skew-desk.log | Web UI: http://localhost:${PORT:-8080}"
