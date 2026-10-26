#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  SKEW v2 // 24/7 Google Cloud VM Launcher (Celo 42220) "
echo "========================================================"

# 1. Auto-discover existing rfq-api.key / stitch.env on the VM if not already in ./textile-stitch
if [ ! -f "textile-stitch/rfq-api.key" ]; then
  FOUND_KEY=$(find "$HOME" /opt /etc /var/lib -name "rfq-api.key" 2>/dev/null | head -n 1 || true)
  if [ -n "$FOUND_KEY" ] && [ -f "$FOUND_KEY" ]; then
    echo "[+] Found existing rfq-api.key at $FOUND_KEY — copying to textile-stitch/rfq-api.key"
    cp "$FOUND_KEY" textile-stitch/rfq-api.key
    chmod 600 textile-stitch/rfq-api.key
  fi
fi

if [ -z "${STITCH_PRIVATE_KEY:-}" ]; then
  FOUND_ENV=$(find "$HOME" /opt /etc -name "stitch.env" 2>/dev/null | head -n 1 || true)
  if [ -n "$FOUND_ENV" ] && [ -f "$FOUND_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$FOUND_ENV" || true
    set +a
  fi
fi

if [ -z "${STITCH_PRIVATE_KEY:-}" ]; then
  echo "[!] Please export STITCH_PRIVATE_KEY before running:"
  echo "    export STITCH_PRIVATE_KEY=\"0xYOUR_PRIVATE_KEY\""
  exit 1
fi

# 2. Ensure Node.js dependencies are installed
if [ ! -d "node_modules/ethers" ]; then
  echo "[+] Installing Node dependencies (ethers)..."
  npm install --no-audit --no-fund
fi

# 3. Run live self-check
echo "[+] Running Skew Desk self-check against Celo Mainnet & Textile RFQ..."
node skew-desk.mjs --check

# 4. Stop any previous skew-desk or skew-stitch processes
pkill -f "node skew-desk.mjs" 2>/dev/null || true
pkill -f "skew-stitch" 2>/dev/null || true

# 5. Start Engine 2 (Autonomous Cross-Venue Arbitrage, Auto-Refill & Dashboard on :8080)
echo "[+] Starting Engine 2 (skew-desk.mjs) in background (24/7 mode)..."
LIVE=1 AUTO_REFILL=1 MIN_EDGE_USD="${MIN_EDGE_USD:-0.01}" PORT="${PORT:-8080}" \
  nohup node skew-desk.mjs > skew-desk.log 2>&1 &
echo "    -> PID $! | Logs: tail -f $(pwd)/skew-desk.log | Web UI: http://localhost:${PORT:-8080}"

# 6. Build & Start Engine 1 (Dual-Oracle Rust Maker) if cargo is installed
if command -v cargo >/dev/null 2>&1; then
  if [ ! -x "./skew-stitch" ]; then
    echo "[+] Building Linux release binary ./skew-stitch (takes ~2 mins once)..."
    (cd textile-stitch && cargo build --release && cp target/release/stitch ../skew-stitch)
  fi
  if [ -f "textile-stitch/rfq-api.key" ]; then
    echo "[+] Starting Engine 1 (./skew-stitch) in background (24/7 mode)..."
    STITCH_RFQ_API_KEY_FILE="$(pwd)/textile-stitch/rfq-api.key" \
    SKEW_GAMMA_BPS="${SKEW_GAMMA_BPS:-30}" \
    RUST_LOG=info \
      nohup ./skew-stitch --config stitch.toml > skew-stitch.log 2>&1 &
    echo "    -> PID $! | Logs: tail -f $(pwd)/skew-stitch.log"
  else
    echo "[!] Note: textile-stitch/rfq-api.key not found yet; Engine 2 (skew-desk.mjs) is running 24/7."
    echo "    To also start Engine 1, place your rfq-api.key at textile-stitch/rfq-api.key and re-run ./run-vm.sh"
  fi
else
  echo "[i] Rust/Cargo not installed on this VM yet — Engine 2 (skew-desk.mjs) is running 24/7!"
  echo "    (To install Rust for Engine 1: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y)"
fi

echo "========================================================"
echo "  SKEW v2 IS LIVE 24/7!                                 "
echo "  Check live logs: tail -f skew-desk.log                "
echo "========================================================"
