# <img src="docs/icons/skew-logo.svg" width="28" height="28" align="absmiddle" alt="Skew Logo" /> Skew v2

**Dual-Engine FX Market Maker (Dual-Oracle Anti-Arb Shield + Inventory Skew) & Autonomous Multi-Currency Treasury / Cross-Venue Arbitrage Desk on Celo Mainnet**

Skew is an autonomous FX liquidity, smart-pricing, and multi-currency treasury exposure management system built for the **Textile FX** sub-track of the Celo *Agents on Open Rails* hackathon (`Chain ID: 42220`), covering all four official Textile FX corridors (**`cNGN`**, **`wARS`**, **`wBRL`**, and **`USDC`** against **`USDT`**).

| Property | Value |
| :--- | :--- |
| **Live Trading & Telemetry Terminal** | **[`https://eugenennamdi.github.io/Skew/`](https://eugenennamdi.github.io/Skew/)** (Real-time Celo RPC + Blockscout v2 + Avellaneda-Stoikov Simulator) |
| **ERC-8004 Agent Identity** | **Agent `#9905`** on [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) · [`eip-8004#registration-v1` Metadata](docs/.well-known/agent-registration.json) |
| **Agent EOA Wallet** | [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) |
| **ERC-8021 Attribution Tag** | `celo_7935fb97e273` (`35-byte` suffix `0x63656c6f5f373933356662393765323733110080218021802180218021802180218021`) |
| **Textile Maker ID** | `cmv75ay6h00bq339u3x6gdicy` (`stitch-42220-e5036100`, seated across `cngn-usdt-celo`, `wars-usdt-celo`, `wbrl-usdt-celo`, `usdc-usdt-celo`) |
| **Independent Counterparty Audit** | **[`reports/EVIDENCE.md`](reports/EVIDENCE.md)** (`211` on-chain txs · **`$6,759.52` total volume** · `40` Maker fills (`$1,782.78`) · `55` 2-leg arbs (`+$6.83 USDT` realized)) |
| **Canonical Contracts** | Textile Reactor [`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`](https://celoscan.io/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3) · Permit2 [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://celoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |

---

## 1. Real-World Post-Mortem: Why Naive RFQ Makers Bleed on Emerging-Market FX (V1 → V2)

In on-chain FX marketplaces like Textile on Celo, local stablecoins (`cNGN`, `wARS`, `wBRL`, `USDC`) trade simultaneously on:
1. **Textile RFQ** (priced relative to an off-chain FX oracle mid-price $P_{\text{textile}}$), and
2. **Celo Uniswap v3** (`0.01%` fee pools: `cNGN/USDT` at `0x6519d56Eb0A69FC0338657784c783B169b8f7d32`, `wARS/USDT` at `0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391`, `USDC/USDT` at `0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846`, trading at live on-chain mid-price $P_{\text{uni}}$).

During our initial live deployment (**V1**), we observed two critical failure modes of standard static RFQ bots:
* **Adverse Selection from Oracle-vs-DEX Lag:** Whenever Textile's cron-sampled FX oracle lagged Celo Uniswap v3 (e.g., Textile's oracle pricing `1 USDT = 1,383.82 cNGN` or `1,671.06 wARS` while Uniswap v3 traded at `1,378.71 cNGN` and `1,641.81 wARS`), arbitrageurs swept static makers' local currency inventory on Textile and dumped it on Uniswap v3.
* **Sub-\$100 Liquidity Blindness:** Fixed-size taker scanners only probe large slices (`$467`, `$233`, `$116`) and discard `status: "no_quote"` responses even when Textile returns an explicit `availableSellAmount` field indicating actionable sub-`\$100` maker depth (such as `+187.5 bps` on `wARS/USDT`).

**Skew v2 solves both sides of the Textile FX market** with a unified **24/7 Dual-Engine Architecture**:
1. **Engine 1 (`./skew-stitch` in Rust):** A **4-Corridor Adaptive Inventory-Skew RFQ Maker** (`cNGN/USDT`, `wARS/USDT`, `wBRL/USDT`, `USDC/USDT`) equipped with a **Dual-Oracle Anti-Arb Shield** that reads live Celo Uniswap v3 `slot0()` prices every 2 seconds so the maker never sells below Uniswap v3, while tightening `BUY` spreads down to `1 bps` when holding excess `USDT`.
2. **Engine 2 (`node skew-desk.mjs` in Node/Ethers):** An **Autonomous Cross-Venue Arbitrage & Multi-Currency Treasury Exposure Manager** with **Adaptive `availableSellAmount` Sizing**, two-way Uniswap v3 `0.01%` auto-unwind/refill, EIP-712 `TakerControl` signing, and a live telemetry dashboard (`http://localhost:8080`, `/status`, `/trades`).

---

## 2. Mathematical Model

### A. Dual-Oracle Anti-Arb Shield (`src/pricing/skew.rs` & `src/rfq/mod.rs`)

Every `2 seconds` inside Stitch's batched Multicall3 RPC loop (`refresh_celo_dex_reference`), Skew reads `slot0()` (`0x3850c7bd`) from Celo Uniswap v3's primary pools (`cNGN/USDT`, `wARS/USDT`, and `USDC/USDT`) and computes the on-chain DEX mid-price $P_{\text{uni}}$ from `sqrtPriceX96`:

$$P_{\text{uni}} = \left(\frac{\text{sqrtPriceX96}}{2^{96}}\right)^2 \cdot 10^{\text{dec}_{\text{token}} - \text{dec}_{\text{USDT}}}$$

Before applying inventory-skew spreads, `effective_mid_for_side()` anchors each side of the book to the protective reference across both venues:

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{textile}}, \; P_{\text{uni}}\right), \qquad P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{textile}}, \; P_{\text{uni}}\right)$$

* **Guaranteed Positive-Edge Replenishment:** Because $P_{\text{mid, eff}}(\text{SELL}) \ge P_{\text{uni}}$, applying our dynamic ask spread prices our `SELL cNGN` ask at **`~1,370.63–1,372.81 cNGN/USDT`** while Uniswap v3 refills at **`~1,378.71 cNGN/USDT`**. Every single maker `SELL` fill locks in **`+42 to +59 bps` net profit** upon DEX replenishment.

### B. Multi-Decimal Inventory Skew ($s \in [-1, +1]$)

At each RFQ evaluation and 1-second indicative level broadcast across 6-decimal (`cNGN`, `USDC`, `USDT`) and 18-decimal (`wARS`, `wBRL`) tokens, Skew computes its normalized USD inventory imbalance:

$$s = \frac{V_{\text{USDT}} - V_{\text{collateral}}}{V_{\text{USDT}} + V_{\text{collateral}}}, \qquad V_{\text{collateral}} = \text{Balance}_{\text{collateral}} \times P_{\text{mid, eff}}$$

### C. Dynamic Spread Adjustment & Two-Way Treasury Recycling

Given per-corridor base spreads and sensitivity $\gamma = 30\text{ bps}$ (`SKEW_GAMMA_BPS`):

$$\text{spread}_{\text{buy}} = \text{clamp}\left(\text{base}_{\text{buy}} - \gamma \cdot s, \; 1\text{ bps}, \; 150\text{ bps}\right)$$

$$\text{spread}_{\text{sell}} = \text{clamp}\left(\text{base}_{\text{sell}} + \gamma \cdot s, \; 1\text{ bps}, \; 150\text{ bps}\right)$$

* **Top-of-Book `1 bps` `BUY` Capture + Uniswap Auto-Unwind:** When holding excess `USDT` ($s > +0.50$), `BUY` spreads tighten to **`1 bps`** across `cNGN`, `wARS`, `wBRL`, and `USDC`. Because Textile's oracle mid for `wARS` (`~1,671 wARS/USDT`) and `cNGN` (`~1,383 cNGN/USDT`) trades at a discount to Uniswap v3 (`1,641.8 wARS/USDT` and `1,378.8 cNGN/USDT`), Engine 2 (`skew-desk.mjs`) automatically unwinds incoming `wARS`, `USDC`, and excess `cNGN` fills on Uniswap v3 `0.01%` pools for **`+178 bps` (`wARS`), `+29 bps` (`cNGN`), and `+12 bps` (`USDC`) instant realized profit**.

### D. Adaptive `availableSellAmount` Cross-Venue Sizing (`skew-desk.mjs`)

When scanning all 4 official Textile FX corridors (`cNGN`, `wARS`, `wBRL`, `USDC` against `USDT`) across `textile -> uni` and `uni -> textile`:
1. `skew-desk.mjs` probes `POST /v2/rfq/preview` at `$25 USDT`.
2. If a maker's remaining depth is smaller than `$25` (`status: "no_quote", reason: "no_valid_quote"` with `availableSellAmount >= 1000000`), `skew-desk.mjs` **automatically re-quotes at `95%` of `availableSellAmount`**, signs an EIP-712 `TakerControl` proof (`POST /v2/rfq/request`), executes Leg 1 on Textile's `LimitOrderReactor`, and unwinds Leg 2 on Uniswap v3 `SwapRouter02`.

---

## 3. On-Chain Verification & Live Profit Proof (`celo_7935fb97e273`)

Every transaction sent by both `./skew-stitch` and `skew-desk.mjs` carries the 35-byte ERC-8021 attribution suffix `celo_7935fb97e273` (`63656c6f5f373933356662393765323733110080218021802180218021802180218021`). See **[`reports/EVIDENCE.md`](reports/EVIDENCE.md)** for the full transaction-by-transaction audit covering **`211` on-chain executions (`$6,759.52` cumulative volume, `100.0%` success across `107` txs today)**, including **`40` independent counterparty Maker fills (`$1,782.78`)** and **`55` 2-leg cross-venue arbitrages (`$2,678.40` volume, `+$6.8327 USDT` realized profit)**.

| Milestone / Execution Type | Counterparty | Realized Edge | On-Chain Transaction Proof (Celoscan) |
| :--- | :--- | :--- | :--- |
| **`53x` High-Frequency `cNGN/USDT` Cross-Venue Arb Blitz (`106` txs in 27m)** | External Maker (`0x25A5c1Ae...AB52`) → UniV3 `0.01%` | **`+48.6 bps` avg (`+$6.4390 USDT` on `$2,656.44` vol)** | **First Pair (`+64.2 bps` / `+$0.1605`):** [`0xe8b19d37...80cf`](https://celoscan.io/tx/0xe8b19d37fda658805c695456c273b6b7f99c6e139fd9b0b6353df4f4764b80cf) → [`0xb6f24012...ac50`](https://celoscan.io/tx/0xb6f240129cc53c3058fa25ac147779ddd9bbf1f98ae405f6ba68e2cf2f10ac50)<br>**53rd Pair (`+22.1 bps` / `+$0.0552`):** [`0x6e5d34bd...857f`](https://celoscan.io/tx/0x6e5d34bd1cbf3c361be998811c9132dcf6635e0991da9442f2fc4f45e1a2857f) → [`0xc9b92bcd...deb1`](https://celoscan.io/tx/0xc9b92bcdb87d7890eaca9060c7e07d3b34feca9691cfb72e4f4642e70ac8deb1) |
| **Shielded Maker Fill → DEX Refill #1 (`cNGN/USDT`)** | `#9995 naira-maker` (`0x8754FE21...744B`) | **`+41.1 bps` (`+$0.0740 USDT`)** | **Maker Fill (`24,799 cNGN → 18.062 USDT`):** [`0x51b95699...fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4)<br>**UniV3 Refill (`17.988 USDT → 24,800 cNGN`):** [`0x28d4e714...c6d5`](https://celoscan.io/tx/0x28d4e71468195aae4a1275a32dc935b2936e94864838267c3ecac3e8b436c6d5) |
| **Shielded Maker Fill → DEX Refill #2 (`cNGN/USDT`)** | `#9995 naira-maker` (`0x8754FE21...744B`) | **`+41.1 bps` (`+$0.0740 USDT`)** | **Maker Fill (`24,811 cNGN → 18.071 USDT`):** [`0x83037bbe...0400`](https://celoscan.io/tx/0x83037bbef5572efa61bd60bccb9dd61130ccd88fa715b41ea1d0312541390400)<br>**UniV3 Refill (`17.988 USDT → 24,799 cNGN`):** [`0x28269876...c47a`](https://celoscan.io/tx/0x28269876309cf739400af88f4dde7ead65dc70057143fcaaee22b6f3ba5dc47a) |
| **Institutional `$86` & `$80` Maker RFQ Fills (`wBRL` & `cNGN`)** | `#9991 Kiyoshi` (`0x497F...` / `0x6Cd3...`) | **`1 bps` & `+18.0 bps` Maker Spread** | **`459.57 wBRL → 86.48 USDT`:** [`0x9e9abd6d...5a5a`](https://celoscan.io/tx/0x9e9abd6d1ebb31a309642d6e58efb7f3e68d4d50e9942ca266bc49beaf7d5a5a) · **`110,627 cNGN → 80.00 USDT`:** [`0x855d155c...a4a9`](https://celoscan.io/tx/0x855d155c063195460508b15364a841482041bf7c3e458ff47d2a3d33b859a4a9) |
| **`wARS/USDT` Cross-Venue Arbitrage #1 (`Textile → UniV3`)** | `#9976 Arbolito Desk` (`0xBCB8B7dc...EdbE`) | **`+187.5 bps` (`+$0.1986` in 8s)** | **Leg 1 (`10.5942 USDT → 17,719.28 wARS`):** [`0xb202a9f1...c995`](https://celoscan.io/tx/0xb202a9f1e159b37f6b8f662652141903b293246a8810ebe7ae8dfabb9b1cc995)<br>**Leg 2 (`17,719.28 wARS → 10.7928 USDT`):** [`0x20da628c...2cef`](https://celoscan.io/tx/0x20da628c6a545ea95a2e9268d587b1e63be758e4fd30f147ce668a628ced2cef) |
| **`wARS/USDT` Cross-Venue Arbitrage #2 (`Textile → UniV3`)** | `#9976 Arbolito Desk` (`0xBCB8B7dc...EdbE`) | **`+171.7 bps` (`+$0.1951` in 15s)** | **Leg 1 (`11.3656 USDT → 18,980.05 wARS`):** [`0xca351a00...e87a`](https://celoscan.io/tx/0xca351a003354a2d5091f3af3ee5dd41ec938d743bdded128ef7192871316e87a)<br>**Leg 2 (`18,980.05 wARS → 11.5607 USDT`):** [`0x324c9f9b...bbed`](https://celoscan.io/tx/0x324c9f9b3a4339ba5fbba2b6b7050e7fedcc856a0dc774ffec70733b86b8bbed) |
| **`wBRL/USDT` Autonomous Inventory Seed (`Gas-Shielded Textile RFQ`)** | External Textile Maker (`0x8754FE21...744B`) | **`+130.0 bps` (`10.00 USDT → 53.89 wBRL`)** | [`0xc1fef26595abdbaa9455129cdc24a8ef0f7e138a2f8874bdd39a2f83113bfa53`](https://celoscan.io/tx/0xc1fef26595abdbaa9455129cdc24a8ef0f7e138a2f8874bdd39a2f83113bfa53) |
| **`USDC/USDT` Treasury Unwind (`UniV3 0.01%`)** | External RFQ Taker | **`+12.1 bps` (`10.98 USDC → 10.99 USDT`)** | [`0x1e18cfab4af41bd9d88c41f4814efd8439ea62b271aa5964c139f3a3d18d11d0`](https://celoscan.io/tx/0x1e18cfab4af41bd9d88c41f4814efd8439ea62b271aa5964c139f3a3d18d11d0) |
| **ERC-8004 Identity & `registration-v1` Metadata (`Agent #9905`)** | Identity Registry | Mint + `setAgentURI` | **Mint:** [`0x2a7659bf...8451`](https://celoscan.io/tx/0x2a7659bf72cd2c68295c488f7937d9bd2e6126f4155972d6be86dbbe01338451) · **`registration-v1` Upgrade:** [`0x9019d6c7...3b50`](https://celoscan.io/tx/0x9019d6c71cfd1b73657afa9086892fdff9daddb5eb428e3be98d4059c0ad3b50) |
| **Multi-Corridor Permit2 Approvals (`wARS`, `USDC`, `wBRL`, `cNGN`, `USDT`)** | Canonical Permit2 | 4 Corridors Active | [`0xe0109275...d639`](https://celoscan.io/tx/0xe01092757903a37e3fba521f0720ff48b600d10d02fdb15ac0d53d060d1cd639) · [`0x3a6cca0b...eb64`](https://celoscan.io/tx/0x3a6cca0bf3d9e4c2a9025aeaa935137a58f31f871938cb84c0f0d75b95c1eb64) · [`0xcb59bb02...f947`](https://celoscan.io/tx/0xcb59bb0271eb39968440154cfb75df581468d0470494e4b247559fcba3f8f947) |

---

## 4. Codebase Structure

* [`textile-stitch/src/pricing/skew.rs`](textile-stitch/src/pricing/skew.rs) — Core Dual-Oracle Anti-Arb Shield (`effective_mid_for_side`, `DEX_MID_CACHE`) + multi-decimal inventory skew engine (`calculate_inventory_skew_with_decimals`, `calculate_dynamic_spread_with_decimals`, `MIN_SPREAD_BPS = 1`) and unit tests.
* [`textile-stitch/src/rfq/responder.rs`](textile-stitch/src/rfq/responder.rs) — Firm RFQ quote pricing (`decide_quote`) and 1-second WebSocket orderbook streaming (`levels_for`) wired to the Dual-Oracle & Skew engine.
* [`textile-stitch/src/rfq/mod.rs`](textile-stitch/src/rfq/mod.rs) — Batched Celo Uniswap v3 `slot0()` reader (`refresh_celo_dex_reference`) refreshing `cNGN/USDT`, `wARS/USDT`, and `USDC/USDT` DEX mids every 2 seconds.
* [`textile-stitch/src/attribution.rs`](textile-stitch/src/attribution.rs) & [`textile-stitch/src/chain/tx.rs`](textile-stitch/src/chain/tx.rs) — Deterministic 35-byte ERC-8021 calldata suffix (`celo_7935fb97e273`) injected into every signed Rust transaction.
* [`skew-desk.mjs`](skew-desk.mjs) — Autonomous 4-corridor cross-venue arbitrage engine, two-way Uniswap v3 `0.01%` treasury auto-unwind/refill manager, EIP-712 `TakerControl` signer, ERC-8021 tagged transaction sender (`sendTagged`), and live telemetry web server (`http://localhost:8080`, `/status`, `/trades`).
* [`stitch.toml`](stitch.toml) — Multi-corridor Celo mainnet configuration (`cngn-usdt-celo`, `wars-usdt-celo`, `wbrl-usdt-celo`, `usdc-usdt-celo`).
* [`run-vm.sh`](run-vm.sh) — One-command 24/7 Google Cloud VM launcher with automatic maker enrollment (`./skew-stitch connect`), Permit2 approval verification (`./skew-stitch approve`), and `setsid` daemon detachment.

---

## 5. Quick Start & Verification

### 1. One-Command 24/7 Cloud VM Deployment
```bash
git clone https://github.com/eugenennamdi/Skew.git
cd Skew
./run-vm.sh
```

### 2. Run Self-Checks & Unit Tests
```bash
# Verify Rust Dual-Oracle Anti-Arb Shield, Inventory Skew & ERC-8021 Attribution
cd textile-stitch
cargo test --lib pricing::skew
cargo test --lib attribution
cargo test --lib rfq::responder
cd ..

# Verify Live Celo RPC + Textile 4-Corridor Scanner & Dual-Oracle Math
node skew-desk.mjs --check
```

---

## 6. License

Apache-2.0 / AGPL-3.0-or-later.
