# Skew Strategy & Celo FX Microstructure Deep-Dive

This document explains how **Skew (`ERC-8004 Agent #9905`)** prices, quotes, supervises risk, arbitrages, and rebalances across the four **Textile FX** corridors on Celo Mainnet (**`cNGN`**, **`wARS`**, **`wBRL`**, and **`USDC`** against **`USDT`**), and why a **Dual-Engine (Shielded Rust Maker + Bounded AI & Multi-Slice Taker)** architecture is required to stay profitable on both sides of the orderbook.

- **Live 24/7 RPC Telemetry Dashboard:** **[https://eugenennamdi.github.io/Skew/](https://eugenennamdi.github.io/Skew/)** *(verify active Maker uptime, live Celo RPC balances, 4-corridor `slot0()` spreads, and `+$66.33 USDT` / `+34.02%` RoC in real time)*
- **On-Chain Evidence Ledger:** [reports/EVIDENCE.md](../reports/EVIDENCE.md)
- **Agent EOA Wallet:** [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)
- **ERC-8021 Attribution Tag:** `celo_7935fb97e273`

---

## 1. Core Insight: Why Unshielded Makers Lose Money on Celo FX

On Celo Mainnet, local stablecoins (`cNGN`, `wARS`, `wBRL`, `USDC`) trade simultaneously on:
1. **Textile FX RFQ (`LimitOrderReactor` `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`):** Makers stream indicative levels and sign firm `Permit2` `DutchOrder` quotes around a periodic FX reference rate $P_{\text{textile}}$.
2. **Celo Uniswap v3 (`SwapRouter02` `0x5615CDAb10dc425a742d643d949a7F474C01abc4`):** Concentrated-liquidity `0.01%` (`100` bps fee tier) pools trade continuously at on-chain mid $P_{\text{uni}}$.

Whenever $P_{\text{textile}} < P_{\text{uni}}$ (i.e. Textile's off-chain FX reference values the local currency cheaper than Uniswap v3), any maker quoting a symmetric spread around $P_{\text{textile}}$ (or around a weighted average of off-chain FX feeds) will quote a `SELL` price below $P_{\text{uni}}$. Arbitrage bots immediately buy the maker's local currency on Textile and sell it into Uniswap v3.

### The Fix: Hard `max / min` Dual-Oracle Comparison Shield

Instead of blending off-chain and on-chain prices into a soft average that can still cross the DEX pool, we modified Stitch's Rust pricing engine ([`textile-stitch/src/pricing/skew.rs`](../textile-stitch/src/pricing/skew.rs) and [`textile-stitch/src/rfq/mod.rs`](../textile-stitch/src/rfq/mod.rs)) to poll Celo Uniswap v3 `slot0()` (`0x3850c7bd`) every `2 seconds` via Multicall3:

$$P_{\text{uni}} = \left(\frac{\text{sqrtPriceX96}}{2^{96}}\right)^2 \cdot 10^{\text{dec}_{\text{token}} - \text{dec}_{\text{USDT}}}$$

Before applying inventory-skew spreads, `effective_mid_for_side()` enforces a hard no-cross boundary:

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{textile}}, P_{\text{uni}}\right), \qquad P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{textile}}, P_{\text{uni}}\right)$$

- **On-chain proof of the shield in action:** On Oct 26 at `21:42Z`, external bot `#9995 naira-maker` (`0x8754FE21…744B`) lifted our `cNGN` ask when Textile's oracle lagged Uniswap v3 by `34 bps`. At `21:43Z`, we enabled `effective_mid_for_side()`. On the very next three fills (`21:44Z`, `21:58Z`, `22:02Z` — e.g. [`0x51b95699…fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4)), `#9995` paid **`1,372.92 cNGN/USDT`** to our Maker while `skew-desk.mjs` immediately refilled the exact `cNGN` on Uniswap v3 at **`1,378.71 cNGN/USDT`** ([`0x28d4e714…c6d5`](https://celoscan.io/tx/0x28d4e71468195aae4a1275a32dc935b2936e94864838267c3ecac3e8b436c6d5)), locking in **`+41.1 bps` (`+$0.0740 USDT`) positive replenishment margin per fill**.

---

## 2. Multi-Corridor Normalized Avellaneda-Stoikov Skew & Bounded AI Policy Loop

### A. Multi-Decimal, Share-Weighted Inventory Imbalance (`skew.rs`)
Because `USDT`, `cNGN`, and `USDC` use `6` decimals while `wARS` and `wBRL` use `18` decimals—and all four corridors draw from a single shared `USDT` settlement balance—`apply_corridor_policy_and_skew()` normalizes balances into USD and weights `USDT` by each corridor's target share $w = \min(1, V_{\text{target}} / V_{\text{USDT}})$ (`~$24` per corridor) before computing skew $s \in [-1, +1]$:

$$V_{\text{USDT}} = \frac{\text{bal}_{\text{USDT}}}{10^6}, \qquad V_{\text{tok}} = \frac{\text{bal}_{\text{tok}}}{10^{\text{dec}_{\text{tok}}}} \cdot P_{\text{mid, eff}}, \qquad s = \frac{w \cdot V_{\text{USDT}} - V_{\text{tok}}}{w \cdot V_{\text{USDT}} + V_{\text{tok}}}$$

Given dynamic corridor base offsets ($\text{base}_{\text{buy}}, \text{base}_{\text{sell}}$) and bounded risk aversion $\gamma \in [2, 15]\text{ bps}$ (default $\gamma = 6\text{ bps}$):

$$\text{spread}_{\text{buy}} = \text{clamp}\left(\text{base}_{\text{buy}} - \gamma \cdot s, 1\text{ bps}, 150\text{ bps}\right), \qquad \text{spread}_{\text{sell}} = \text{clamp}\left(\text{base}_{\text{sell}} + \gamma \cdot s, 1\text{ bps}, 150\text{ bps}\right)$$

*(Raw un-weighted $V_{\text{USDT}} < \$1.00$ and $V_{\text{tok}} < \$1.00$ exhaustion guards remain enforced prior to share weighting so depleted sides halt immediately.)*

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
5. **Zero-Restart Rust Hot-Reload (`syncStitchRuntimePolicy` → `get_corridor_runtime_policy`):** Atomically updates `skew-policy.json` (`mtime`-checked every `2s` in Rust) alongside `stitch.runtime.toml` so both indicative WebSocket levels (`levels_for`) and firm RFQ quotes (`decide_quote`) adapt in real time with **zero Stitch process restarts or WebSocket disconnects**.

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
> **Point-in-Time Floor Snapshot (`2026-11-05 08:42 UTC` · Celo Mainnet Block `#81,967,402`):**
> All figures below match the synchronized checkpoint in [`README.md`](../README.md) and [`reports/EVIDENCE.md`](../reports/EVIDENCE.md). Because **Agent `#9905`** trades 24/7 on Celo Mainnet (`42220`), live cumulative totals can be verified at **[eugenennamdi.github.io/Skew](https://eugenennamdi.github.io/Skew/)** (`GET /status`, `GET /llm`) or **[Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)**.

Auditing transactions on Celo Mainnet `LimitOrderReactor` (`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`) highlights the structural trade-offs between the three agent designs deployed during the hackathon:

| Dimension | Skew (`Agent #9905` · Dual-Engine + Bounded AI) | Single-Sided Taker Bots | Unshielded Off-Chain FX Makers |
| :--- | :--- | :--- | :--- |
| **Market Role** | **4-Corridor Maker (`8/8` sides) + Cross-Venue Taker** | Taker-only (`0` Maker fills) | Multi-corridor Maker + DEX Rebalancer |
| **On-Chain Settlements** | **`2,839` signed EOA txs (`7,277` ERC-20 transfers)** | Taker-only settlement legs | Maker-only fills & periodic DEX swaps |
| **Maker Liquidity Served** | **24/7 `1s` WS quotes + `153` external fills (`$5,736.29` Maker volume)** | `0` fills (`$0` liquidity provided) | Exposed to cross-venue oracle lag & static spreads |
| **Cross-Venue Arbitrage & Total Volume** | **`1,363` 2-leg arbs (`$135,069.12` 1-leg arb · `$146,678.70` total 1-leg · `$293,357.40` 2-leg · `752.2x` turnover)** | Single-venue Taker sweeps | `0` Taker arbitrages |
| **Oracle-Lag & AI Defense** | **Hard `SELL >= max(P_textile, P_uni)` floor + EWMA/Markouts + Bounded Gemini 3.8 Flash (`2s` hot-reload)** | N/A (never quotes Maker orders) | Soft weighted median; exposed when off-chain FX lags DEX |
| **`wBRL` `MAX_TICK` Defense** | **`800k gas` `QuoterV2` guard + `197k gas` Textile RFQ fallback** | N/A | Rebalancer stalls on `0x01c3…A40F` (`17.04M gas`) |
| **Net Strategy Value & PnL** | **`$261.33` total value (`$195.00` bankroll + `+$66.33 USDT` net profit · `+34.02%` RoC = `$255.48` liquid equity + `$5.85` `CELO` gas reserve)** | Positive Taker PnL, `$0` Maker PnL | Negative cross-venue basis drift when off-chain FX lags Uniswap v3 |
