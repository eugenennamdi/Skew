#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Ensure cron / non-interactive restarts always find node/npm (nvm, fnm, /usr/local/bin)
HOME_DIR="${HOME:-/root}"
for NVM_BIN in "$HOME_DIR"/.nvm/versions/node/*/bin "$HOME_DIR/.local/share/fnm/aliases/default/bin" "$HOME_DIR/.local/bin" "/usr/local/bin"; do
  if [ -d "$NVM_BIN" ]; then
    PATH="$NVM_BIN:$PATH"
  fi
done
export PATH

echo "========================================================"
echo "  SKEW v2 // 24/7 Production Launcher (Celo 42220)      "
echo "========================================================"

# 1. Load environment configuration (base files first, persisted .env.runtime last so empty .env placeholders never clobber live keys, and explicit caller env wins)
CALLER_STITCH_KEY="${STITCH_PRIVATE_KEY:-}"
CALLER_TEXTILE_KEY="${TEXTILE_API_KEY:-}"
CALLER_FLASH_ROUTER="${FLASH_ROUTER_ADDRESS:-}"
CALLER_GEMINI_KEY="${GEMINI_API_KEY:-}"

for ENV_FILE in "textile-stitch/stitch.env" ".env" ".env.runtime"; do
  if [ -f "$ENV_FILE" ]; then
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
done

if [ -n "$CALLER_STITCH_KEY" ]; then STITCH_PRIVATE_KEY="$CALLER_STITCH_KEY"; fi
if [ -n "$CALLER_TEXTILE_KEY" ]; then TEXTILE_API_KEY="$CALLER_TEXTILE_KEY"; fi
if [ -n "$CALLER_FLASH_ROUTER" ]; then FLASH_ROUTER_ADDRESS="$CALLER_FLASH_ROUTER"; fi
if [ -n "$CALLER_GEMINI_KEY" ]; then GEMINI_API_KEY="$CALLER_GEMINI_KEY"; fi
export STITCH_PRIVATE_KEY TEXTILE_API_KEY FLASH_ROUTER_ADDRESS GEMINI_API_KEY

if [ -z "${STITCH_PRIVATE_KEY:-}" ]; then
  echo "[!] STITCH_PRIVATE_KEY is not set."
  echo "    For zero-secret sandbox / telemetry mode, run: npm start"
  echo "    For live Celo Mainnet execution, export STITCH_PRIVATE_KEY or configure .env"
  exit 1
fi

# Persist runtime credentials to gitignored chmod-600 .env.runtime so 2-minute cron watchdog restarts inherit shell/.bashrc exports
(
  umask 077
  {
    printf 'STITCH_PRIVATE_KEY=%q\n' "$STITCH_PRIVATE_KEY"
    if [ -n "${TEXTILE_API_KEY:-}" ]; then printf 'TEXTILE_API_KEY=%q\n' "$TEXTILE_API_KEY"; fi
    if [ -n "${FLASH_ROUTER_ADDRESS:-}" ]; then printf 'FLASH_ROUTER_ADDRESS=%q\n' "$FLASH_ROUTER_ADDRESS"; fi
    if [ -n "${GEMINI_API_KEY:-}" ]; then printf 'GEMINI_API_KEY=%q\n' "$GEMINI_API_KEY"; fi
    true
  } > .env.runtime.tmp
  mv -f .env.runtime.tmp .env.runtime
  chmod 600 .env.runtime
) || echo "[!] Warning: failed to persist .env.runtime"
if [ -s .env.runtime ]; then
  echo "[+] Persisted runtime credentials to .env.runtime (FlashKey=$([ -n "${TEXTILE_API_KEY:-}" ] && echo yes || echo no))."
fi

# 2. Ensure Node.js >= 20 and dependencies are installed
if [ ! -d "node_modules/ethers" ]; then
  echo "[+] Installing Node dependencies..."
  npm ci --no-audit --no-fund
fi

# 3. Stop any previous skew-desk or skew-stitch supervisors & processes gracefully (waits up to 12s for any in-flight trade to settle)
LOCK_FILE="/tmp/skew-starting-$(id -u).lock"
touch "$LOCK_FILE" .skew-stop
trap 'rm -f "$LOCK_FILE" .skew-stop' EXIT

echo "[+] Stopping any previous instances..."
for SUP_PID_FILE in .skew-desk-sup.pid .skew-stitch-sup.pid; do
  if [ -f "$SUP_PID_FILE" ]; then
    kill "$(cat "$SUP_PID_FILE" 2>/dev/null)" 2>/dev/null || true
    rm -f "$SUP_PID_FILE"
  fi
done
pkill -f "skew-desk-supervisor" 2>/dev/null || true
pkill -f "skew-stitch-supervisor" 2>/dev/null || true
pkill -f "[n]ode skew-desk.mjs" 2>/dev/null || true
for _ in $(seq 1 24); do
  pgrep -f "[n]ode skew-desk.mjs" >/dev/null 2>&1 || break
  sleep 0.5
done
if pgrep -f "[n]ode skew-desk.mjs" >/dev/null 2>&1; then
  echo "[!] Force-killing wedged skew-desk.mjs instance..."
  pkill -9 -f "[n]ode skew-desk.mjs" 2>/dev/null || true
  sleep 0.5
fi
fuser -k "${PORT:-8080}/tcp" 2>/dev/null || true
pkill -f "[s]kew-stitch" 2>/dev/null || true
sleep 1
pkill -9 -f "[s]kew-stitch" 2>/dev/null || true

# 4. Run self-check against Celo Mainnet & Textile RFQ (syntax check strict; live RPC check non-blocking so 2AM RPC hiccups never abort cron recovery)
echo "[+] Running Skew Desk self-check against Celo Mainnet (Chain ID 42220)..."
node --check skew-desk.mjs
SKEW_POLICY_FILE="$(pwd)/skew-policy.json" node skew-desk.mjs --check || echo "[!] Warning: live RPC self-check timed out; proceeding with daemon startup..."

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

rm -f .skew-stop

if [ -x "./skew-stitch" ]; then
  echo "[+] Starting Engine 1 (./skew-stitch) with 2s auto-respawn supervisor..."
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
  : > skew-stitch.log
  STITCH_PRIVATE_KEY="$STITCH_PRIVATE_KEY" \
  STITCH_RFQ_API_KEY_FILE="$(pwd)/rfq-api.key" \
  SKEW_POLICY_FILE="$(pwd)/skew-policy.json" \
  SKEW_GAMMA_BPS="${SKEW_GAMMA_BPS:-6}" \
  RUST_LOG=info \
    setsid nohup bash -c 'while [ ! -f .skew-stop ]; do ./skew-stitch --config ./stitch.runtime.toml; rc=$?; [ -f .skew-stop ] && break; echo "[SUPERVISOR] skew-stitch exited (code=$rc); respawning in 2s..."; sleep 2; done # skew-stitch-supervisor' </dev/null >> skew-stitch.log 2>&1 &
  echo "$!" > .skew-stitch-sup.pid
  echo "    -> Supervisor PID $! | Logs: tail -f $(pwd)/skew-stitch.log"
fi

# 6. Start Engine 2 (Autonomous Cross-Venue Arbitrage, Multi-Currency Treasury, Bounded Gemini LLM & Dashboard)
echo "[+] Starting Engine 2 (skew-desk.mjs) with 2s auto-respawn supervisor..."
[ -s skew-desk.log ] && tail -n 200 skew-desk.log > skew-desk.log.prev 2>/dev/null || true
: > skew-desk.log
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}" \
STITCH_PRIVATE_KEY="$STITCH_PRIVATE_KEY" \
TEXTILE_API_KEY="${TEXTILE_API_KEY:-}" \
FLASH_ROUTER_ADDRESS="${FLASH_ROUTER_ADDRESS:-}" \
MAX_FLASH_SLICE_USDT="${MAX_FLASH_SLICE_USDT:-12000}" \
MAX_USD_FLASH_SLICE_USDT="${MAX_USD_FLASH_SLICE_USDT:-35000}" \
PRIORITY_TIP_GWEI="${PRIORITY_TIP_GWEI:-85}" \
GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}" \
SKEW_POLICY_FILE="$(pwd)/skew-policy.json" \
LIVE=1 \
AUTO_REFILL=1 \
ENABLE_USAT="${ENABLE_USAT:-1}" \
ENABLE_ERC8021_TAG="${ENABLE_ERC8021_TAG:-0}" \
TARGET_CORRIDOR_USD="${TARGET_CORRIDOR_USD:-5}" \
MAX_SLICE_USDT="${MAX_SLICE_USDT:-400}" \
MIN_EDGE_USD="${MIN_EDGE_USD:-0.015}" \
MIN_EDGE_BPS="${MIN_EDGE_BPS:-0.80}" \
MIN_FLASH_EDGE_BPS="${MIN_FLASH_EDGE_BPS:-0.05}" \
MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS="${MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS:-4.5}" \
MIN_UNI_TO_TEXTILE_DEX_FIRST_USD="${MIN_UNI_TO_TEXTILE_DEX_FIRST_USD:-0.08}" \
MAX_DAILY_LOSS_USD="${MAX_DAILY_LOSS_USD:-1.00}" \
MAX_CONSECUTIVE_LOSSES="${MAX_CONSECUTIVE_LOSSES:-2}" \
CHASE_INTERVAL_MS="${CHASE_INTERVAL_MS:-650}" \
SCAN_INTERVAL_MS="${SCAN_INTERVAL_MS:-620}" \
BIND_HOST="${BIND_HOST:-127.0.0.1}" \
PORT="${PORT:-8080}" \
  setsid nohup bash -c 'while [ ! -f .skew-stop ]; do node skew-desk.mjs; rc=$?; [ -f .skew-stop ] && break; echo "[SUPERVISOR] skew-desk exited (code=$rc); respawning in 2s..."; sleep 2; done # skew-desk-supervisor' </dev/null >> skew-desk.log 2>&1 &
echo "$!" > .skew-desk-sup.pid
echo "    -> Supervisor PID $! | Logs: tail -f $(pwd)/skew-desk.log | Web UI (loopback): http://${BIND_HOST:-127.0.0.1}:${PORT:-8080}"

# 7. Install idempotent 2-minute reboot, OOM/crash, & 50MB log-trim watchdog in user crontab (Linux VM, zero sudo required)
if [ "$(uname -s)" = "Linux" ] && command -v crontab >/dev/null 2>&1; then
  REPO_DIR="$(pwd)"
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
  WATCHDOG_LINE="*/2 * * * * export PATH=\"$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin\"; find \"$REPO_DIR\" -maxdepth 1 -name '*.log' -size +50M -exec truncate -s 0 {} + 2>/dev/null; [ -z \"\$(find \"$LOCK_FILE\" -mmin -2 2>/dev/null)\" ] && ( ! pgrep -f \"[n]ode skew-desk.mjs\" >/dev/null 2>&1 || [ -z \"\$(find \"$REPO_DIR/skew-desk.log\" -mmin -4 2>/dev/null)\" ] || ( [ -x \"$REPO_DIR/skew-stitch\" ] && ! pgrep -f \"[s]kew-stitch\" >/dev/null 2>&1 ) ) && cd \"$REPO_DIR\" && ./run-vm.sh >> \"$REPO_DIR/watchdog.log\" 2>&1 # skew-auto-watchdog"
  ( crontab -l 2>/dev/null | grep -v "# skew-auto-watchdog" || true; echo "$WATCHDOG_LINE" ) | crontab - 2>/dev/null && \
    echo "[+] Installed 2-minute reboot, log-trim & process watchdog (# skew-auto-watchdog)." || true
fi
