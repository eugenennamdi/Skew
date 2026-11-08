# <img src="docs/icons/skew-logo.svg" width="28" height="28" align="absmiddle" alt="Skew Logo" /> Skew

**Autonomous, AI-supervised FX market-making and cross-venue arbitrage infrastructure on Celo Mainnet (`42220`).** Skew streams continuous two-way RFQ liquidity across all four **Textile FX** local-currency corridors (**cNGN**, **wARS**, **wBRL**, and **USDC** against **USDT**) through a custom-patched Rust **Stitch** execution engine with zero-restart policy hot-reloading, paired with a Node.js quantitative and **Google Gemini 3.8 Flash** risk desk that scores post-fill markout toxicity, arbitrages cross-venue dislocations against Celo Uniswap v3, and rebalances multi-currency treasury reserves autonomously on-chain.

Skew operates continuously in production on Celo Mainnet as **ERC-8004 Agent `#9905`**, with every outbound transaction carrying the 35-byte ERC-8021 attribution suffix **`celo_7935fb97e273`**.

> **🔴 Live 24/7 Mainnet Telemetry & Quote Simulator:** **[https://eugenennamdi.github.io/Skew/](https://eugenennamdi.github.io/Skew/)** — *Inspect live Maker uptime, real-time Celo Mainnet (`42220`) treasury balances, 4-corridor `slot0()` spreads, normalized Avellaneda-Stoikov skew, and verified on-chain return in real time.*

| Component | Identifier / Endpoint |
| :--- | :--- |
| **Live Telemetry Dashboard (24/7 RPC)** | **[https://eugenennamdi.github.io/Skew/](https://eugenennamdi.github.io/Skew/)** (live Celo RPC + Blockscout v2 stream + MiniPay CIP-64 `feeCurrency` support) |
| **Quantitative Strategy & Microstructure Spec** | **[docs/STRATEGY.md](docs/STRATEGY.md)** (Dual-Oracle shield, normalized skew, EWMA volatility, markouts, bounded Gemini supervisor, `MAX_TICK` guard) |
| **On-Chain Audit & Settlement Ledger** | **[reports/EVIDENCE.md](reports/EVIDENCE.md)** (`3,911` signed Celo Mainnet txs · `179` external Maker fills · `1,794` 2-leg arbs · Celoscan proofs) |
| **ERC-8004 Agent Identity** | **Agent `#9905`** on [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=9905) ([`agent-registration.json`](docs/.well-known/agent-registration.json)) |
| **Production EOA (Maker & Taker Wallet)** | [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) |
| **ERC-8021 Attribution Code** | `celo_7935fb97e273` (`0x63656c6f5f373933356662393765323733110080218021802180218021802180218021`) |
| **Textile Maker ID** | `cmv75ay6h00bq339u3x6gdicy` (`stitch-42220-e5036100`) |
| **Canonical Settlement Contracts** | Textile `LimitOrderReactor` [`0xa9AA0a64…35b3`](https://celoscan.io/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3) · Uniswap v3 `SwapRouter02` [`0x5615CDAb…abc4`](https://celoscan.io/address/0x5615CDAb10dc425a742d643d949a7F474C01abc4) · `Permit2` [`0x00000000…78BA3`](https://celoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |

---

## Production Mainnet Performance

> [!NOTE]
> **Synchronized Mainnet Audit Checkpoint (`2026-11-08 19:01 UTC` · Celo Mainnet Block `#82,263,550`):**
> **ERC-8004 Agent `#9905`** ([`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)) operates continuously 24/7 on Celo Mainnet (`42220`). All static figures in `README.md`, [`reports/EVIDENCE.md`](reports/EVIDENCE.md), and [`docs/STRATEGY.md`](docs/STRATEGY.md) are anchored to this verified block checkpoint and represent audited floor values. Live real-time balances and cumulative activity can be inspected at any time via the **[Live RPC Telemetry Dashboard](https://eugenennamdi.github.io/Skew/)**, **[Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)**, or **[Blockscout](https://celo.blockscout.com/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)**.

Starting from a single **`$195.00 USDT`** initial bankroll on Celo Mainnet (`42220`) with zero external stablecoin top-ups since inception, all verifiable on [Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) and detailed in [`reports/EVIDENCE.md`](reports/EVIDENCE.md):

- **Net Realized Trading Return — `$290.58` liquid stablecoin treasury equity (`+$95.58 USDT` net liquid gain · `+49.02%` cash-on-cash RoC) and `$296.43` total strategy value (`+$101.43 USDT` · `+52.02%` RoC):**
  - **Liquid stablecoin holdings (`$290.58`):** `194.58 USDT` (`$194.58`) + `35,768.44 cNGN` (`$25.92`) + `42,917.15 wARS` (`$25.95`) + `134.36 wBRL` (`$24.13`) + `20.00 USDC` (`$20.00`)—nearly the entire `$195.00` initial capital now sits in liquid `USDT` alone while all four local-currency market-making reserves are funded from realized profit.
  - **Autonomous gas reserve (`18.20 CELO` held on-chain · `$291.76` live mark-to-market wallet equity):** `$5.85 USDT` was autonomously converted into native `CELO` via `AUTO_GAS_REFILL` to fund `3,911` mainnet transactions without external gas top-ups.
- **`$207,057.11` cumulative 1-leg trade volume (`$414,114.22` two-leg settled notional · `$828,228.43` two-way ERC-20 transfer volume · `1,061.8x` 1-leg / `2,123.7x` two-leg capital turnover)** across **`3,911` signed Celo Mainnet transactions (`9,996` ERC-20 transfers across `34` distinct counterparties)** with **`99.82%` execution reliability** (`3,904 / 3,911` succeeded; `998 / 1,000` on the rolling attribution window).
- **Two-Way RFQ Market-Making Infrastructure (`179` external Maker fills · `$6,527.97` filled Maker volume + continuous 24/7 two-way quoting):** Engine 1 (`skew-stitch`) streams `1s` WebSocket indicative depth levels (`levels_for()`) and firm EIP-712 `Permit2` `DutchOrder` RFQ quotes (`decide_quote()`) across all 4 Textile FX corridors (`cNGN`, `wARS`, `wBRL`, `USDC` — `8 of 8` directional sides). Skew serves real order flow from independent on-chain agents and routers (`#9991`, `#9908`, `#9995`, `0xd770…eb67`, `0x7769…a734`), winning top-of-book and split-order `executeBatch` allocations up to **`$193.47` (`1,077.42 wBRL`, [`0xe0f685a5…9786`](https://celoscan.io/tx/0xe0f685a58f07ac76a07a1fc05e1b27a71cb560a3480eb45f6623dd1de5909786))**, **`$178.61` (`295,251 wARS`, [`0xb4f0a9ad…0896`](https://celoscan.io/tx/0xb4f0a9ad50452f187d5e4885a337dd210ba98b93d23b714a7fb963383e2e0896))**, **`$178.35` ([`0x68c3b989…2a83`](https://celoscan.io/tx/0x68c3b9899c73cb181a792a1d85d886a81f4d101a4fcadc297d8c219547542a83))**, **`$176.90` ([`0xbbff102f…51cd`](https://celoscan.io/tx/0xbbff102f3778308dd8c724e73c7f06d04f5d3b0b138307b9dd48a13e014751cd))**, **`$167.49` ([`0x3fb9d2f0…646d`](https://celoscan.io/tx/0x3fb9d2f03458368b92f64543fe1f781317a41b9e5bbf79bef2dcd656a000646d))**, and **`$140.28` (`193,716 cNGN`, [`0xd13ec8ec…937e`](https://celoscan.io/tx/0xd13ec8ec5b95d4b90e1bfe856da0e0881b38a01c6e833f225dbb11cb8ec8937e))**.
- **`1,794` two-leg cross-venue arbitrages (`$193,344.64` 1-leg / `$386,689.28` 2-leg Taker volume · `100%` firm-verified post-`verifyFirmArbQuote`):** Enforces bidirectional law-of-one-price parity (`textile -> uni` and inventory-first `uni -> textile`) between Textile RFQ and Celo Uniswap v3 while aborting slipped firm quotes at `0 gas` before signing, capturing dislocations up to **`+187.5 bps`** on `wARS/USDT` and **`+64.2 bps`** on `cNGN/USDT`.

| Engine / Subsystem | Settled Count | 1-Leg Volume (USD) | Realized Net Edge / Outcome | Counterparties & Venues |
| :--- | :---: | :---: | :--- | :--- |
| **Engine 1: RFQ Market Maker (`skew-stitch`)** | `179` external fills | `$6,527.97` | **`+$4.85 USDT`** (`+41.1 bps` shielded ask fills + `$193.47` & `$178.61` top-of-book wins) | External Takers (`#9991`, `#9908`, `#9995`, `0xd770…`, `0x7769…`) on `LimitOrderReactor` |
| **Engine 2: Cross-Venue Arbitrage (`skew-desk.mjs`)** | `1,794` 2-leg arbs (`3,588` txs) | `$193,344.64` | **`+$90.73 USDT` net liquid** (`+$96.58` pre-gas-allocation · `+48.6 bps` `cNGN` blitz · `+187.5 bps` peak `wARS`) | External Makers (`0x25A5…`, `#9908`, `#9976`) ◄──► Uniswap v3 `0.01%` |
| **Autonomous Treasury & Gas Manager (`skew-desk.mjs`)** | `280` swaps (`+36` setup / `7` reverted) | `$7,184.50` | **Active 4-corridor reserves** (`$290.58` liquid stablecoins + `18.20 CELO` gas reserve) | Uniswap v3 Pools (`0.01%` / `0.30%`) & Textile RFQ (`wBRL` rebalance) |
| **Total Verified Mainnet Floor (`Block #82,263,550`)** | **`3,911` signed EOA txs (`9,996` transfers)** | **`$207,057.11`** (`$414,114.22` 2-leg · `$828,228.43` 2-way · `1,061.8x`) | **`+$95.58 USDT` net liquid (`+49.02%` RoC · `$290.58` liquid / `$296.43` total strategy value)** | **All 4 Textile FX Corridors (`cNGN`, `wARS`, `wBRL`, `USDC`)** |

### Core Design Pillars → Code & On-Chain Proof

| Engineering Pillar | Architecture & Mechanism | Primary Code Implementation | On-Chain Verification |
| :--- | :--- | :--- | :--- |
| **1. Adaptive Quoting & Anti-Arb Defense** | Hard `max/min` Dual-Oracle Anti-Arb Shield + zero-restart `skew-policy.json` Rust hot-reloader (`2s` TTL) + post-fill `+1m/+5m` markout toxicity loop | [`effective_mid_for_side`](textile-stitch/src/pricing/skew.rs) · [`evaluateMarkoutAdjustments`](skew-desk.mjs) | [`0x51b95699…fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4) (`+41.1 bps` shielded refill) |
| **2. Capital Efficiency & Dual-Engine P&L** | 4-Corridor Maker (`179` fills) + Firm-Verified Bidirectional (`100%/50%/25%` + `98%` depth) Taker (`1,794` arbs) compounding `$195.00` to `$290.58` liquid (`1,061.8x` 1-leg turnover) | [`scanCorridor`](skew-desk.mjs) · [`verifyFirmArbQuote`](skew-desk.mjs) | [`0xe0f685a5…9786`](https://celoscan.io/tx/0xe0f685a58f07ac76a07a1fc05e1b27a71cb560a3480eb45f6623dd1de5909786) (`$193.47` Maker fill) · [`0xbbff102f…51cd`](https://celoscan.io/tx/0xbbff102f3778308dd8c724e73c7f06d04f5d3b0b138307b9dd48a13e014751cd) (`$176.90` split win) |
| **3. Time, Skew & Volatility Modeling** | Multi-corridor normalized skew ($w \cdot V_{\text{USDT}}$) + CBN/BCRA/BCB central-bank session clocks + rolling EWMA vol ($\lambda=0.94$) + structural FX basis shock detector | [`apply_corridor_policy_and_skew`](textile-stitch/src/pricing/skew.rs) · [`updateCorridorQuantState`](skew-desk.mjs) | `GET /llm` & `GET /status` (`CBN_LAGOS_*`, `BCRA_BUE_*`, `BCB_SAO_*`) |
| **4. Bounded AI Regime Supervision** | Out-of-band **Google Gemini 3.8 Flash** Desk Head over objective quant telemetry (no echoed rationales), hard-clamped above Dual-Oracle floor with fail-open fallback | [`runGeminiRiskSupervisor`](skew-desk.mjs) · [`clampLlmCorridorDecision`](skew-desk.mjs) | `GET /llm` (`status: "ACTIVE_BOUNDED"`, `45m` max pause clamp) |
| **5. Celo Open Rails & Microstructure Safety** | `800k gas` `wBRL` `MAX_TICK` (`17.04M gas`) shield + ERC-8004 `#9905` `registration-v1` + 35-byte ERC-8021 `celo_7935fb97e273` + MiniPay CIP-64 `feeCurrency` | [`isValidUniQuoteGas`](skew-desk.mjs) · [`append_erc8021_attribution`](textile-stitch/src/attribution.rs) | [`0x9019d6c7…3b50`](https://celoscan.io/tx/0x9019d6c71cfd1b73657afa9086892fdff9daddb5eb428e3be98d4059c0ad3b50) (`#9905` URI) · [`0x3329c8f6…7cd5`](https://celoscan.io/tx/0x3329c8f625f3314369f2066f7ed4518f0c5eb38a619f47aa5886979c58c77cd5) (`197k gas` wBRL RFQ) |

---

## Microstructure Challenges on Celo FX

Local-currency stablecoins on Celo (`cNGN`, `wARS`, `wBRL`) trade on two disconnected venues simultaneously: **Textile FX's RFQ book** (where makers quote around off-chain FX feeds) and **Celo Uniswap v3** (`0.01%` concentrated-liquidity pools). Operating continuous two-way liquidity across both venues exposes four structural failure modes that break standard market makers:

1. **Adverse selection when off-chain FX feeds lag Uniswap v3:** Whenever Textile's reference rate lags the on-chain pool (for example, quoting `1,383.8 cNGN/USDT` or `1,671.1 wARS/USDT` while Uniswap v3 trades at `1,378.7 cNGN` and `1,641.8 wARS`), takers lift a static maker's local currency on Textile and sell it into Uniswap v3 for an instant risk-free arbitrage—leaving the maker with a realized loss.
2. **Multi-corridor shared-USDT skew distortion & WebSocket restart drops:** A single wallet quoting 4 corridors against one shared `USDT` pool (`~$195 USDT` vs `~$25` per local token) naively computes `s = +0.84` on every pair even when inventory is balanced, and restarting Stitch to update `TOML` spreads drops active `wss://api.textilecredit.com/v2/maker/stream` RFQ sessions.
3. **Sub-`$100` depth blindness:** Standard taker bots only probe fixed large slices (`$100+`) and discard `status: "no_quote"` responses, missing actionable sub-`$100` maker orders even when Textile's `/v2/rfq/preview` returns the exact `availableSellAmount`.
4. **Malformed DEX pool ticks (`wBRL` `MAX_TICK` gas trap):** On Celo Mainnet, the `wBRL/USDT` `0.01%` Uniswap v3 pool (`0x01c3…A40F`) sits at `slot0.tick = 887,271` (`MAX_TICK - 1`). Any swap or naive rebalancer touching that pool traverses `2,350` empty `TickBitmap` words, burning **`17.04M gas` (`~3.45 CELO`)** or reverting outright.

---

## System Architecture

Skew runs two coordinated processes against the same Celo Mainnet EOA (`0xe503…7324`), combining **protected two-way market making** with **bounded AI regime supervision, multi-slice cross-venue arbitrage, and autonomous treasury management**:

```
                     Price, Quant & AI Signals                              Skew Dual-Engine Runtime (Celo 42220)
  ┌──────────────────────────────────────────────────────┐
  │ • Textile RFQ (/price, /preview & WebSocket stream)  │       ┌──────────────────────────────────────────────────────┐
  │ • Celo Uniswap v3 slot0() (2s Multicall3 poll)       │──────►│ Engine 1: skew-stitch (Patched Rust RFQ Maker)       │
  │ • Off-Chain & Parallel FX (dolarapi cripto/oficial,  │       │ • Dual-Oracle Shield: SELL >= max(P_textile, P_uni)  │
  │   open.er-api NGN/BRL) + CBN/BCRA/BCB Session Clock  │       │ • Multi-Corridor Normalized Skew (usdt_share_weight) │
  │ • EWMA Vol (λ=0.94) + Basis Shock + +1m/+5m Markouts │       │ • Zero-Restart Hot-Reload (skew-policy.json, 2s TTL) │
  │ • Bounded Gemini 3.8 Flash Desk Head (10m / spike)   │       └──────────────────────────┬───────────────────────────┘
  └──────────────────────────────────────────────────────┘                                  ▲ Atomic skew-policy.json
                              │                                                             │ (zero WS disconnects)
                              ▼                                                             │
  ┌──────────────────────────────────────────────────────┐                                  │
  │ Engine 2: skew-desk.mjs (Quant, LLM & Taker Desk)    │──────────────────────────────────┼───────┐
  │ • Bounded Gemini LLM Supervisor (clamped, fail-open) │                                  │       │
  │ • EWMA Vol + Structural Basis + Markout Policy Loop  │──────►  Textile LimitOrderReactor (0xa9AA0a64…35b3)
  │ • Multi-slice (100% / 50% / 25%) + 98% depth sizing  │       & Uniswap v3 SwapRouter02   (0x5615CDAb…abc4)
  │ • Auto-refill & unwind (~$25 per corridor + CELO)    │         [Every tx tagged with 35-byte ERC-8021 suffix]
  │ • 800k gas QuoterV2 guard (blocks 17M-gas wBRL pool) │
  └──────────────────────────────────────────────────────┘
```

---

## Quantitative Pricing & Execution Mechanics

### 1. Dual-Oracle Anti-Arb Shield (`textile-stitch/src/pricing/skew.rs`)
Every 2 seconds inside Stitch's batched Multicall3 loop (`refresh_celo_dex_reference`), Skew reads `slot0()` from Celo's `0.01%` Uniswap v3 pools (`cNGN/USDT`, `wARS/USDT`, `USDC/USDT`). Before applying inventory spreads, `effective_mid_for_side()` anchors each side of the maker book to the safer of the two venues:

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{textile}}, P_{\text{uni}}\right), \qquad P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{textile}}, P_{\text{uni}}\right)$$

- **Guaranteed positive replenishment margin:** Because our `SELL` floor is never below Uniswap v3, every maker ask fill (e.g. selling `cNGN` at `1,372.9 cNGN/USDT`) is immediately refilled by Engine 2 on Uniswap v3 (`0.01%` pool at `1,378.7 cNGN/USDT`), locking in **`+41.1 bps` net profit per fill** instead of suffering adverse selection.

### 2. Time, Volatility, Markouts, Bounded Gemini LLM & Zero-Restart Rust Hot-Reload (`skew.rs` & `skew-desk.mjs`)
Across 6-decimal (`cNGN`, `USDC`, `USDT`) and 18-decimal (`wARS`, `wBRL`) tokens, Skew computes **multi-corridor normalized USD inventory imbalance** $s \in [-1, +1]$ (allocating `usdt_share_weight` $w$ of shared wallet `USDT` against each corridor's `~$24–$26` target reserve so $s$ centers around $0.0$) and shifts per-side spreads dynamically:

$$s = \frac{w \cdot V_{\text{USDT}} - V_{\text{collateral}}}{w \cdot V_{\text{USDT}} + V_{\text{collateral}}}, \qquad \text{spread}_{\text{buy}} = \text{clamp}(\text{base}_{\text{buy}} - \gamma s, 1, 150), \qquad \text{spread}_{\text{sell}} = \text{clamp}(\text{base}_{\text{sell}} + \gamma s, 1, 150)$$

- **Top-of-book `1–2 bps` bid capture:** When holding excess `USDT`, `BUY` spreads tighten down to **`1–2 bps`** to win institutional and split-router order flow (`$193.47 wBRL`, `$178.61`, `$178.35`, `$176.90`, and `$167.49 wARS` fills; `$140.28 cNGN` fills), which Engine 2 unwinds back to `USDT`.
- **Rolling EWMA Volatility ($\lambda = 0.94$), Structural Basis Shock & Post-Fill Markouts (`+1m` / `+5m`):**
  - `updateCorridorQuantState()` tracks per-corridor realized log-return EWMA volatility (`ewmaVolBps` → `volBufferBps`), slow structural FX basis (`alpha = 0.05` so `cNGN`'s normal `+270 bps` on-chain basis quotes tightly while sudden `>80 bps` basis shocks add `basisBufferBps`), and a 72-hour observed devaluation carry blend (`dailyCarryBps`).
  - `evaluateMarkoutAdjustments()` scores external Maker RFQ fills at **`+1m` and `+5m`** after settlement: negative markouts (adverse selection) widen `markoutBufferBps` automatically (`+5` to `+25 bps`), while positive markouts tighten spreads by `-1 bps` to capture benign volume.
- **Regional Central-Bank Session & Weekend Closure Quoting (`computeRegionalBankingSession`):** Evaluates UTC day and hour against local fiat settlement calendars—**CBN Lagos EFEMS** (`Mon–Fri 07:00–15:00 UTC` for `cNGN`), **BCRA / MAE Buenos Aires** (`Mon–Fri 13:00–18:00 UTC` for `wARS`), **BCB PTAX / B3 São Paulo** (`Mon–Fri 12:00–20:00 UTC` for `wBRL`), and **24/7 Global USD** (`USDC`). During overnight hours and 72-hour weekend closures when fiat rails cannot settle, Skew widens ask buffers by **`+1` to `+6 bps`** and scales devaluation carry by **`1.25x–3.0x`**.
- **Out-of-Band Bounded Gemini LLM Desk Head (`runGeminiRiskSupervisor`):** Every 10 minutes (and immediately on volatility, basis-shock, or negative-markout spikes), `skew-desk.mjs` queries **Google Gemini (`gemini-3.8-flash`)** over objective numerical corridor telemetry (never echoing prior LLM rationales, eliminating self-reinforcing pause loops). Outputs are hard-clamped by `clampLlmCorridorDecision()` (`addBuyBps` $\in [-2, 25]$, `addSellBps` $\in [-2, 40]$, `gammaBps` $\in [2, 15]$, `pauseMinutes` $\le 45$, plus a calm-market top-of-book clamp keeping weekday spreads within `2–6 bps` when `ewmaVolBps < 12` and `basisShockBps < 60`), **can never quote below Rust's Dual-Oracle Anti-Arb floor**, and fail open to deterministic quant math if `GEMINI_API_KEY` is unset or rate-limited.
- **Zero-Restart `skew-policy.json` Hot-Reload into Rust (`syncStitchRuntimePolicy` → `adjust_spread_for_corridor`):** Instead of killing and restarting Stitch, `skew-desk.mjs` atomically writes `skew-policy.json` (`tmp` → `renameSync`), and Rust `skew.rs` refreshes it via `mtime` check every `2 seconds`—applying per-corridor spreads, `gamma_bps`, `usdt_share_weight`, and per-side pauses in memory across both indicative WebSocket levels (`levels_for`) and firm quotes (`decide_quote`).

### 3. Bidirectional Multi-Slice (`100% / 50% / 25%`) + Zero-Gas Firm-Quote Guard (`skew-desk.mjs`)
Every `3.5 seconds`, `skew-desk.mjs` scans all four corridors in both directions (`textile -> uni` and `uni -> textile`) to enforce law-of-one-price parity between Textile RFQ and Celo Uniswap v3 while recycling local-currency inventory:
1. **Multi-slice & single-maker top-of-book sizing (`computeSliceSizesUsdt`):** Computes candidate trade sizes across **`100%`, `50%`, and `25%` of liquid `USDT`** (up to `$150` per trade, plus top-of-book single-maker probes) and selects whichever slice maximizes net dollar profit (`edgeUsd`).
2. **Zero-gas pre-broadcast firm-quote guard (`verifyFirmArbQuote`):** Because indicative `/v2/rfq/preview` levels can diverge from firm EIP-712 `DutchOrder` amounts when split across makers, `skew-desk.mjs` decodes the exact firm `outputs[0]` amount and aborts at **`0 gas`** unless net post-gas edge clears `MIN_FIRM_NET_EDGE_USD` (`$0.018`) and `MIN_FIRM_NET_EDGE_BPS` (`1.2 bps`)—supporting both `textile -> uni` sweeps and inventory-first `uni -> textile` reverse arbitrages.
3. **Adaptive sub-slice resizing & anti-self-trade filter (`isSelfMakerOrder`):** Automatically re-quotes at `98%` of `availableSellAmount` on partial depth and inspects `DutchOrder.OrderInfo.swapper` to guarantee the Taker never lifts our own Maker (`0xe503…7324`).

### 4. Production Safety Guardrails & Dual-Engine Coordination
- **Shared-EOA Nonce Safety (`Engine 1` vs `Engine 2`):** Running Engine 1 (`skew-stitch` Rust Maker) and Engine 2 (`skew-desk.mjs` Node.js Taker & Rebalancer) on the same EOA (`0xe503…7324`) never causes EVM nonce collisions because **Engine 1 never broadcasts EOA transactions during quoting**—it signs off-chain EIP-712 `Permit2` `DutchOrder` payloads (which use unordered `Permit2` bit-position nonces and are submitted on-chain by the counterparty Taker via `LimitOrderReactor`). **Only Engine 2 submits active EOA transactions** using sequential account nonces, guarded by `isSelfMakerOrder(calldata)`.
- **`wBRL` `MAX_TICK` (`800k gas`) shield (`isValidUniQuoteGas`):** Rejects any Uniswap v3 quote whose `QuoterV2` `gasEstimate` exceeds `800,000 gas`, preventing the `17.04M gas` (`3.45 CELO`) `wBRL/USDT` pool from draining gas and routing `wBRL` inventory rebalances through Textile RFQ (`~197k gas`).
- **Native `CELO` gas top-up (`AUTO_GAS_REFILL`) vs CIP-64 `feeCurrency`:** While our web dashboard (`docs/index.html`) detects MiniPay (`window.ethereum.isMiniPay`) and attaches Celo CIP-64 `feeCurrency: USDT` for retail wallet UX, Engine 2's automated execution intentionally maintains a native `CELO` gas buffer (swapping `$2.00 USDT -> ~24.2 CELO` on Uniswap v3 `0.30%` whenever `CELO < 3.0`). Paying gas in native `CELO` allows standard EIP-1559 Type-2 transactions with minimal base gas overhead and avoids CIP-64 `FeeCurrencyDirectory` oracle-lookup gas surcharges during latency-sensitive 2-leg arbitrages.
- **Single-path ERC-8021 tagging:** Both Rust (`append_erc8021_attribution` in `src/chain/tx.rs`) and Node.js (`sendTagged` in `skew-desk.mjs`) route every outbound transaction through a single wrapper that idempotently appends the 35-byte `celo_7935fb97e273` suffix.

---

## On-Chain Verification Matrix

Every claim in this repository is backed by verifiable settlements on Celo Mainnet (`42220`). Full ledger in [`reports/EVIDENCE.md`](reports/EVIDENCE.md):

| Capability | On-Chain Verification (Celoscan) |
| :--- | :--- |
| **`$193.47` Institutional `wBRL/USDT` Maker Fill & Top-of-Book `wARS` Wins** | Served **`192.77 USDT` (`1,077.42 wBRL`)** ([`0xe0f685a5…9786`](https://celoscan.io/tx/0xe0f685a58f07ac76a07a1fc05e1b27a71cb560a3480eb45f6623dd1de5909786)), **`178.61 USDT` (`295,251 wARS`)** ([`0xb4f0a9ad…0896`](https://celoscan.io/tx/0xb4f0a9ad50452f187d5e4885a337dd210ba98b93d23b714a7fb963383e2e0896)), **`178.35 USDT`** ([`0x68c3b989…2a83`](https://celoscan.io/tx/0x68c3b9899c73cb181a792a1d85d886a81f4d101a4fcadc297d8c219547542a83)), **`176.90 USDT` (`90.7%` of batch)** ([`0xbbff102f…51cd`](https://celoscan.io/tx/0xbbff102f3778308dd8c724e73c7f06d04f5d3b0b138307b9dd48a13e014751cd)), and **`167.49 USDT`** ([`0x3fb9d2f0…646d`](https://celoscan.io/tx/0x3fb9d2f03458368b92f64543fe1f781317a41b9e5bbf79bef2dcd656a000646d)) |
| **`$135.10` & `$133.42` Multi-Slice Cross-Venue Arbitrages (`wARS/USDT`)** | Lifted `222,865 wARS` for `135.00 USDT` on Textile ([`0xc53b6616…08c5`](https://celoscan.io/tx/0xc53b661608c5433b3c462f1889a120a2f43d2df5bf6b7a38756bd0c475f9c158)) → unwound 7s later on Uniswap v3 `0.01%` for **`135.10 USDT` (`+$0.10 USDT` net)** ([`0x8c3811cc…ac16`](https://celoscan.io/tx/0x8c3811ccac166c5577952f5bd830295bd5365529f8bd29c2b895f56e57f4b2fc)); and `$133.36 → $133.42 USDT` ([`0xd0855bf8…4a1b`](https://celoscan.io/tx/0xd0855bf83154261c63c9939e14164501aa9c3f1d74a15bc8f92a35cf215a4a1b) / [`0xb4a0071e…425d`](https://celoscan.io/tx/0xb4a0071e8b077e1297ec306b21a5b0855f0ef01d07a49bf90b6ca3bd2787425d)) |
| **`$140.28` Maker Fill → Instant Uniswap v3 Unwind (`cNGN/USDT`)** | External agent `#9908` lifted `140.28 USDT` (`193,716 cNGN`) from our Maker ([`0xd13ec8ec…937e`](https://celoscan.io/tx/0xd13ec8ec5b95d4b90e1bfe856da0e0881b38a01c6e833f225dbb11cb8ec8937e)); 27s later `skew-desk.mjs` unwound on Uniswap v3 `0.01%` for **`140.29 USDT`** ([`0x6f82fbaa…565d`](https://celoscan.io/tx/0x6f82fbaa43677a010fcc6da464719dd4edf1998468d0d5c5c2f79cf64a4f565d)) |
| **Shielded Maker Fill → `+41.1 bps` DEX Refill (`cNGN/USDT`)** | External taker `#9995` paid `18.0620 USDT` for `24,799 cNGN` ([`0x51b95699…fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4)); refilled `24,800 cNGN` on Uniswap v3 for `17.9880 USDT` ([`0x28d4e714…c6d5`](https://celoscan.io/tx/0x28d4e71468195aae4a1275a32dc935b2936e94864838267c3ecac3e8b436c6d5)), netting **`+$0.0740 USDT` (`+41.1 bps`)** |
| **Institutional `$86.48` & `$80.00` Maker Fills (`wBRL` & `cNGN`)** | Served to `#9991`: `459.57 wBRL → 86.48 USDT` ([`0x9e9abd6d…5a5a`](https://celoscan.io/tx/0x9e9abd6d1ebb31a309642d6e58efb7f3e68d4d50e9942ca266bc49beaf7d5a5a)) and `110,627 cNGN → 80.00 USDT` ([`0x855d155c…a4a9`](https://celoscan.io/tx/0x855d155c063195460508b15364a841482041bf7c3e458ff47d2a3d33b859a4a9)) |
| **`+187.5 bps` Cross-Venue Arbitrage (`wARS/USDT`)** | Bought `17,719 wARS` for `10.59 USDT` on Textile ([`0xb202a9f1…c995`](https://celoscan.io/tx/0xb202a9f1e159b37f6b8f662652141903b293246a8810ebe7ae8dfabb9b1cc995)) → sold on Uniswap v3 8s later for `10.79 USDT` ([`0x20da628c…2cef`](https://celoscan.io/tx/0x20da628c6a545ea95a2e9268d587b1e63be758e4fd30f147ce668a628ced2cef)) |
| **`53x` High-Frequency `cNGN/USDT` Arbitrage Run (`106` txs)** | Recycled `$25` slices across `$2,656.44` volume in 27 minutes for **`+$6.44 USDT` (`+48.6 bps` avg)** ([first leg `0xe8b19d37…80cf`](https://celoscan.io/tx/0xe8b19d37fda658805c695456c273b6b7f99c6e139fd9b0b6353df4f4764b80cf) to [53rd unwind `0xc9b92bcd…deb1`](https://celoscan.io/tx/0xc9b92bcdb87d7890eaca9060c7e07d3b34feca9691cfb72e4f4642e70ac8deb1)) |
| **Gas-Shielded `wBRL` RFQ Rebalance & `CELO` Gas Top-Up** | Bypassed `17M gas` Uniswap pool via `197k gas` Textile RFQ unwind ([`0x3329c8f6…7cd5`](https://celoscan.io/tx/0x3329c8f625f3314369f2066f7ed4518f0c5eb38a619f47aa5886979c58c77cd5)) · `2.00 USDT → 24.22 CELO` top-up ([`0xf63c6f1b…250c`](https://celoscan.io/tx/0xf63c6f1b9657fccccc327db8e2493fa872846f86262ca74013955a265c0f250c)) |
| **ERC-8004 `#9905` Identity Mint & `registration-v1` URI** | Mint ([`0x2a7659bf…8451`](https://celoscan.io/tx/0x2a7659bf72cd2c68295c488f7937d9bd2e6126f4155972d6be86dbbe01338451)) · On-chain base64 `eip-8004#registration-v1` update ([`0x9019d6c7…3b50`](https://celoscan.io/tx/0x9019d6c71cfd1b73657afa9086892fdff9daddb5eb428e3be98d4059c0ad3b50)) |

---

## Continuous Operations & Celo FX Roadmap

Skew is built and operated as permanent market-making infrastructure on Celo Mainnet (`42220`):

- **Expanded regional stablecoin coverage:** Extending `skew-stitch` and `skew-desk.mjs` corridor support to emerging Celo local-currency pairs (`wCOP`, `wMXN`, `wCLP`, `wPEN`, and `IDRX`) as concentrated-liquidity depth matures across Uniswap v3/v4 and Mento.
- **Direct synthetic cross-fiat quoting (`cNGN ↔ wARS ↔ wBRL`):** Triangle pricing across two local legs through internal `USDT` netting so cross-border routers can settle local-to-local FX in a single RFQ fill without paying double taker spreads.
- **Automated capital scaling & vault accounting:** Dynamic `usdt_share_weight` allocation scaled proportionally to corridor markout Sharpe ratios and 24-hour RFQ turnover.

---

## Code Map & HTTP API

```
skew-desk.mjs                       Node.js Taker, EWMA/markout quant engine, bounded Gemini 3.8 Desk Head & HTTP server
stitch.toml                         4-corridor Celo Mainnet config (cNGN, wARS, wBRL, USDC; agent_id = 9905)
run-vm.sh                           24/7 production launcher for Engine 1 (skew-stitch) + Engine 2 (skew-desk)
docs/
  index.html                        Live telemetry dashboard, normalized skew simulator & MiniPay CIP-64 detector
  STRATEGY.md                       Deep dive: Dual-Oracle math, EWMA/markouts, bounded LLM, MAX_TICK & benchmark
  .well-known/agent-registration.json  ERC-8004 registration-v1 metadata for Agent #9905
reports/
  EVIDENCE.md                       Complete on-chain fill, split-router Maker wins, arbitrage & PnL audit
test/
  skew-desk.test.mjs                25 offline Node unit tests (skew, shield, EWMA, markouts, LLM clamps, firm-guard, hot-reload)
textile-stitch/
  src/pricing/skew.rs               Rust Dual-Oracle Shield + normalized skew + 2s zero-restart skew-policy.json cache
  src/rfq/responder.rs              Firm RFQ quoting (decide_quote) & 1s WebSocket orderbook levels (levels_for)
  src/rfq/mod.rs                    2s Multicall3 Celo Uniswap v3 slot0() reference poller
  src/attribution.rs                35-byte ERC-8021 calldata suffix builder & unit tests
```

### Telemetry & Control Endpoints (`skew-desk.mjs`)

| Endpoint | Description |
| :--- | :--- |
| `GET /` | Live web dashboard (`docs/index.html`) |
| `GET /health` | Service liveness & current scan state |
| `GET /status` | Live balances, NAV, normalized inventory skew, Risk Officer decisions, and corridor quotes |
| `GET /trades` | Executed cross-venue arbitrages (`trades.jsonl`) and recent ERC-8021 on-chain activity |
| `GET /llm` | Bounded Gemini 3.8 Flash Desk Head decisions, EWMA volatility, basis shocks, and `+1m/+5m` markouts |
| `POST /scan` | Trigger an immediate 4-corridor RFQ + Uniswap v3 scan |

---

## Quickstart (Fresh Machine — Zero Secrets Required)

Requires **Node.js `>= 20.0.0`** (see [`.nvmrc`](.nvmrc)). By default (`LIVE=0`), `skew-desk.mjs` runs in **read-only telemetry and sandbox mode**—it never signs or sends transactions unless `LIVE=1` and `STITCH_PRIVATE_KEY` are explicitly provided, and fails open cleanly to deterministic quant math when `GEMINI_API_KEY` is unset.

```bash
git clone https://github.com/eugenennamdi/Skew.git
cd Skew
npm ci                # Clean install from package-lock.json
npm run build         # Syntax & module check across skew-desk.mjs and test suite
npm test              # Run 25 offline Node unit tests (0 network calls, 0 secrets needed)
npm run test:rust     # Run 770 offline Rust unit tests (pricing, hot-reload, responder & ERC-8021)
npm run demo          # Offline sandbox verification (outputs JSON proof and exits 0)
npm run check         # Live read-only Celo Mainnet (42220) RPC + Textile RFQ 4-corridor check
npm start             # Start local telemetry dashboard at http://localhost:8080
```

### Rust Engine 1 (`skew-stitch`) Build & Unit Tests

```bash
cd textile-stitch
cargo build --release --bin stitch                      # Compile production skew-stitch binary
# --no-default-features runs pure pricing, hot-reload, responder & ERC-8021 unit tests offline
cargo test --no-default-features --lib pricing::skew
cargo test --no-default-features --lib attribution
cargo test --no-default-features --lib rfq::responder
```

### Environment Variables ([`.env.example`](.env.example))

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CELO_RPC_URL` | `https://forno.celo.org` | Celo Mainnet (`42220`) JSON-RPC endpoint |
| `LIVE` | `0` | Set to `1` to enable live on-chain Taker, Treasury & policy hot-reload execution |
| `AUTO_REFILL` | `0` | Set to `1` to enable autonomous two-way Maker-to-DEX inventory unwind & refill |
| `STITCH_PRIVATE_KEY` | *(empty in sandbox)* | `0x`-prefixed 64-hex Celo EOA key (validated on startup; required only when `LIVE=1`) |
| `GEMINI_API_KEY` | *(empty in sandbox)* | Optional Google Gemini API key for Bounded LLM Desk Head (fails open if unset) |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini model ID (`gemini-3.8-flash` with auto-fallback chain) |
| `SKEW_GAMMA_BPS` | `6` | Baseline Avellaneda-Stoikov inventory risk-aversion $\gamma$ (`bps`, tuned in `[2, 15]`) |
| `SKEW_POLICY_FILE` | `./skew-policy.json` | Atomic zero-restart policy bridge read every `2s` by Rust `skew-stitch` |
| `MAX_SLICE_USDT` | `150` | Maximum single-trade `USDT` slice for Multi-Slice (`100% / 50% / 25%`) sizing |
| `MIN_EDGE_USD` | `0.024` | Minimum preview net dollar profit (`USDT`) before requesting a firm RFQ quote |
| `MIN_FIRM_NET_EDGE_USD` | `0.018` | Hard firm `DutchOrder` post-gas floor (`verifyFirmArbQuote`; aborts at `0 gas` if lower) |
| `SCAN_INTERVAL_MS` | `3500` | Cross-venue scan & telemetry refresh interval (`ms`) |
| `PORT` | `8080` | Local telemetry & dashboard HTTP server port (`/status`, `/trades`, `/llm`, `/health`) |

---

## License & Security

- **Security Policy:** See [`SECURITY.md`](SECURITY.md) and [`.gitleaks.toml`](.gitleaks.toml).
- **License:** [`skew-desk.mjs`](skew-desk.mjs) and [`docs/`](docs/index.html) are licensed under [`MIT`](LICENSE). The [`textile-stitch/`](textile-stitch/LICENSE) Rust workspace is extended from [`textile-protocol/textile-stitch`](https://github.com/textile-protocol/textile-stitch) under `AGPL-3.0-or-later`.
