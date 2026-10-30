# Skew Strategy & Celo FX Microstructure Deep-Dive

This document explains how **Skew (`ERC-8004 Agent #9905`)** prices, quotes, arbitrages, and rebalances across the four **Textile FX** corridors on Celo Mainnet (**`cNGN`**, **`wARS`**, **`wBRL`**, and **`USDC`** against **`USDT`**), and why a **Dual-Engine (Shielded Maker + Multi-Slice Taker)** architecture is required to stay profitable on both sides of the orderbook.

- **Live Telemetry Dashboard:** [eugenennamdi.github.io/Skew](https://eugenennamdi.github.io/Skew/)
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

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{textile}}, \; P_{\text{uni}}\right), \qquad P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{textile}}, \; P_{\text{uni}}\right)$$

- **On-chain proof of the shield in action:** On Oct 26 at `21:42Z`, external bot `#9995 naira-maker` (`0x8754FE21…744B`) lifted our `cNGN` ask when Textile's oracle lagged Uniswap v3 by `34 bps`. At `21:43Z`, we enabled `effective_mid_for_side()`. On the very next three fills (`21:44Z`, `21:58Z`, `22:02Z` — e.g. [`0x51b95699…fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4)), `#9995` paid **`1,372.92 cNGN/USDT`** to our Maker while `skew-desk.mjs` immediately refilled the exact `cNGN` on Uniswap v3 at **`1,378.71 cNGN/USDT`** ([`0x28d4e714…c6d5`](https://celoscan.io/tx/0x28d4e71468195aae4a1275a32dc935b2936e94864838267c3ecac3e8b436c6d5)), locking in **`+41.1 bps` (`+$0.0740 USDT`) risk-free profit per fill**.

---

## 2. Multi-Decimal Avellaneda-Stoikov Skew & Emerging-Market Carry

### A. Inventory Imbalance Across `6` and `18` Decimals
Because `USDT`, `cNGN`, and `USDC` use `6` decimals while `wARS` and `wBRL` use `18` decimals, `calculate_inventory_skew_with_decimals()` normalizes both balances into USD before computing skew $s \in [-1, +1]$:

$$V_{\text{USDT}} = \frac{\text{bal}_{\text{USDT}}}{10^6}, \qquad V_{\text{tok}} = \frac{\text{bal}_{\text{tok}}}{10^{\text{dec}_{\text{tok}}}} \cdot P_{\text{mid, eff}}, \qquad s = \frac{V_{\text{USDT}} - V_{\text{tok}}}{V_{\text{USDT}} + V_{\text{tok}}}$$

Given corridor base spreads and risk aversion $\gamma = 30\text{ bps}$:

$$\text{spread}_{\text{buy}} = \text{clamp}\left(\text{base}_{\text{buy}} - \gamma \cdot s, \; 1\text{ bps}, \; 150\text{ bps}\right), \qquad \text{spread}_{\text{sell}} = \text{clamp}\left(\text{base}_{\text{sell}} + \gamma \cdot s, \; 1\text{ bps}, \; 150\text{ bps}\right)$$

### B. 3-Source Off-Chain FX Triangulation & Daily Crawl Carry
Alongside Textile RFQ and Celo Uniswap v3, [`skew-desk.mjs`](../skew-desk.mjs) fetches live independent off-chain FX rates (`open.er-api.com` for `NGN`/`BRL` and `dolarapi.com/v1/dolares/cripto` for `ARS`) and incorporates daily emerging-market currency carry/crawl into the Autonomous Risk Officer:

| Corridor | Token Decimals | Primary Celo Uniswap v3 Pool (`0.01%`) | Off-Chain Reference Source | Daily Crawl / Carry (`bps/day`) | Target Maker Reserve |
| :--- | :---: | :--- | :--- | :---: | :---: |
| **`cNGN / USDT`** | `6` | `0x6519d56Eb0A69FC0338657784c783B169b8f7d32` | `open.er-api.com` (`USD/NGN`) | `8.5 bps/day` | `$18.00 cNGN` + `USDT` |
| **`wARS / USDT`** | `18` | `0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391` | `dolarapi.com` (`ARS cripto`) | `13.3 bps/day` | `$15.00 wARS` + `USDT` |
| **`wBRL / USDT`** | `18` | `0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F` *(shielded)* | `open.er-api.com` (`USD/BRL`) | `4.2 bps/day` | `$15.00 wBRL` + `USDT` |
| **`USDC / USDT`** | `6` | `0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846` | `$1.00` USD Peg | `0.0 bps/day` | `$15.00 USDC` + `USDT` |

---

## 3. Multi-Slice (`100% / 50% / 25%`) + Adaptive `availableSellAmount` Taker

In [`skew-desk.mjs`](../skew-desk.mjs), `scanCorridor()` combines two complementary sizing mechanisms:

1. **Multi-Slice Dynamic Budget (`computeSliceSizesUsdt`):**
   - Evaluates candidate slices at **`100%`, `50%`, and `25%` of available liquid `USDT`** (up to `$150` max slice, plus a `$25` baseline).
   - If the `100%` slice (e.g. `$126 USDT`) experiences Uniswap v3 price impact that reduces net `edgeUsd`, the scanner automatically evaluates the `50%` (`$63`) and `25%` (`$31.50`) slices and selects whichever slice maximizes net dollar profit (`edgeUsd`).
2. **Adaptive Sub-Slice Resizing (`availableSellAmount`):**
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

Auditing all `1,500+` transactions on Celo Mainnet `LimitOrderReactor` (`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`) highlights the structural trade-offs between the three agent designs deployed during the hackathon:

| Dimension | Skew (`Agent #9905` · Dual-Engine) | Single-Sided Taker Bots | Unshielded Off-Chain FX Makers |
| :--- | :--- | :--- | :--- |
| **Market Role** | **4-Corridor Maker (`8/8` sides) + Cross-Venue Taker** | Taker-only (`0` Maker fills) | Multi-corridor Maker + DEX Rebalancer |
| **Maker Liquidity Served** | **`41` external fills (`$2,111.50` Maker volume)** | `0` fills (`$0` liquidity provided) | `24`–`140+` fills (picked off on cross-venue lag) |
| **Taker Arbitrage Volume** | **`690` 2-leg arbs (`$49,604+` 1-leg / `$99,208+` 2-leg volume · `254.4x` turnover)** | High-volume Taker sweeps | `0` Taker arbitrages |
| **Oracle-Lag Defense** | **Hard `SELL >= max(P_textile, P_uni)` shield (`+41.1 bps` refill edge)** | N/A (never quotes Maker orders) | Soft weighted median; picked off when off-chain FX lags DEX |
| **`wBRL` `MAX_TICK` Defense** | **`800k gas` `QuoterV2` guard + `197k gas` Textile RFQ fallback** | N/A | Rebalancer stalls on `0x01c3…A40F` (`17.04M gas`) |
| **Net Realized PnL** | **`+$36.71 USDT` (`+18.83%` RoC · `$227.86` live equity)** | Positive Taker PnL, `$0` Maker PnL | **Negative cross-venue arb bleed to our Taker (`-$31.8k` net flow)** |
