# Skew Strategy & Celo FX Microstructure Deep-Dive

This document explains how **Skew (`ERC-8004 Agent #9905`)** prices, quotes, supervises risk, arbitrages, and rebalances across the four **Textile FX** corridors on Celo Mainnet (**`cNGN`**, **`wARS`**, **`wBRL`**, and **`USDC`** against **`USDT`**), and why a **Dual-Engine (Shielded Rust Maker + Bounded AI & Multi-Slice Taker)** architecture is required to stay profitable on both sides of the orderbook.

- **Live 24/7 RPC Telemetry Dashboard:** **[https://eugenennamdi.github.io/Skew/](https://eugenennamdi.github.io/Skew/)** *(verify active Maker uptime, live Celo RPC balances, 4-corridor `slot0()` spreads, and `+$95.58 USDT` / `+49.02%` net liquid RoC in real time)*
- **On-Chain Evidence Ledger:** [reports/EVIDENCE.md](../reports/EVIDENCE.md)
- **Agent EOA Wallet:** [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)
- **ERC-8021 Attribution Tag:** `celo_7935fb97e273`

---

## 1. Core Insight: Why Unshielded Makers Lose Money on Celo FX

On Celo Mainnet, local stablecoins (`cNGN`, `wARS`, `wBRL`, `USDC`) trade simultaneously on two separate mechanisms *(note: Textile FX settles all RFQ trades atomically via `LimitOrderReactor` `0xa9AA0a64…35b3` and `Permit2` `0x00000000…78BA3`, and **never** routes RFQ trades through Uniswap; Celo Uniswap v3 `slot0()` serves strictly as an external on-chain reference price for Engine 1's Dual-Oracle shield and as an external rebalance/arbitrage pool for Engine 2)*:
1. **Textile FX RFQ (`LimitOrderReactor` `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`):** Makers answer exact-size RFQ solicitations with firm, signed, all-or-nothing `Permit2` `DutchOrder` quotes (~60s expiry) around an off-chain FX reference rate $P_{\text{textile}}$.
2. **Celo Uniswap v3 (`SwapRouter02` `0x5615CDAb10dc425a742d643d949a7F474C01abc4`):** Separate concentrated-liquidity `0.01%` (`100` bps fee tier) pools whose `slot0()` on-chain mid $P_{\text{uni}}$ provides an external arbitrage-floor reference price.

Whenever $P_{\text{textile}} < P_{\text{uni}}$ (i.e. Textile's off-chain FX reference values the local currency cheaper than Uniswap v3), any maker quoting a symmetric spread around $P_{\text{textile}}$ (or around a weighted average of off-chain FX feeds) will quote a `SELL` price below $P_{\text{uni}}$. Arbitrage bots immediately buy the maker's local currency on Textile and sell it into Uniswap v3.

### The Fix: Hard `max / min` Dual-Oracle Comparison Shield

Instead of blending off-chain and on-chain prices into a soft average that can still cross the DEX pool, we modified Stitch's Rust pricing engine ([`textile-stitch/src/pricing/skew.rs`](../textile-stitch/src/pricing/skew.rs), [`textile-stitch/src/pricing/twap.rs`](../textile-stitch/src/pricing/twap.rs), [`textile-stitch/src/pricing/lean.rs`](../textile-stitch/src/pricing/lean.rs), and [`textile-stitch/src/rfq/mod.rs`](../textile-stitch/src/rfq/mod.rs)) to poll Celo Uniswap v3 `slot0()` (`0x3850c7bd`) every `2 seconds` via Multicall3 (`decode_and_cache_celo_dex_slot0` in `skew.rs`), smooth incoming oracle ticks through a **120-second `Twap` ring buffer (`twap_window_secs = 120`, `twap_max_deviation_bps = 15`)**, and log every quote's `oracle`, `twap120s`, `dex`, and `eff` mid (`[skew-mid]` & `[skew-decision]`):

$$P_{\text{uni}} = \left(\frac{\text{sqrtPriceX96}}{2^{96}}\right)^2 \cdot 10^{\text{dec}_{\text{token}} - \text{dec}_{\text{USDT}}}$$

Before applying inventory-skew spreads, `effective_mid_for_corridor()` enforces a hard no-cross boundary (with optional `fail_closed_without_dex` enforcement and `DEX_MID_PRESENT_QUOTES` / `DEX_MID_FALLBACK_QUOTES` telemetry counters):

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{twap, textile}}, P_{\text{uni}}\right), \qquad P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{twap, textile}}, P_{\text{uni}}\right)$$

- **On-chain proof of the shield in action:** On Oct 26 at `21:42Z`, external bot `#9995 naira-maker` (`0x8754FE21…744B`) lifted our `cNGN` ask when Textile's oracle lagged Uniswap v3 by `34 bps`. At `21:43Z`, we enabled `effective_mid_for_side()`. On the very next three fills (`21:44Z`, `21:58Z`, `22:02Z` — e.g. [`0x51b95699…fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4)), `#9995` paid **`1,372.92 cNGN/USDT`** to our Maker while `skew-desk.mjs` immediately refilled the exact `cNGN` on Uniswap v3 at **`1,378.71 cNGN/USDT`** ([`0x28d4e714…c6d5`](https://celoscan.io/tx/0x28d4e71468195aae4a1275a32dc935b2936e94864838267c3ecac3e8b436c6d5)), locking in **`+41.1 bps` (`+$0.0740 USDT`) positive replenishment margin per fill**.

---

## 2. Multi-Corridor Normalized Avellaneda-Stoikov Skew, Lean Offsets & Time-Scaled Volatility Bridge

### A. Multi-Decimal, Share-Weighted Inventory Imbalance + Time-Scaled Volatility & Markout Bridge (`skew.rs`, `lean.rs` & `src/risk-policy.mjs`)
Because `USDT`, `cNGN`, and `USDC` use `6` decimals while `wARS` and `wBRL` use `18` decimals—and all four corridors draw from a single shared `USDT` settlement balance—`apply_corridor_policy_and_skew()` normalizes balances into USD and weights `USDT` by each corridor's target share $w = \min(1, V_{\text{target}} / V_{\text{USDT}})$ (`~$24` per corridor) before computing skew $s \in [-1, +1]$ and inventory share $q = \frac{1 - s}{2} \in [0, 1]$ (`lean::target_offsets` with `lean_enabled = true`, `lean_base_bps = 3.0`, `lean_wide_bps = 6.0`, `lean_floor_bps = 1.0`). Every 2 seconds, Engine 2 ([`src/risk-policy.mjs`](../src/risk-policy.mjs)) writes each corridor's rolling EWMA volatility ($\sigma_{\text{ewma}} = \text{ewma\_vol\_bps}$), central-bank session horizon ($\tau = \text{session\_horizon\_hours} \in \{4\text{h open}, 16\text{h overnight}, 72\text{h weekend}\}$), and post-fill markout toxicity ($\mu_{\text{tox}} = \text{markout\_toxicity\_bps}$) into `skew-policy.json`, which Rust `skew.rs` consumes directly in its Avellaneda-Stoikov spread equation:

$$V_{\text{USDT}} = \frac{\text{bal}_{\text{USDT}}}{10^6}, \qquad V_{\text{tok}} = \frac{\text{bal}_{\text{tok}}}{10^{\text{dec}_{\text{tok}}}} \cdot P_{\text{mid, eff}}, \qquad s = \frac{w \cdot V_{\text{USDT}} - V_{\text{tok}}}{w \cdot V_{\text{USDT}} + V_{\text{tok}}}, \qquad \Delta_{\text{vol}}(\sigma,\tau) = \frac{1}{2}\gamma \cdot \sigma_{\text{ewma}}\sqrt{\frac{\tau}{24}}$$

$$\text{spread}_{\text{buy}} = \text{clamp}\!\left(\max(\text{base}_{\text{buy}}, \text{lean}_{\text{bid}}) - \gamma s + \Delta_{\text{vol}}(\sigma,\tau) + 0.5\,\mu_{\text{tox}}, \text{floor}_{\text{lean}}, 150\right)$$

$$\text{spread}_{\text{sell}} = \text{clamp}\!\left(\max(\text{base}_{\text{sell}}, \text{lean}_{\text{ask}}) + \gamma s + \Delta_{\text{vol}}(\sigma,\tau) + \mu_{\text{tox}}, \text{floor}_{\text{lean}}, 150\right)$$

*(Raw un-weighted $V_{\text{USDT}} < \$1.00$ and $V_{\text{tok}} < \$1.00$ exhaustion guards remain enforced prior to share weighting so depleted sides halt immediately.)*

### A1. End-to-End Per-Quote Decision Table (`inputs -> mid -> spread -> floor clamp`)

| Stage | Input Signals | Code Path (`Rust` & `Node.js`) | Mathematical Transformation | Concrete Example (`USDT/cNGN` Ask Quote) |
| :--- | :--- | :--- | :--- | :--- |
| **1. Inputs** | Off-chain oracle `P_textile`, Celo Uni v3 `slot0()`, vault balances `(V_USDT, V_cNGN)`, `skew-policy.json` (`ewma_vol_bps`, `markout_toxicity_bps`, `session_horizon_hours`) | `refresh_celo_dex_reference` (`rfq/mod.rs`) + `syncStitchRuntimePolicy` (`src/risk-policy.mjs`) | Decode `sqrtPriceX96`, compute 120s `Twap`, read atomic 2s `skew-policy.json` | `P_textile = $0.0007160` (`1,396.6 cNGN`), `P_uni = $0.0007194` (`1,390.0 cNGN`), `ewma_vol = 4.2 bps`, `tau = 4h` |
| **2. Shielded Mid** | `P_twap_textile` (`120s` smoothed) vs. `P_uni` (`slot0()`) | `effective_mid_for_corridor` (`skew.rs`) + `observe_rfq_twap_mid` (`twap.rs`) | `SELL` anchors to `max(P_twap, P_uni)`; `BUY` anchors to `min(P_twap, P_uni)`; logs `[skew-mid]` | `effective_mid = max(0.0007160, 0.0007194) = $0.0007194` (`+47.5 bps` anti-arb shield active) |
| **3. Dynamic Spread** | Normalized skew `s`, `LeanParams` (`q`), `gamma_bps`, `ewma_vol_bps`, `session_horizon_hours`, `markout_toxicity_bps` | `apply_corridor_policy_and_skew` (`skew.rs`) + `target_offsets` (`lean.rs`) | `max(base, lean) +/- gamma*s + 0.5*gamma*sigma*sqrt(tau/24) + markout_tox` | `base = 3 bps`, `lean_ask = 3.2 bps`, `skew_adj = +1.1 bps`, `vol_term = +0.5 bps`, `markout = 0` → `5 bps` |
| **4. Floor Clamp & Output** | Raw target bps, `lean_floor_bps` (`1.0 bps`), exhaustion threshold (`\|s\| >= 0.85`), `DutchOrder` witness | `decide_quote` & `levels_for` (`responder.rs`) + `apply_spread` (`quote.rs`) | Clamp to `[lean_floor_bps, 150]`; halt side if reserve `< $1.00`; sign EIP-712 `Permit2` quote; log `[skew-decision]` | Final Ask Spread = **`5 bps`** above `$0.0007194` (`1,389.3 cNGN/USDT`, netting **`+7.9 bps`** after `1 bps` fee & DEX refill) |

### B. Time, Volatility, Markouts, Bounded Gemini LLM & Zero-Restart Rust Hot-Reload
To combine sub-millisecond RFQ responsiveness with adaptive quantitative and AI supervision, [`skew-desk.mjs`](../skew-desk.mjs) keeps LLM inference strictly **out-of-band** from the 2-second quoting path while streaming clamped policy updates into Rust [`skew.rs`](../textile-stitch/src/pricing/skew.rs) via `skew-policy.json`:

| Corridor | Decimals | Primary Celo Uniswap v3 Pool (`0.01%`) | Off-Chain Official & Parallel FX Sources | Regional Banking Session (`UTC`) | Overnight / Weekend Buffer | Base Crawl / Carry |
| :--- | :---: | :--- | :--- | :--- | :---: | :---: |
| **`cNGN / USDT`** | `6` | `0x6519d56Eb0A69FC0338657784c783B169b8f7d32` | `open.er-api.com` (`USD/NGN`) | **CBN Lagos EFEMS** (`07:00–15:00`) | `+2 bps` / **`+5 bps` (`3.0x`)** | `8.5 bps/day` |
| **`wARS / USDT`** | `18` | `0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391` | `dolarapi.com` (`cripto` vs `oficial` BCRA) | **BCRA Buenos Aires** (`13:00–18:00`) | `+3 bps` / **`+6 bps` (`3.0x`)** | `13.3 bps/day` |
| **`wBRL / USDT`** | `18` | `0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F` *(shielded)* | `open.er-api.com` (`USD/BRL` PTAX) | **BCB São Paulo** (`12:00–20:00`) | `+1 bps` / **`+4 bps` (`2.5x`)** | `4.2 bps/day` |
| **`USDC / USDT`** | `6` | `0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846` | `$1.00` USD Peg | **Global USD 24/7** | `0 bps` (`1.0x`) | `0.0 bps/day` |

1. **Multi-Corridor Normalized Skew (`usdt_share_weight`):** Instead of comparing 100% of shared wallet `USDT` against a single corridor's local reserve (which artificially pins $s > +0.80$), `skew-policy.json` assigns each corridor its target `usdt_share_weight` (`~$24` per corridor), centering $s$ symmetrically around $0.0$ and allowing `wBRL` and `wARS` to win split-router top-of-book fills (`$178.61`, `$178.35`, `$176.90`).
2. **Rolling EWMA Volatility ($\lambda = 0.94$), Structural Basis Shock & 72h Measured Carry (`updateCorridorQuantState`):** Tracks realized log-return variance (`volBufferBps`), slow EWMA off-chain FX basis (`alpha = 0.05`, tolerating structural on-chain premia while widening on sudden `>80 bps` basis shocks), and observed 72h devaluation drift blended with macro priors.
3. **Post-Fill `+1m` & `+5m` Markout Feedback (`evaluateMarkoutAdjustments`):** Scores external Maker RFQ fills against mid-price 1 and 5 minutes post-settlement—widening spreads up to `+25 bps` on negative markouts (adverse selection) and tightening `-1 bps` on benign positive markouts.
4. **Bounded Gemini 3.8 Flash Desk Head (`runGeminiRiskSupervisor` + `clampLlmCorridorDecision`):** Reviews objective corridor telemetry every 10 minutes (and immediately on volatility/markout spikes), tuning `addBuyBps` $\in [-2, 25]$, `addSellBps` $\in [-2, 40]$, `gammaBps` $\in [2, 15]$, or bounded `15–45 min` side pauses—with a calm-market top-of-book clamp keeping weekday spreads competitive at `2–6 bps` whenever `ewmaVolBps < 12` and `basisShockBps < 60`, while preserving full `+45 bps` protection under genuine stress. Prior LLM rationales are never echoed into future prompts, Rust's Dual-Oracle floor remains unbreakable, and API errors fail open to deterministic quant rules.
5. **Zero-Restart Rust Hot-Reload (`syncStitchRuntimePolicy` → `get_corridor_runtime_policy`):** Atomically updates `skew-policy.json` (`mtime`-checked every `2s` in Rust, including per-corridor `dex_mid`, `ewma_vol_bps`, `markout_toxicity_bps`, and `session_horizon_hours`) alongside `stitch.runtime.toml` so both indicative WebSocket levels (`levels_for`) and firm RFQ quotes (`decide_quote`) adapt in real time with **zero Stitch process restarts or WebSocket disconnects**. *(Firm RFQ quote expiry on Textile FX v2 is governed by Textile's `quoteTtlMs` `Permit2` signature deadline and subject to Celo's `1 bps` taker fee per the Textile Address Book; Stitch's `ttl_secs` governs resting orderbook quotes only.)*

---

## 3. Bidirectional Multi-Slice (`100% / 50% / 25%`) + Zero-Gas Firm-Quote Taker

In [`skew-desk.mjs`](../skew-desk.mjs), `scanCorridor()` and `executeOpportunity()` run every `3.5 seconds` across three complementary mechanisms:

1. **Multi-Slice & Top-of-Book Dynamic Budget (`computeSliceSizesUsdt`):**
   - Evaluates candidate slices across **`100%`, `50%`, and `25%` of available liquid `USDT`** (up to `$150` max slice, plus single-maker top-of-book probes).
   - If the `100%` slice experiences Uniswap v3 price impact or blends a wide secondary maker quote, the scanner automatically selects the smaller slice that maximizes net dollar profit (`edgeUsd`).
2. **Zero-Gas Pre-Broadcast Firm-Quote Guard (`verifyFirmArbQuote`):**
   - Indicative `/v2/rfq/preview` responses can differ by `1–3 bps` from firm EIP-712 `DutchOrder` calldata when depth shifts mid-second.
   - Before broadcasting either a `textile -> uni` sweep or an inventory-first `uni -> textile` reverse arbitrage, `skew-desk.mjs` inspects the firm `outputs[0]` amount and aborts at **`0 gas`** unless net post-gas return clears `MIN_FIRM_NET_EDGE_USD` (`$0.018` / `1.2 bps`), and parses exact `Transfer` receipt logs (`sumReceiptTokenTransfers`) post-fill.
3. **Adaptive Sub-Slice Resizing (`availableSellAmount`):**
   - When an external maker on Textile has less inventory than our probe slice, Textile's `POST /v2/rfq/preview` returns `status: "no_quote"` along with `availableSellAmount`.
   - Instead of discarding the corridor, `skew-desk.mjs` immediately re-quotes at **`98%` of `availableSellAmount`**, signs an EIP-712 `TakerControl` proof, lifts the maker on `LimitOrderReactor`, and unwinds on Uniswap v3 `SwapRouter02`.

---

## 4. The `wBRL/USDT` `MAX_TICK` (`887,271`) Discovery & `800k Gas` Shield

During live Celo Mainnet operation, we discovered a critical on-chain anomaly on Celo's `wBRL/USDT` `0.01%` Uniswap v3 pool (`0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F`):
- The pool was drained to `slot0.tick = 887,271` (`MAX_TICK - 1`).
- Any `USDT -> wBRL` swap on Uniswap v3 must iterate through `2,350` uninitialized `TickBitmap` words before finding liquidity, consuming **`17,039,337 gas` (`~3.45 CELO` per swap)** or reverting when gas-capped.
- Naive makers that read `slot0()` without bounds checking compute an absurd `wBRL` price (`~10^38`), and naive rebalancers that try to buy `wBRL` on Uniswap v3 get permanently stuck.

**How Skew solves it:**
1. In Rust (`textile-stitch/src/rfq/mod.rs`), `refresh_celo_dex_reference()` validates `slot0()` prices against corridor sanity bounds and excludes the malformed `wBRL` pool from overriding the maker's mid.
2. In Node.js (`skew-desk.mjs`), `isValidUniQuoteGas(amountOut, gasEstimate)` inspects the 4th return value of `QuoterV2.quoteExactInputSingle` and rejects any quote requiring **`> 800,000 gas`**.
3. When `wBRL` treasury rebalancing is needed (`seedInventoryViaTextile` / `unwindViaTextile`), `skew-desk.mjs` routes the rebalance through external makers on Textile's `LimitOrderReactor` (`~197k gas`, e.g. [`0x3329c8f6…7cd5`](https://celoscan.io/tx/0x3329c8f625f3314369f2066f7ed4518f0c5eb38a619f47aa5886979c58c77cd5) and [`0xc1fef265…fa53`](https://celoscan.io/tx/0xc1fef26595abdbaa9455129cdc24a8ef0f7e138a2f8874bdd39a2f83113bfa53)).

---

## 5. Empirical Celo Mainnet Microstructure Benchmark

> [!NOTE]
> **Synchronized Mainnet Audit Checkpoint (`2026-11-08 19:01 UTC` · Celo Mainnet Block `#82,263,550`):**
> All figures below match the synchronized checkpoint in [`README.md`](../README.md) and [`reports/EVIDENCE.md`](../reports/EVIDENCE.md). Because **Agent `#9905`** trades 24/7 on Celo Mainnet (`42220`), live cumulative totals can be verified at **[eugenennamdi.github.io/Skew](https://eugenennamdi.github.io/Skew/)** (`GET /status`, `GET /llm`) or **[Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)**.

Auditing transactions on Celo Mainnet `LimitOrderReactor` (`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`) highlights the structural trade-offs between the three agent designs operating across the ecosystem:

| Dimension | Skew (`Agent #9905` · Dual-Engine + Bounded AI) | Single-Sided Taker Bots | Unshielded Off-Chain FX Makers |
| :--- | :--- | :--- | :--- |
| **Market Role** | **4-Corridor Maker (`8/8` sides) + Cross-Venue Taker** | Taker-only (`0` Maker fills) | Multi-corridor Maker + DEX Rebalancer |
| **On-Chain Settlements** | **`3,911` signed EOA txs (`9,996` ERC-20 transfers · `99.82%` reliability)** | Taker-only settlement legs | Maker-only fills & periodic DEX swaps |
| **Maker Liquidity Served** | **24/7 `1s` WS quotes + `179` external fills (`$6,527.97` Maker volume)** | `0` fills (`$0` liquidity provided) | Exposed to cross-venue oracle lag & static spreads |
| **Cross-Venue Arbitrage & Total Volume** | **`1,794` 2-leg arbs (`$193,344.64` 1-leg arb · `$207,057.11` total 1-leg · `$414,114.22` 2-leg · `$828,228.43` 2-way · `1,061.8x` turnover)** | Single-venue Taker sweeps | `0` Taker arbitrages |
| **Oracle-Lag & AI Defense** | **Hard `SELL >= max(P_textile, P_uni)` floor + EWMA/Markouts + Bounded Gemini 3.8 Flash (`2s` hot-reload)** | N/A (never quotes Maker orders) | Soft weighted median; exposed when off-chain FX lags DEX |
| **`wBRL` `MAX_TICK` Defense** | **`800k gas` `QuoterV2` guard + `197k gas` Textile RFQ fallback** | N/A | Rebalancer stalls on `0x01c3…A40F` (`17.04M gas`) |
| **Realized Closed-Fill P&L (`$195.00` Initial Capital)** | **`+$95.97 USDT` Realized (`+49.22%` RoC = `+$4.85` from `179` independent Maker fills + `+$91.12` from `1,794` 2-leg arbs)** | Positive Taker PnL, `$0` Maker PnL | Negative cross-venue basis drift when off-chain FX lags Uniswap v3 |
| **Mark-to-Market Strategy Value (`$195.00` Initial Capital)** | **`$290.58` liquid stablecoins (`+$95.58 USDT` net liquid · `+49.02%` RoC after `-$0.39` FX MTM) · `$296.43` total strategy value (`+$101.43` · `+52.02%` RoC incl. `$5.85` `CELO` gas reserve)** | Positive Taker PnL, `$0` Maker PnL | Negative cross-venue basis drift when off-chain FX lags Uniswap v3 |

### Fixed-Spread Filler Baseline Comparison (`node scripts/verify-onchain-pnl.mjs`)

Replaying the exact `1,412` RFQ requests (`99.44%` response rate, `14.2ms` median / `41.8ms` p99) and `179` external Maker fills (`$6,527.97` Maker volume, `0` self-trades) net of Textile's `1 bps` `sellAmount` protocol fee (`GET /v2/rfq/{id}`) and `1 bps` Celo Uniswap v3 replenishment cost ([`reports/onchain-fills-ledger.json`](../reports/onchain-fills-ledger.json)):

| Maker Strategy / Baseline | Quotes Answered | Competitive Top-of-Book Share (`<=2 bps`) | External Fills (`0` Self-Trades) | Filled Maker Volume | Adverse-Selection Loss Fills | Net Realized Maker P&L (USDT) | Net Realized Edge (bps) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Skew Shielded Maker (`min/max(TWAP, DEX)` + Vol/Markout + Lean)** | **`1,412 / 1,420`** | **`68.41%` (`966 / 1,412`)** | **`179`** (`12.68%` overall · `18.53%` when competitive) | **`$6,527.97`** | **`2 / 179` (`1.1%`)** | **`+$4.85 USDT`** | **`+7.43 bps`** |
| **Baseline A: Unshielded Fixed `5 bps` Filler (Off-Chain `P_textile`)** | `1,412 / 1,420` | `74.15%` (`1,047 / 1,412`) | `179` | `$6,527.97` | `141 / 179` (`78.8%`) | `-$14.62 USDT` | `-22.40 bps` |
| **Baseline B: Unshielded Fixed `25 bps` Static Filler (Default Template)** | `1,412 / 1,420` | `11.40%` (`161 / 1,412`) | `39` (misses `78.2%` of flow) | `$1,425.10` | `31 / 39` (`79.5%`) | `-$3.18 USDT` | `-22.31 bps` |
