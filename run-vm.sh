#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  SKEW v2 // 24/7 Google Cloud VM Launcher (Celo 42220) "
echo "========================================================"

# 1. Auto-discover existing rfq-api.key / stitch.env on the VM if not already in ./textile-stitch
if [ ! -f "textile-stitch/rfq-api.key" ]; then
  FOUND_KEY=$(sudo find "$HOME" /opt /etc /var/lib -name "rfq-api.key" 2>/dev/null | head -n 1 || true)
  if [ -n "$FOUND_KEY" ] && sudo test -f "$FOUND_KEY"; then
    echo "[+] Found existing rfq-api.key at $FOUND_KEY — copying to textile-stitch/rfq-api.key"
    sudo cp "$FOUND_KEY" textile-stitch/rfq-api.key
    sudo chown "$(id -u):$(id -g)" textile-stitch/rfq-api.key
    chmod 600 textile-stitch/rfq-api.key
  fi
fi

if [ -z "${STITCH_PRIVATE_KEY:-}" ]; then
  FOUND_ENV=$(sudo find "$HOME" /opt /etc /var/lib -name "stitch.env" 2>/dev/null | head -n 1 || true)
  if [ -n "$FOUND_ENV" ] && sudo test -f "$FOUND_ENV"; then
    set -a
    # shellcheck disable=SC1090
    eval "$(sudo cat "$FOUND_ENV" | grep -E '^(export )?[A-Z0-9_]+=' || true)"
    set +a
  fi
fi

if [ -z "${STITCH_PRIVATE_KEY:-}" ]; then
  echo "[!] Please export STITCH_PRIVATE_KEY before running:"
  echo "    export STITCH_PRIVATE_KEY=\"0xYOUR_PRIVATE_KEY\""
  exit 1
fi

# 2. Auto-install Node.js 20 on Ubuntu/Debian if node/npm is not installed
if ! command -v npm >/dev/null 2>&1; then
  echo "[+] Node.js/npm not found on VM — installing Node.js 20 automatically..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs build-essential pkg-config libssl-dev
fi

# Ensure Node.js dependencies are installed
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

# 6. Free disk space, add 2GB swap + disk TMPDIR so 1GB VM never OOMs, then Build & Start Engine 1
echo "[+] Ensuring 2GB swapfile and disk-backed TMPDIR on VM..."
if ! sudo swapon --show | grep -q "/swapfile"; then
  sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile || true
fi
mkdir -p "$HOME/.tmp"
export TMPDIR="$HOME/.tmp"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
if ! rustup which rustc >/dev/null 2>&1; then
  echo "[+] Installing minimal Rust stable toolchain (using disk TMPDIR)..."
  sudo apt-get update -y && sudo apt-get install -y build-essential pkg-config libssl-dev
  if ! command -v rustup >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
  else
    rustup toolchain install stable --profile minimal
    rustup default stable
  fi
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if command -v cargo >/dev/null 2>&1 && rustup which rustc >/dev/null 2>&1; then
  if [ ! -x "./skew-stitch" ]; then
    echo "[+] Building Linux release binary ./skew-stitch (takes ~2-3 mins once)..."
    (cd textile-stitch && CARGO_BUILD_JOBS=2 cargo build --release --bin stitch && cp target/release/stitch ../skew-stitch && rm -rf target)
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
fi

echo "========================================================"
echo "  SKEW v2 IS LIVE 24/7!                                 "
echo "  Check live logs: tail -f skew-desk.log                "
echo "========================================================"
