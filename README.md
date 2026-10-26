# Skew v2

**Dual-Engine FX Market Maker (Dual-Oracle Anti-Arb Shield + Inventory Skew) & Autonomous Cross-Venue Arbitrage Desk on Celo Mainnet**

Skew is an autonomous FX liquidity and cross-venue execution system built for the **Textile FX** sub-track of the Celo *Agents on Open Rails* hackathon (`Chain ID: 42220`).

| Property | Value |
| :--- | :--- |
| **ERC-8004 Agent Identity** | **Agent `#9905`** on [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB64A4C7f7324) |
| **Agent EOA Wallet** | [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) |
| **ERC-8021 Attribution Tag** | `celo_7935fb97e273` (`35-byte` suffix `0x63656c6f5f373933356662393765323733110080218021802180218021802180218021`) |
| **Textile Maker ID** | `cmv75ay6h00bq339u3x6gdicy` (`cNGN ↔ USDT` seated maker on Celo) |
| **Canonical Contracts** | Textile Reactor [`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`](https://celoscan.io/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3) · Permit2 [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://celoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |

---

## 1. The Problem We Solved: Why Naive RFQ Makers Bleed on Emerging-Market FX

In RFQ FX protocols like Textile on Celo, local stablecoins (`cNGN`, `wARS`, `wBRL`) trade simultaneously on:
1. **Textile RFQ** (priced relative to an off-chain FX oracle mid-price $P_{\text{textile}}$), and
2. **Celo Uniswap v3** (`0.01%` fee pools such as `cNGN/USDT` at `0x6519d56Eb0A69FC0338657784c783B169b8f7d32` with `~$175k` TVL, trading at on-chain mid-price $P_{\text{uni}}$).

Whenever the off-chain FX oracle lags the on-chain DEX market (for example, Textile's oracle pricing `1 USDT = 1,383.22 cNGN` while Celo Uniswap v3 trades at `1 USDT = 1,378.59 cNGN`—a `33.6 bps` structural divergence):
* **Static RFQ Makers Get Picked Off:** A standard maker quoting tight offsets around $P_{\text{textile}}$ sells `cNGN` cheaper than Uniswap v3's spot bid and loses money every time it refills inventory on Uniswap.
* **Fixed-Size Taker Scanners Miss Sub-\$100 Liquidity:** Existing taker bots only probe large fixed slices (`$467`, `$233`, `$116`) and discard `status: "no_quote"` responses even when Textile returns an explicit `availableSellAmount` field indicating profitable sub-`\$100` maker depth (such as `+195 bps` on `wARS/USDT`).

**Skew v2 solves both sides of the market** with a unified **Dual-Engine Architecture**:
1. **Engine 1 (`./skew-stitch` in Rust):** An **Adaptive Inventory-Skew RFQ Maker** equipped with a **Dual-Oracle Anti-Arb Shield** that reads live Celo Uniswap v3 `slot0()` prices every 2 seconds and guarantees the maker never sells below Uniswap v3 or buys above Uniswap v3.
2. **Engine 2 (`node skew-desk.mjs` in Node/Ethers):** An **Autonomous Multi-Corridor Cross-Venue Arbitrage, Auto-Refill & Telemetry Desk** with **Adaptive `availableSellAmount` Sizing** and a live web dashboard (`http://localhost:8080`).

---

## 2. Mathematical Model

### A. Dual-Oracle Anti-Arb Shield (`src/pricing/skew.rs` & `src/rfq/mod.rs`)

Every `2 seconds` inside Stitch's batched RPC loop (`refresh_celo_dex_reference`), Skew reads `slot0()` (`0x3850c7bd`) from Celo Uniswap v3's primary pools (`cNGN/USDT` and `wARS/USDT`) and computes the on-chain DEX mid-price $P_{\text{uni}}$ from `sqrtPriceX96`:

$$P_{\text{uni}} = \left(\frac{\text{sqrtPriceX96}}{2^{96}}\right)^2 \cdot 10^{\text{dec}_{\text{token}} - \text{dec}_{\text{USDT}}}$$

Before applying inventory-skew spreads, `effective_mid_for_side()` anchors each side of the book to the worst-case reference across both venues:

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{textile}}, \; P_{\text{uni}}\right)$$

$$P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{textile}}, \; P_{\text{uni}}\right)$$

* **Guaranteed Positive-Edge Refills:** Because $P_{\text{mid, eff}}(\text{SELL}) \ge P_{\text{uni}}$, applying a dynamic sell spread $\text{spread}_{\text{sell}} \in [35, 65]\text{ bps}$ prices our `SELL cNGN` ask at **`~1,369.97 cNGN/USDT`** while Uniswap v3 refills at **`~1,378.74 cNGN/USDT`**. Every single maker fill locks in **`+64 bps` net profit** upon DEX replenishment.

### B. Multi-Decimal Inventory Skew ($s \in [-1, +1]$)

At each RFQ evaluation and 1-second indicative level broadcast, the agent computes its normalized USD inventory imbalance across both 6-decimal (`cNGN`, `USDT`) and 18-decimal (`wARS`, `wBRL`) tokens:

$$s = \frac{V_{\text{USDT}} - V_{\text{collateral}}}{V_{\text{USDT}} + V_{\text{collateral}}}, \qquad V_{\text{collateral}} = \text{Balance}_{\text{collateral}} \times P_{\text{mid, eff}}$$

### C. Dynamic Spread Adjustment

Given base spreads $\text{base}_{\text{buy}} = 25\text{ bps}$, $\text{base}_{\text{sell}} = 35\text{ bps}$, and sensitivity $\gamma = 30\text{ bps}$ (`SKEW_GAMMA_BPS`):

$$\text{spread}_{\text{buy}} = \text{clamp}\left(\text{base}_{\text{buy}} - \gamma \cdot s, \; 6\text{ bps}, \; 150\text{ bps}\right)$$

$$\text{spread}_{\text{sell}} = \text{clamp}\left(\text{base}_{\text{sell}} + \gamma \cdot s, \; 6\text{ bps}, \; 150\text{ bps}\right)$$

```
   [Excess USDT / Low cNGN (s > 0)]          [Excess cNGN / Low USDT (s < 0)]
────────────────────────────────────────  ────────────────────────────────────────
• BUY cNGN tightens (down to 6 bps)       • BUY cNGN widens (up to 55 bps)
• SELL cNGN widens (+64 bps above UniV3)  • SELL cNGN tightens toward base (35 bps)
• Auto-Refill swaps USDT→cNGN on UniV3    • Passively offloads cNGN for USDT
```

### D. Adaptive `availableSellAmount` Cross-Venue Sizing (`skew-desk.mjs`)

When scanning all 7 Celo corridors (`cNGN`, `wARS`, `wBRL`, `USDC`, `CELO`, `USAT`, `WETH`) across `textile -> uni` and `uni -> textile`:
1. `skew-desk.mjs` probes `POST /v2/rfq/preview` at its target probe size (`$25 USDT`).
2. If a maker's remaining depth is smaller than `$25` (`status: "no_quote", reason: "no_valid_quote"` with `availableSellAmount > 0`), `skew-desk.mjs` **automatically re-quotes at `95%` of `availableSellAmount`** and simulates the opposing leg on Uniswap v3 `QuoterV2` across all 4 fee tiers (`100`, `500`, `3000`, `10000`).
3. This captures high-margin micro-opportunities (such as `+195.0 bps` / `+$0.0146` on `wARS/USDT`) that fixed-slice bots ignore.

---

## 3. Codebase Structure

* [`textile-stitch/src/pricing/skew.rs`](file:///Users/apple/Desktop/Skew/textile-stitch/src/pricing/skew.rs) — Core Dual-Oracle Anti-Arb Shield (`effective_mid_for_side`, `DEX_MID_CACHE`) + multi-decimal inventory skew engine (`calculate_inventory_skew_with_decimals`, `calculate_dynamic_spread_with_decimals`) and unit tests.
* [`textile-stitch/src/rfq/responder.rs`](file:///Users/apple/Desktop/Skew/textile-stitch/src/rfq/responder.rs) — Firm RFQ quote pricing (`decide_quote`) and 1-second WebSocket orderbook streaming (`levels_for`) wired to the Dual-Oracle & Skew engine.
* [`textile-stitch/src/rfq/mod.rs`](file:///Users/apple/Desktop/Skew/textile-stitch/src/rfq/mod.rs) — Batched Celo Uniswap v3 `slot0()` reader (`refresh_celo_dex_reference`) refreshing `cNGN/USDT` and `wARS/USDT` DEX mids every 2 seconds.
* [`textile-stitch/src/attribution.rs`](file:///Users/apple/Desktop/Skew/textile-stitch/src/attribution.rs) & [`textile-stitch/src/chain/tx.rs`](file:///Users/apple/Desktop/Skew/textile-stitch/src/chain/tx.rs) — Deterministic 35-byte ERC-8021 calldata suffix (`celo_7935fb97e273`) injected into every signed Rust transaction.
* [`skew-desk.mjs`](file:///Users/apple/Desktop/Skew/skew-desk.mjs) — Autonomous multi-corridor cross-venue arbitrage engine, Uniswap v3 `0.01%` inventory auto-refiller, ERC-8021 tagged transaction sender (`sendTagged`), and live telemetry web server (`http://localhost:8080`, `/status`, `/trades`).
* [`stitch.toml`](file:///Users/apple/Desktop/Skew/stitch.toml) — Production Celo mainnet configuration synced for `cngn-usdt-celo` (`maker_id = "cmv75ay6h00bq339u3x6gdicy"`).

---

## 4. On-Chain Verification & Attribution Proof

Every transaction sent by both `./skew-stitch` and `skew-desk.mjs` carries the 35-byte ERC-8021 attribution suffix `celo_7935fb97e273` (`63656c6f5f373933356662393765323733110080218021802180218021802180218021`):

| Milestone | Status | On-Chain Transaction / Reference |
| :--- | :--- | :--- |
| **ERC-8004 Identity (`Agent #9905`)** | Verified On-Chain | [`0x2a7659bf72cd2c68295c488f7937d9bd2e6126f4155972d6be86dbbe01338451`](https://celoscan.io/tx/0x2a7659bf72cd2c68295c488f7937d9bd2e6126f4155972d6be86dbbe01338451) |
| **Permit2 Approvals (USDT & cNGN)** | Verified On-Chain | [`0x154d94603940534454a782f6aa66a0fb80025a34be3fa129086821662b19216d`](https://celoscan.io/tx/0x154d94603940534454a782f6aa66a0fb80025a34be3fa129086821662b19216d) |
| **Textile Reactor Batch Settlements** | Verified On-Chain | [`0xa338a8305f74f8b3b67e0587d2a8a37d69c0a5273b93145b1c497d92f6c04088`](https://celoscan.io/tx/0xa338a8305f74f8b3b67e0587d2a8a37d69c0a5273b93145b1c497d92f6c04088) · [`0x5e650ec670999ef65c036ff7e0e0d1e57e19dbc0e78f6ab952eca0b824cd0708`](https://celoscan.io/tx/0x5e650ec670999ef65c036ff7e0e0d1e57e19dbc0e78f6ab952eca0b824cd0708) |
| **Live RFQ Fills on Celo Mainnet** | Verified On-Chain | [`0xfbde3367dd38cab1bac3ddacb6e48b067004354d75c86f9e3984954eb06df732`](https://celoscan.io/tx/0xfbde3367dd38cab1bac3ddacb6e48b067004354d75c86f9e3984954eb06df732) |

---

## 5. Quick Start & Verification

### 1. Run Self-Checks & Unit Tests
```bash
# Verify Rust Dual-Oracle Anti-Arb Shield, Inventory Skew & ERC-8021 Attribution
cd textile-stitch
cargo test --lib pricing::skew
cargo test --lib attribution
cargo test --lib rfq::responder
cd ..

# Verify Live Celo RPC + Textile Multi-Corridor Scanner & Dual-Oracle Math
node skew-desk.mjs --check
```

### 2. Run Engine 1: Adaptive Inventory-Skew Maker (`./skew-stitch`)
```bash
export STITCH_PRIVATE_KEY="0x..."
export STITCH_RFQ_API_KEY_FILE="textile-stitch/rfq-api.key"
export SKEW_GAMMA_BPS=30
export RUST_LOG=info

./skew-stitch --config stitch.toml
```

### 3. Run Engine 2: Cross-Venue Arbitrage, Auto-Refill & Live Dashboard (`skew-desk.mjs`)
```bash
# Watch + Telemetry Dashboard mode (serves UI on http://localhost:8080, /status, /trades)
node skew-desk.mjs

# Live On-Chain Arbitrage + Autonomous cNGN Inventory Refill mode (with ERC-8021 tagging)
STITCH_PRIVATE_KEY="0x..." LIVE=1 AUTO_REFILL=1 MIN_EDGE_USD=0.01 node skew-desk.mjs
```

---

## 6. License

Apache-2.0 / AGPL-3.0-or-later.
