#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  SKEW v2 // 24/7 Google Cloud VM Launcher (Celo 42220) "
echo "========================================================"

# 0. Reclaim disk space on the VM (remove any local Rust/Cargo caches or swapfiles that filled the disk)
echo "[+] Reclaiming VM disk space..."
sudo swapoff /swapfile 2>/dev/null || true
sudo rm -f /swapfile 2>/dev/null || true
rm -rf "$HOME/.rustup" "$HOME/.cargo" "$HOME/.tmp" "textile-stitch/target" 2>/dev/null || true
sudo docker system prune -af --volumes 2>/dev/null || true
sudo apt-get clean 2>/dev/null || true
df -h / | tail -n 1

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
  echo "[+] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

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

# 6. Download Pre-Compiled Linux Binary of Engine 1 (./skew-stitch) from GitHub Release (zero VM disk overhead!)
RELEASE_URL="https://github.com/eugenennamdi/Skew/releases/download/v2.0.0/skew-stitch-linux-amd64"
if [ ! -x "./skew-stitch" ]; then
  echo "[+] Downloading pre-compiled Linux binary ./skew-stitch from GitHub Release..."
  if curl -fsSL "$RELEASE_URL" -o ./skew-stitch; then
    chmod +x ./skew-stitch
    echo "    -> Downloaded ./skew-stitch successfully!"
  else
    rm -f ./skew-stitch
    echo "    -> Pre-compiled release binary is still building on GitHub Actions (takes ~2 mins); Engine 2 is already live!"
  fi
fi

if [ -x "./skew-stitch" ] && [ -f "textile-stitch/rfq-api.key" ]; then
  echo "[+] Starting Engine 1 (./skew-stitch) in background (24/7 mode)..."
  STITCH_RFQ_API_KEY_FILE="$(pwd)/textile-stitch/rfq-api.key" \
  SKEW_GAMMA_BPS="${SKEW_GAMMA_BPS:-30}" \
  RUST_LOG=info \
    nohup ./skew-stitch --config stitch.toml > skew-stitch.log 2>&1 &
  echo "    -> PID $! | Logs: tail -f $(pwd)/skew-stitch.log"
fi

echo "========================================================"
echo "  SKEW v2 IS LIVE 24/7!                                 "
echo "  Check live logs: tail -f skew-desk.log                "
echo "========================================================"
