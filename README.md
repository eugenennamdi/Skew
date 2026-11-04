# <img src="docs/icons/skew-logo.svg" width="28" height="28" align="absmiddle" alt="Skew Logo" /> Skew

**An institutional-grade, AI-supervised FX market maker and cross-venue arbitrage desk on Celo.** Skew quotes continuous two-way liquidity across all four **Textile FX** corridors (**cNGN**, **wARS**, **wBRL**, and **USDC** against **USDT**) through a modified Rust **Stitch** filler with zero-restart policy hot-reloading, while a companion Node.js quant & AI desk supervises regime risk via **Google Gemini 3.8 Flash**, scores post-fill markouts, arbitrages cross-venue dislocations against Celo Uniswap v3, and rebalances multi-currency inventory autonomously on-chain.

Built for **Celo · Agents on Open Rails** (*Open Corridors: Textile FX* track, Chain ID `42220`). Every transaction sent by either engine is signed by **ERC-8004 Agent `#9905`** and carries the 35-byte ERC-8021 attribution suffix **`celo_7935fb97e273`**.

> **🔴 Live 24/7 RPC Telemetry & Quote Simulator:** **[https://eugenennamdi.github.io/Skew/](https://eugenennamdi.github.io/Skew/)** — *Verify live Maker uptime, real-time Celo Mainnet (`42220`) treasury balances, 4-corridor `slot0()` spreads, normalized Avellaneda-Stoikov skew, and **`+$63.38 USDT` (`+32.50%` RoC)** net positive trading return in real time.*

| | Link / Identifier |
| :--- | :--- |
| **Live Telemetry Dashboard (24/7 RPC)** | **[https://eugenennamdi.github.io/Skew/](https://eugenennamdi.github.io/Skew/)** (live Celo RPC + Blockscout v2 stream + MiniPay `isMiniPay` / CIP-64 ready) |
| **Strategy & Microstructure Write-Up** | **[docs/STRATEGY.md](docs/STRATEGY.md)** (Dual-Oracle shield, normalized skew, EWMA vol, markouts, bounded Gemini LLM, `MAX_TICK` guard) |
| **On-Chain Evidence & PnL Ledger** | **[reports/EVIDENCE.md](reports/EVIDENCE.md)** (`2,675` signed Celo Mainnet txs · `134` Maker fills · `1,286` 2-leg arbs · Celoscan proofs) |
| **ERC-8004 Agent Identity** | **Agent `#9905`** on [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=9905) ([`agent-registration.json`](docs/.well-known/agent-registration.json)) |
| **Agent Wallet (Maker & Taker EOA)** | [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) |
| **ERC-8021 Attribution Code** | `celo_7935fb97e273` (`0x63656c6f5f373933356662393765323733110080218021802180218021802180218021`) |
| **Textile Maker ID** | `cmv75ay6h00bq339u3x6gdicy` (`stitch-42220-e5036100`) |
| **Canonical Settlement Contracts** | Textile `LimitOrderReactor` [`0xa9AA0a64…35b3`](https://celoscan.io/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3) · Uniswap v3 `SwapRouter02` [`0x5615CDAb…abc4`](https://celoscan.io/address/0x5615CDAb10dc425a742d643d949a7F474C01abc4) · `Permit2` [`0x00000000…78BA3`](https://celoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |

---

## Results on Celo Mainnet

> [!NOTE]
> **Point-in-Time Floor Snapshot (`2026-11-04 06:11 UTC` · Celo Mainnet Block `#81,871,867`):**
> **ERC-8004 Agent `#9905`** ([`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)) quotes and arbitrages autonomously 24/7 on Celo Mainnet (`42220`). All static metrics in this repository (`README.md`, [`reports/EVIDENCE.md`](reports/EVIDENCE.md), and [`docs/STRATEGY.md`](docs/STRATEGY.md)) are synchronized to this verified checkpoint and represent **lower-bound floor minimums**. Human and AI judges verifying live cumulative totals should check the **[Live RPC Telemetry Dashboard](https://eugenennamdi.github.io/Skew/)** (`GET /status`, `GET /llm`) or inspect the wallet directly on **[Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)** / **[Blockscout](https://celo.blockscout.com/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)**.

Starting from a **`$195.00 USDT`** initial bankroll on Celo Mainnet (`42220`) with zero external stablecoin top-ups since launch, all verifiable on [Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) and audited in [`reports/EVIDENCE.md`](reports/EVIDENCE.md):

- **Net Positive Trading Return — `$258.38` total strategy value (`$195.00` initial `USDT` bankroll + `+$63.38 USDT` net realized trading profit · `+32.50%` return on capital):** Broken down into **`$252.53` liquid stablecoin treasury equity** (`176.76 USDT` + `$18.00 cNGN` + `$14.93 wARS` + `$27.86 wBRL` + `$14.98 USDC`) plus **`$5.85 USDT` autonomously converted into native `CELO` gas reserves** (`28.50 CELO` held on-chain). Even on liquid stablecoins alone (excluding gas reserves), net cash-on-cash gain is **`+$57.53 USDT` (`+29.50%`)**.
- **`$136,490.63` cumulative 1-leg trade volume (`$272,981.26` two-leg notional · `700.0x` capital turnover)** across **`2,675` signed Celo Mainnet transactions (`6,860` ERC-20 transfers)** with **`99.9%` execution reliability** (`2,672 / 2,675` succeeded).
- **Foundational Ecosystem Liquidity Infrastructure (`134` external Maker fills · `$5,208.24` filled Maker volume + continuous 24/7 two-way quoting):** Engine 1 (`skew-stitch`) streams `1s` WebSocket indicative depth levels (`levels_for()`) and firm EIP-712 `Permit2` `DutchOrder` RFQ quotes (`decide_quote()`) across all 4 Textile FX corridors (`cNGN`, `wARS`, `wBRL`, `USDC` — `8 of 8` directional sides). Skew directly powered competing hackathon agents (`#9991 Kiyoshi`, `#9908 Naira Desk`, `#9995 naira-maker`), winning institutional split-order `executeBatch` allocations up to **`$178.61 USDT` (`295,251 wARS`, [`0xb4f0a9ad…0896`](https://celoscan.io/tx/0xb4f0a9ad50452f187d5e4885a337dd210ba98b93d23b714a7fb963383e2e0896))**, **`$178.35 USDT` ([`0x68c3b989…2a83`](https://celoscan.io/tx/0x68c3b9899c73cb181a792a1d85d886a81f4d101a4fcadc297d8c219547542a83))**, **`$176.90 USDT` ([`0xbbff102f…51cd`](https://celoscan.io/tx/0xbbff102f3778308dd8c724e73c7f06d04f5d3b0b138307b9dd48a13e014751cd))**, and **`$140.28 USDT` (`193,716 cNGN`, [`0xd13ec8ec…937e`](https://celoscan.io/tx/0xd13ec8ec5b95d4b90e1bfe856da0e0881b38a01c6e833f225dbb11cb8ec8937e))**.
- **`1,286` two-leg cross-venue arbitrages (`$125,409.10` 1-leg Taker volume · `100%` profitable):** Enforcing law-of-one-price parity between Textile RFQ and Celo Uniswap v3 while recycling local-currency inventory across price dislocations up to **`+187.5 bps`** on `wARS/USDT` and **`+64.2 bps`** on `cNGN/USDT`.

| Engine / Role | Settled Count | 1-Leg Volume (USD) | Realized Net Edge / Outcome | Counterparties & Venues |
| :--- | :---: | :---: | :--- | :--- |
| **Engine 1: RFQ Maker (`skew-stitch`)** | `134` external fills | `$5,208.24` | **`+$3.64 USDT`** (`+41.1 bps` shielded ask fills + `$178.61` split-router wins) | External Takers (`#9991`, `#9908`, `#9995`) on `LimitOrderReactor` |
| **Engine 2: Cross-Venue Arbitrage (`skew-desk.mjs`)** | `1,286` 2-leg arbs (`2,572` txs) | `$125,409.10` | **`+$59.74 USDT`** (`+48.6 bps` avg on `53x cNGN`, `+187.5 bps` peak on `wARS`) | External Makers (`#9929`, `#9908`, `#9976`) ◄──► Uniswap v3 `0.01%` |
| **Autonomous Treasury & Gas Manager (`skew-desk.mjs`)** | `65` swaps (`+38` setup/approvals) | `$5,873.29` | **Inventory & gas replenishment** (`$252.53` liquid equity + `$5.85` `CELO` gas reserve) | Uniswap v3 Pools (`0.01%` / `0.30%`) & Textile RFQ (`wBRL` rebalance) |
| **Total Verified Strategy Floor** | **`2,675` signed EOA txs (`6,860` transfers)** | **`$136,490.63`** (`$272,981.26` 2-leg · `700.0x`) | **`+$63.38 USDT` net profit (`+32.50%` RoC · `$258.38` total strategy value)** | **All 4 Textile FX Corridors (`cNGN`, `wARS`, `wBRL`, `USDC`)** |

### Hackathon Judging Pillars → Code & On-Chain Proof

| Judging Pillar | How Skew Solves It | Code Reference | Live Verification |
| :--- | :--- | :--- | :--- |
| **1. Originality & Adaptive Quoting** | Hard `max/min` Dual-Oracle Anti-Arb Shield + zero-restart `skew-policy.json` Rust hot-reloader (`2s` TTL) + post-fill `+1m/+5m` markout toxicity loop | [`effective_mid_for_side`](textile-stitch/src/pricing/skew.rs) · [`evaluateMarkoutAdjustments`](skew-desk.mjs) | [`0x51b95699…fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4) (`+41.1 bps` shielded refill) |
| **2. Strategy P&L & Capital Efficiency** | Dual-Engine Maker (`134` fills) + Multi-Slice (`100%/50%/25%`) + `availableSellAmount` (`98%`) Taker (`1,286` arbs) turning `$195.00` into `$258.38` (`700.0x` turnover) | [`scanCorridor`](skew-desk.mjs) · [`computeSliceSizesUsdt`](skew-desk.mjs) | [`0xbbff102f…51cd`](https://celoscan.io/tx/0xbbff102f3778308dd8c724e73c7f06d04f5d3b0b138307b9dd48a13e014751cd) (`$176.90` Maker win) · [`0xd0855bf8…4a1b`](https://celoscan.io/tx/0xd0855bf83154261c63c9939e14164501aa9c3f1d74a15bc8f92a35cf215a4a1b) (`$133.36` arb) |
| **3. Time, Skew & Volatility Awareness** | Multi-corridor normalized skew ($w \cdot V_{\text{USDT}}$) + CBN/BCRA/BCB banking session clocks + rolling EWMA vol ($\lambda=0.94$) + structural FX basis shock detector | [`apply_corridor_policy_and_skew`](textile-stitch/src/pricing/skew.rs) · [`updateCorridorQuantState`](skew-desk.mjs) | `GET /llm` & `GET /status` (`CBN_LAGOS_*`, `BCRA_BUE_*`, `BCB_SAO_*`) |
| **4. LLM-Adaptive Market Maker** | Out-of-band **Google Gemini 3.8 Flash** Desk Head over objective quant telemetry (no echoed rationales), hard-clamped above Dual-Oracle floor with fail-open fallback | [`runGeminiRiskSupervisor`](skew-desk.mjs) · [`clampLlmCorridorDecision`](skew-desk.mjs) | `GET /llm` (`status: "ACTIVE_BOUNDED"`, `45m` max pause clamp) |
| **5. Celo Open Rails & Microstructure Safety** | `800k gas` `wBRL` `MAX_TICK` (`17.04M gas`) shield + ERC-8004 `#9905` `registration-v1` + 35-byte ERC-8021 `celo_7935fb97e273` + MiniPay CIP-64 `feeCurrency` | [`isValidUniQuoteGas`](skew-desk.mjs) · [`append_erc8021_attribution`](textile-stitch/src/attribution.rs) | [`0x9019d6c7…3b50`](https://celoscan.io/tx/0x9019d6c71cfd1b73657afa9086892fdff9daddb5eb428e3be98d4059c0ad3b50) (`#9905` URI) · [`0x3329c8f6…7cd5`](https://celoscan.io/tx/0x3329c8f625f3314369f2066f7ed4518f0c5eb38a619f47aa5886979c58c77cd5) (`197k gas` wBRL RFQ) |

---

## The Problem

Local-currency stablecoins on Celo (`cNGN`, `wARS`, `wBRL`) trade on two disconnected venues at once: **Textile FX's RFQ book** (where makers quote around an off-chain FX feed) and **Celo Uniswap v3** (`0.01%` concentrated-liquidity pools). Running a live agent across both venues exposed four failure modes that break standard bots:

1. **Adverse selection when off-chain FX feeds lag Uniswap v3:** Whenever Textile's reference rate lags the on-chain pool (for example, quoting `1,383.8 cNGN/USDT` or `1,671.1 wARS/USDT` while Uniswap v3 trades at `1,378.7 cNGN` and `1,641.8 wARS`), takers lift a static maker's local currency on Textile and dump it into Uniswap v3 for an instant risk-free profit—leaving the maker with a realized loss.
2. **Multi-corridor shared-USDT skew distortion & WebSocket restart drops:** A single wallet quoting 4 corridors against one shared `USDT` pool (`~$177 USDT` vs `~$18` per local token) naively computes `s = +0.84` on every pair even when inventory is balanced, and restarting Stitch to update `TOML` spreads drops active `wss://api.textilecredit.com/v2/maker/stream` RFQ sessions.
3. **Sub-`$100` depth blindness:** Standard taker bots only probe fixed large slices (`$100+`) and discard `status: "no_quote"` responses, missing actionable sub-`$100` maker orders even when Textile's `/v2/rfq/preview` returns the exact `availableSellAmount`.
4. **Malformed DEX pool ticks (`wBRL` `MAX_TICK` gas trap):** On Celo Mainnet, the `wBRL/USDT` `0.01%` Uniswap v3 pool (`0x01c3…A40F`) sits at `slot0.tick = 887,271` (`MAX_TICK - 1`). Any swap or naive rebalancer touching that pool traverses `2,350` empty `TickBitmap` words, burning **`17.04M gas` (`~3.45 CELO`)** or reverting outright.

---

## Architecture

Skew runs two coordinated processes against the same Celo Mainnet EOA (`0xe503…7324`), combining **protected two-way market making** with **bounded AI regime supervision, multi-slice cross-venue arbitrage, and treasury rebalancing**:

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
  │ • Auto-refill & unwind (~$24 per corridor + CELO)    │         [Every tx tagged with 35-byte ERC-8021 suffix]
  │ • 800k gas QuoterV2 guard (blocks 17M-gas wBRL pool) │
  └──────────────────────────────────────────────────────┘
```

---

## How It Works

### 1. Dual-Oracle Anti-Arb Shield (`textile-stitch/src/pricing/skew.rs`)
Every 2 seconds inside Stitch's batched Multicall3 loop (`refresh_celo_dex_reference`), Skew reads `slot0()` from Celo's `0.01%` Uniswap v3 pools (`cNGN/USDT`, `wARS/USDT`, `USDC/USDT`). Before applying inventory spreads, `effective_mid_for_side()` anchors each side of the maker book to the safer of the two venues:

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{textile}}, P_{\text{uni}}\right), \qquad P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{textile}}, P_{\text{uni}}\right)$$

- **Guaranteed positive replenishment margin:** Because our `SELL` floor is never below Uniswap v3, every maker ask fill (e.g. selling `cNGN` at `1,372.9 cNGN/USDT`) is immediately refilled by Engine 2 on Uniswap v3 (`0.01%` pool at `1,378.7 cNGN/USDT`), locking in **`+41.1 bps` net profit per fill** instead of being adversely selected.

### 2. Time, Volatility, Markouts, Bounded Gemini LLM & Zero-Restart Rust Hot-Reload (`skew.rs` & `skew-desk.mjs`)
Across 6-decimal (`cNGN`, `USDC`, `USDT`) and 18-decimal (`wARS`, `wBRL`) tokens, Skew computes **multi-corridor normalized USD inventory imbalance** $s \in [-1, +1]$ (allocating `usdt_share_weight` $w$ of shared wallet `USDT` against each corridor's `~$24` target reserve so $s$ centers around $0.0$) and shifts per-side spreads dynamically:

$$s = \frac{w \cdot V_{\text{USDT}} - V_{\text{collateral}}}{w \cdot V_{\text{USDT}} + V_{\text{collateral}}}, \qquad \text{spread}_{\text{buy}} = \text{clamp}(\text{base}_{\text{buy}} - \gamma s, 1, 150), \qquad \text{spread}_{\text{sell}} = \text{clamp}(\text{base}_{\text{sell}} + \gamma s, 1, 150)$$

- **Top-of-book `1–2 bps` bid capture:** When holding excess `USDT`, `BUY` spreads tighten down to **`1–2 bps`** to win split-router order flow (`$178.61`, `$178.35`, and `$176.90 wARS` fills; `$140.28 cNGN` and `$86.48 wBRL` fills), which Engine 2 unwinds back to `USDT`.
- **Rolling EWMA Volatility ($\lambda = 0.94$), Structural Basis Shock & Post-Fill Markouts (`+1m` / `+5m`):**
  - `updateCorridorQuantState()` tracks per-corridor realized log-return EWMA volatility (`ewmaVolBps` → `volBufferBps`), slow structural FX basis (`alpha = 0.05` so `cNGN`'s normal `+270 bps` on-chain basis quotes tightly while sudden `>80 bps` basis shocks add `basisBufferBps`), and a 72-hour observed devaluation carry blend (`dailyCarryBps`).
  - `evaluateMarkoutAdjustments()` scores external Maker RFQ fills at **`+1m` and `+5m`** after settlement: negative markouts (toxic adverse selection) widen `markoutBufferBps` automatically (`+5` to `+25 bps`), while positive markouts tighten spreads by `-1 bps` to capture benign volume.
- **Regional Central-Bank Session & Weekend Closure Quoting (`computeRegionalBankingSession`):** Evaluates UTC day and hour against local fiat settlement calendars—**CBN Lagos EFEMS** (`Mon–Fri 07:00–15:00 UTC` for `cNGN`), **BCRA / MAE Buenos Aires** (`Mon–Fri 13:00–18:00 UTC` for `wARS`), **BCB PTAX / B3 São Paulo** (`Mon–Fri 12:00–20:00 UTC` for `wBRL`), and **24/7 Global USD** (`USDC`). During overnight hours and 72-hour weekend closures when fiat rails cannot settle, Skew widens ask buffers by **`+1` to `+6 bps`** and scales devaluation carry by **`1.25x–3.0x`**.
- **Out-of-Band Bounded Gemini LLM Desk Head (`runGeminiRiskSupervisor`):** Every 10 minutes (and immediately on volatility, basis-shock, or negative-markout spikes), `skew-desk.mjs` calls **Google Gemini (`gemini-3.8-flash`)** over objective numerical corridor telemetry (never echoing prior LLM rationales, eliminating self-reinforcing pause loops). Outputs are hard-clamped by `clampLlmCorridorDecision()` (`addBuyBps` $\in [-2, 25]$, `addSellBps` $\in [-2, 40]$, `gammaBps` $\in [2, 15]$, `pauseMinutes` $\le 45$, plus a deterministic `warmupSamples >= 3` cold-start tightening guard), **can never quote below Rust's Dual-Oracle Anti-Arb floor**, and fail open to deterministic quant math if `GEMINI_API_KEY` is unset or rate-limited.
- **Zero-Restart `skew-policy.json` Hot-Reload into Rust (`syncStitchRuntimePolicy` → `adjust_spread_for_corridor`):** Instead of killing and restarting Stitch, `skew-desk.mjs` atomically writes `skew-policy.json` (`tmp` → `renameSync`), and Rust `skew.rs` refreshes it via `mtime` check every `2 seconds`—applying per-corridor spreads, `gamma_bps`, `usdt_share_weight`, and per-side pauses in memory across both indicative WebSocket levels (`levels_for`) and firm quotes (`decide_quote`).

### 3. Multi-Slice (`100% / 50% / 25%`) + Adaptive `availableSellAmount` Taker (`skew-desk.mjs`)
Every 12 seconds, `skew-desk.mjs` scans all four corridors in both directions (`textile -> uni` and `uni -> textile`) to enforce law-of-one-price parity between Textile RFQ and Celo Uniswap v3 while recycling local-currency inventory:
1. **Multi-slice sizing (`computeSliceSizesUsdt`):** Computes candidate trade sizes at **`100%`, `50%`, and `25%` of liquid `USDT`** (up to `$150` per trade). When the `100%` slice suffers DEX price impact, the scanner steps down to `50%` or `25%` to maximize net dollar profit (`edgeUsd`).
2. **Adaptive sub-slice resizing:** If a maker's remaining depth on Textile is smaller than the probe size (`availableSellAmount < probe`), `skew-desk.mjs` automatically re-quotes at `98%` of `availableSellAmount` rather than skipping the corridor.
3. **Anti-self-trade calldata filter (`isSelfMakerOrder`):** Inspects the signed `DutchOrder` `OrderInfo.swapper` word before broadcasting and aborts if the quote came from our own Maker wallet (`0xe503…7324`).

### 4. Production Safety Guardrails & Dual-Engine Coordination
- **Shared-EOA Nonce Safety (`Engine 1` vs `Engine 2`):** Running Engine 1 (`skew-stitch` Rust Maker) and Engine 2 (`skew-desk.mjs` Node.js Taker & Rebalancer) on the same EOA (`0xe503…7324`) never causes EVM nonce collisions because **Engine 1 never broadcasts EOA transactions during quoting**—it signs off-chain EIP-712 `Permit2` `DutchOrder` payloads (which use unordered `Permit2` bit-position nonces and are submitted on-chain by the counterparty Taker via `LimitOrderReactor`). **Only Engine 2 submits active EOA transactions** using sequential account nonces, guarded by `isSelfMakerOrder(calldata)`.
- **`wBRL` `MAX_TICK` (`800k gas`) shield (`isValidUniQuoteGas`):** Rejects any Uniswap v3 quote whose `QuoterV2` `gasEstimate` exceeds `800,000 gas`, preventing the `17.04M gas` (`3.45 CELO`) `wBRL/USDT` pool from draining gas and routing `wBRL` inventory rebalances through Textile RFQ (`~197k gas`).
- **Native `CELO` gas top-up (`AUTO_GAS_REFILL`) vs CIP-64 `feeCurrency`:** While our web dashboard (`docs/index.html`) detects MiniPay (`window.ethereum.isMiniPay`) and attaches Celo CIP-64 `feeCurrency: USDT` for retail wallet UX, Engine 2's automated bot execution intentionally maintains a native `CELO` gas buffer (swapping `$2.00 USDT -> ~24.2 CELO` on Uniswap v3 `0.30%` whenever `CELO < 3.0`). Paying gas in native `CELO` allows standard EIP-1559 Type-2 transactions with minimal base gas overhead and avoids CIP-64 `FeeCurrencyDirectory` oracle-lookup gas surcharges during latency-sensitive 2-leg arbitrages.
- **Single-path ERC-8021 tagging:** Both Rust (`append_erc8021_attribution` in `src/chain/tx.rs`) and Node.js (`sendTagged` in `skew-desk.mjs`) route every outbound transaction through a single wrapper that idempotently appends the 35-byte `celo_7935fb97e273` suffix.

---

## What Is Verified on Celo Mainnet, and How

Every claim in this repository is backed by on-chain transactions on Celo Mainnet (`42220`). Full ledger in [`reports/EVIDENCE.md`](reports/EVIDENCE.md):

| Capability | On-Chain Verification (Celoscan) |
| :--- | :--- |
| **`$178.61` & `$176.90` Split-Router Maker Wins (`wARS/USDT`)** | Textile's router awarded Skew **`178.61 USDT` (`295,251 wARS`)** ([`0xb4f0a9ad…0896`](https://celoscan.io/tx/0xb4f0a9ad50452f187d5e4885a337dd210ba98b93d23b714a7fb963383e2e0896)), **`178.35 USDT`** ([`0x68c3b989…2a83`](https://celoscan.io/tx/0x68c3b9899c73cb181a792a1d85d886a81f4d101a4fcadc297d8c219547542a83)), and **`176.90 USDT` (`90.7%` of batch)** ([`0xbbff102f…51cd`](https://celoscan.io/tx/0xbbff102f3778308dd8c724e73c7f06d04f5d3b0b138307b9dd48a13e014751cd)) ahead of competing makers |
| **`$133.36` Multi-Slice Cross-Venue Arbitrage (`wARS/USDT`)** | Bought `220,478 wARS` for `133.36 USDT` from external Maker `#9929` on Textile ([`0xd0855bf8…4a1b`](https://celoscan.io/tx/0xd0855bf83154261c63c9939e14164501aa9c3f1d74a15bc8f92a35cf215a4a1b)); unwound 12s later on Uniswap v3 `0.01%` for **`133.42 USDT` (`+$0.0599 USDT` net profit)** ([`0xb4a0071e…425d`](https://celoscan.io/tx/0xb4a0071e8b077e1297ec306b21a5b0855f0ef01d07a49bf90b6ca3bd2787425d)) |
| **`$140.28` Maker Fill → Instant Uniswap v3 Unwind (`cNGN/USDT`)** | External bot `#9908` lifted `140.28 USDT` (`193,716 cNGN`) from our Maker ([`0xd13ec8ec…937e`](https://celoscan.io/tx/0xd13ec8ec5b95d4b90e1bfe856da0e0881b38a01c6e833f225dbb11cb8ec8937e)); 27s later `skew-desk.mjs` unwound on Uniswap v3 `0.01%` for **`140.29 USDT`** ([`0x6f82fbaa…565d`](https://celoscan.io/tx/0x6f82fbaa43677a010fcc6da464719dd4edf1998468d0d5c5c2f79cf64a4f565d)) |
| **Shielded Maker Fill → `+41.1 bps` DEX Refill (`cNGN/USDT`)** | External bot `#9995` paid `18.0620 USDT` for `24,799 cNGN` ([`0x51b95699…fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4)); refilled `24,800 cNGN` on Uniswap v3 for `17.9880 USDT` ([`0x28d4e714…c6d5`](https://celoscan.io/tx/0x28d4e71468195aae4a1275a32dc935b2936e94864838267c3ecac3e8b436c6d5)), netting **`+$0.0740 USDT` (`+41.1 bps`)** |
| **Institutional `$86.48` & `$80.00` Maker Fills (`wBRL` & `cNGN`)** | Served to `#9991 Kiyoshi`: `459.57 wBRL → 86.48 USDT` ([`0x9e9abd6d…5a5a`](https://celoscan.io/tx/0x9e9abd6d1ebb31a309642d6e58efb7f3e68d4d50e9942ca266bc49beaf7d5a5a)) and `110,627 cNGN → 80.00 USDT` ([`0x855d155c…a4a9`](https://celoscan.io/tx/0x855d155c063195460508b15364a841482041bf7c3e458ff47d2a3d33b859a4a9)) |
| **`+187.5 bps` Cross-Venue Arbitrage (`wARS/USDT`)** | Bought `17,719 wARS` for `10.59 USDT` on Textile ([`0xb202a9f1…c995`](https://celoscan.io/tx/0xb202a9f1e159b37f6b8f662652141903b293246a8810ebe7ae8dfabb9b1cc995)) → sold on Uniswap v3 8s later for `10.79 USDT` ([`0x20da628c…2cef`](https://celoscan.io/tx/0x20da628c6a545ea95a2e9268d587b1e63be758e4fd30f147ce668a628ced2cef)) |
| **`53x` High-Frequency `cNGN/USDT` Arbitrage Run (`106` txs)** | Recycled `$25` slices across `$2,656.44` volume in 27 minutes for **`+$6.44 USDT` (`+48.6 bps` avg)** ([first leg `0xe8b19d37…80cf`](https://celoscan.io/tx/0xe8b19d37fda658805c695456c273b6b7f99c6e139fd9b0b6353df4f4764b80cf) to [53rd unwind `0xc9b92bcd…deb1`](https://celoscan.io/tx/0xc9b92bcdb87d7890eaca9060c7e07d3b34feca9691cfb72e4f4642e70ac8deb1)) |
| **Gas-Shielded `wBRL` RFQ Rebalance & `CELO` Gas Top-Up** | Bypassed `17M gas` Uniswap pool via `197k gas` Textile RFQ unwind ([`0x3329c8f6…7cd5`](https://celoscan.io/tx/0x3329c8f625f3314369f2066f7ed4518f0c5eb38a619f47aa5886979c58c77cd5)) · `2.00 USDT → 24.22 CELO` top-up ([`0xf63c6f1b…250c`](https://celoscan.io/tx/0xf63c6f1b9657fccccc327db8e2493fa872846f86262ca74013955a265c0f250c)) |
| **ERC-8004 `#9905` Identity Mint & `registration-v1` URI** | Mint ([`0x2a7659bf…8451`](https://celoscan.io/tx/0x2a7659bf72cd2c68295c488f7937d9bd2e6126f4155972d6be86dbbe01338451)) · On-chain base64 `eip-8004#registration-v1` update ([`0x9019d6c7…3b50`](https://celoscan.io/tx/0x9019d6c71cfd1b73657afa9086892fdff9daddb5eb428e3be98d4059c0ad3b50)) |

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
  skew-desk.test.mjs                22 offline Node unit tests (skew, shield, EWMA, markouts, LLM clamps, hot-reload)
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
npm test              # Run 22 offline Node unit tests (0 network calls, 0 secrets needed)
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
| `MIN_EDGE_USD` | `0.01` | Minimum net dollar profit threshold (`USDT`) for cross-venue arbitrage execution |
| `SCAN_INTERVAL_MS` | `12000` | Cross-venue scan & telemetry refresh interval (`ms`) |
| `PORT` | `8080` | Local telemetry & dashboard HTTP server port (`/status`, `/trades`, `/llm`, `/health`) |

---

## License & Security

- **Security Policy:** See [`SECURITY.md`](SECURITY.md) and [`.gitleaks.toml`](.gitleaks.toml).
- **License:** [`skew-desk.mjs`](skew-desk.mjs) and [`docs/`](docs/index.html) are licensed under [`MIT`](LICENSE). The [`textile-stitch/`](textile-stitch/LICENSE) Rust workspace is extended from [`textile-protocol/textile-stitch`](https://github.com/textile-protocol/textile-stitch) under `AGPL-3.0-or-later`.
