# Skew (`Agent #9905`) — Independent Counterparty & On-Chain Evidence Audit

- **Agent Name**: **Skew — Autonomous AI-Supervised FX Market Maker & Cross-Venue Arbitrageur**
- **Track**: **Open Corridors: Textile FX** (`cNGN`, `wARS`, `wBRL`, `USDC` vs `USDT` on Celo Mainnet `42220`)
- **ERC-8004 Identity**: **Agent `#9905`** on [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) (Mint: [`0x2a7659bf...8451`](https://celoscan.io/tx/0x2a7659bf72cd2c68295c488f7937d9bd2e6126f4155972d6be86dbbe01338451) · `eip-8004#registration-v1` `setAgentURI` Upgrade: [`0x9019d6c7...3b50`](https://celoscan.io/tx/0x9019d6c71cfd1b73657afa9086892fdff9daddb5eb428e3be98d4059c0ad3b50))
- **ERC-8021 Attribution Suffix**: `celo_7935fb97e273` (`35-byte` suffix `0x63656c6f5f373933356662393765323733110080218021802180218021802180218021`)
- **Agent EOA Wallet (Maker & Taker)**: [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)
- **Textile Stitch Maker ID**: `cmv75ay6h00bq339u3x6gdicy` (`stitch-42220-e5036100`)

> [!NOTE]
> **Synchronized Mainnet Audit Checkpoint (`2026-11-08 19:01 UTC` · Celo Mainnet Block `#82,263,550`):**
> **ERC-8004 Agent `#9905`** ([`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)) quotes and arbitrages autonomously 24/7 on Celo Mainnet (`42220`). All static metrics in [`README.md`](../README.md), [`docs/STRATEGY.md`](../docs/STRATEGY.md), and this report are synchronized to this verified checkpoint and represent **lower-bound floor minimums**. Live cumulative totals can be verified at the **[Live RPC Telemetry Dashboard](https://eugenennamdi.github.io/Skew/)** (`GET /status`, `GET /llm`) or directly on **[Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)** / **[Blockscout](https://celo.blockscout.com/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)**.

---

## 1. Executive Summary: Realized Closed-Fill P&L vs. Mark-to-Market Valuation & Fixed-Spread Baseline

> **Reproducible On-Chain P&L & Fill Verifier:** Run `node scripts/verify-onchain-pnl.mjs` (or `node scripts/verify-onchain-pnl.mjs --live`) against [`scripts/verify-onchain-pnl.mjs`](../scripts/verify-onchain-pnl.mjs) and the committed on-chain fill ledger [`reports/onchain-fills-ledger.json`](onchain-fills-ledger.json) to deterministically verify every Realized P&L, Mark-to-Market NAV, Independent Maker Fill, RFQ Funnel, and Fixed-Spread Baseline figure below.

Starting from a **`$195.00 USDT`** initial bankroll on Celo Mainnet (`42220`) with zero external stablecoin deposits since launch:
- **Realized Closed-Fill P&L (`+$95.97 USDT` · `+49.22%` realized RoC):** Computed strictly from settled on-chain fills net of Textile's `sellAmount` protocol fee (`GET /v2/rfq/{id}`) and Celo Uniswap v3 inventory replenishment costs:
  1. **Independent External Maker Fills (`179` fills · `$6,527.97` Maker volume · `0` self-trades):** **`+$4.85 USDT` (`+7.43 bps` net edge)** after `$0.65 USDT` in Textile protocol fees and `$0.66 USDT` in Uniswap v3 replenishment costs.
  2. **Self-Initiated 2-Leg Cross-Venue Taker Arbitrages (`1,794` cycles · `3,588` txs · `$193,344.64` 1-leg volume · `0` self-fills):** **`+$91.12 USDT` (`+4.71 bps` net edge)** after `$2.86 USDT` in pool/protocol fees and `$2.62 USDT` in Celo gas.
- **Mark-to-Market (MTM) Inventory Valuation (`-$0.39 USDT` unrealized FX delta → `$290.58` Liquid Stablecoin Treasury Equity · `+$95.58 USDT` net liquid gain · `+49.02%` MTM RoC):** Consists of `194.58 USDT` (`$194.58`) + `35,768.44 cNGN` (`$25.92`) + `42,917.15 wARS` (`$25.95`) + `134.36 wBRL` (`$24.13`) + `20.00 USDC` (`$20.00`), plus **`$5.85 USDT` autonomously converted into native `CELO` gas reserves** (`18.20 CELO` currently held on-chain · **`$296.43` total strategy value** / **`+$101.43 USDT` · `+52.02%` RoC**):

| Category (Separated per Sponsor Rubric) | Settled Count | 1-Leg Volume (USD) | Realized Closed-Fill P&L | Mark-to-Market / Counterparty Notes |
| :--- | :---: | :---: | :--- | :--- |
| **1. Independent External Maker Fills (`skew-stitch`)** | **179 external fills (`0` self-trades)** | **`$6,527.97`** | **`+$4.85 USDT` (`+7.43 bps` net)** | External Takers (`0x2791...`, `0x6bc7...`, `#9991`, `#9908`, `#9995`) net of `sellAmount` fee |
| **2. Self-Initiated Cross-Venue Taker Arbs (`skew-desk.mjs`)** | **1,794 arbs (`3,588` txs)** | **`$193,344.64`** | **`+$91.12 USDT` (`+4.71 bps` net)** | External Makers (`0x25A5c1Ae...`, `0xa601e4ad...`, `#9976 Arbolito`) ◄──► Uniswap v3 `0.01%` |
| **Subtotal: Settled Trade Volume (Excl. Treasury Refills)** | **`1,973` settled trade events** | **`$199,872.61` 1-leg trade volume** | **`+$95.97 USDT` Realized (`+49.22%`)** | **`$6,527.97` Independent Maker Fills + `$193,344.64` 1-Leg Cross-Venue Arbs (`0` treasury refills included)** |
| **3. Memo: Non-Fill Treasury Rebalances & Unrealized FX MTM** | **280 swaps (`+36` setup / `7` reverted)** | **`$7,184.50` *(non-fill rebalance)*** | **`$0.00` realized (`-$0.39` MTM)** | `-$0.39 USDT` unrealized FX delta on `$96.00` local reserves + `$5.85` `CELO` gas reserve |
| **Total Verified Wallet Activity (`Block #82,263,550`)** | **`3,911` signed EOA txs (`9,996` ERC-20 transfers)** | **`$199,872.61` trade (`$207,057.11` gross · `$414,114.22` 2-leg · `$828,228.43` 2-way · `1,061.8x`)** | **`+$95.97 USDT` Realized (`+49.22%`)** | **`+$95.58 USDT` Net Liquid MTM (`+49.02%` · `$290.58` liquid / `$296.43` total strategy value)** |

### 1A. RFQ Quote Funnel & Fixed-Spread Filler Baseline Comparison (`reports/onchain-fills-ledger.json`)

| Maker Strategy / Baseline (Same `1,412` RFQs & `sellAmount` Fee Rules) | Quotes Answered | Competitive Top-of-Book Share (`<=2 bps`) | External Fills (`0` Self-Trades) | Filled Maker Volume | Adverse-Selection Loss Fills | Net Realized Maker P&L (USDT) | Net Realized Edge (bps) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Skew Shielded Maker (`min/max(TWAP, DEX)` + Vol/Markout + Lean)** | **`1,412 / 1,420` (`99.44%`)** | **`68.41%` (`966 / 1,412`)** | **`179` (`12.68%` overall · `18.53%` when competitive)** | **`$6,527.97`** | **`2 / 179` (`1.1%`)** | **`+$4.85 USDT`** | **`+7.43 bps`** |
| **Baseline A: Unshielded Fixed `5 bps` Filler (Around Off-Chain `P_textile`)** | `1,412 / 1,420` (`99.44%`) | `74.15%` (`1,047 / 1,412`) | `179` | `$6,527.97` | `141 / 179` (`78.8%`) | `-$14.62 USDT` | `-22.40 bps` |
| **Baseline B: Unshielded Fixed `25 bps` Static Filler (Default Template)** | `1,412 / 1,420` (`99.44%`) | `11.40%` (`161 / 1,412`) | `39` (misses `78.2%` of flow) | `$1,425.10` | `31 / 39` (`79.5%`) | `-$3.18 USDT` | `-22.31 bps` |

### 1B. Independent External Maker Counterparty On-Chain Breakdown (`tx.from != 0xe503…7324`)

| External On-Chain Counterparty Address | Role / Settlement Path | Independent Maker Fills | Maker Volume (USD) | Sample On-Chain Settlement Tx |
| :--- | :--- | :---: | :---: | :--- |
| [`0x27912db8e4b64c6f9b8c32f84a83d20987c839f4`](https://celoscan.io/address/0x27912db8e4b64c6f9b8c32f84a83d20987c839f4) | Textile RFQ Settlement Relayer / Split-Order Executor | `114` | `$4,192.60` | [`0xa7998f88…3700`](https://celoscan.io/tx/0xa7998f8818477463df200fc1001fd849ff0a41a21b208df29b8e119b489b3700) |
| [`0x6bc712f2a2d1b9c84e5e0a00383a9a18e4471d02`](https://celoscan.io/address/0x6bc712f2a2d1b9c84e5e0a00383a9a18e4471d02) | External FX Taker / Aggregator Router | `38` | `$1,384.12` | [`0x1d400863…6d0b`](https://celoscan.io/tx/0x1d400863a02d062fa0ce40176386bc269738515c3ab38c26eb3d3637d5066d0b) |
| [`0x94c19a76e550298b2101f44b8f19c97a30f642c1`](https://celoscan.io/address/0x94c19a76e550298b2101f44b8f19c97a30f642c1) | External Celo Corridor Taker Bot | `19` | `$681.05` | [`0xbb7d6998…04f5`](https://celoscan.io/tx/0xbb7d6998a22731978fc86bd72a61442498a472a23ec477416f9fb89f96cc04f5) |
| [`0x4e8f3c11d902b77a581340f2c7710a9d35b1c88e`](https://celoscan.io/address/0x4e8f3c11d902b77a581340f2c7710a9d35b1c88e) | Independent Wallet Taker (Direct `LimitOrderReactor` Execute) | `8` | `$270.20` | [`0xd43898c0…7ca1`](https://celoscan.io/tx/0xd43898c0bf345e534a9a986cc56cc30ca7b2ab3923eb22f95fd1261192d07ca1) |

> **Anti-Self-Trade & Zero-Gas Firm-Quote Guardrails (`skew-desk.mjs`)**:
> Before submitting any `LimitOrderReactor` transaction, `skew-desk.mjs` inspects the signed `DutchOrder` `OrderInfo.swapper` word (`isSelfMakerOrder(calldata)`) for our own Maker address and verifies via `verifyFirmArbQuote()` that the firm EIP-712 `outputs[0]` post-gas return beats `MIN_FIRM_NET_EDGE_USD` (`$0.018` / `1.2 bps`)—aborting bait-and-slip previews at **`0 gas`** and ensuring the Taker only lifts **external** Makers profitably.

---

## 2. Verified Independent Counterparty Maker Fills (`179` External Fills · `$6,527.97` Foundational Liquidity Provided)

Rather than operating as a single-sided taker, Skew serves as **foundational market-making infrastructure** on Textile FX—streaming continuous `1s` WebSocket depth levels and firm `Permit2` `DutchOrder` RFQ quotes across all 4 corridors (`cNGN`, `wARS`, `wBRL`, `USDC`) to serve independent on-chain agents and routers (`#9991`, `#9908`, `#9995`, `0xd770...eb67`, `0x7769...a734`). Representative institutional and shielded fills settled on `LimitOrderReactor` against our Stitch Maker (`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`):

| # | Timestamp (UTC) | Corridor | External Taker (Counterparty) | Maker Out | Maker In | Paired Execution / Router Outcome | Net Realized Edge | On-Chain Proof |
| :-: | :--- | :--- | :--- | :---: | :---: | :--- | :---: | :--- |
| **0** | `2026-11-07 17:28:06Z` | `wBRL/USDT` | External Router (`0xd7700c8f...eb67`) | `192.7658 USDT` | `1,077.4217 wBRL` | Institutional `$193.47` Maker bid fill unwound into `USDT` | **Top-of-Book Win (`$193.47`)** | [`0xe0f685a5...9786`](https://celoscan.io/tx/0xe0f685a58f07ac76a07a1fc05e1b27a71cb560a3480eb45f6623dd1de5909786) |
| **1** | `2026-11-03 23:59:20Z` | `wARS/USDT` | `#9991 Kiyoshi` (`0x497F1283...512f`) | `176.9033 USDT` | `292,150.09 wARS` | Won **`90.7%`** of `$195.04` `executeBatch` split ahead of `#9929` (`$18.14`) | **Top-of-Book Split Win** | [`0xbbff102f...51cd`](https://celoscan.io/tx/0xbbff102f3778308dd8c724e73c7f06d04f5d3b0b138307b9dd48a13e014751cd) |
| **2** | `2026-11-03 22:00:15Z` | `wARS/USDT` | `#9991 Kiyoshi` (`0x6Cd37bC2...81dC`) | `178.3523 USDT` | `295,566.66 wARS` | Won **`55.2%`** of `$322.84` `executeBatch` split ahead of `#9929` (`$144.49`) | **Top-of-Book Split Win** | [`0x68c3b989...2a83`](https://celoscan.io/tx/0x68c3b9899c73cb181a792a1d85d886a81f4d101a4fcadc297d8c219547542a83) |
| **3** | `2026-11-03 14:46:13Z` | `wARS/USDT` | `#9991 Kiyoshi` (`0x497F1283...512f`) | `178.6118 USDT` | `295,250.52 wARS` | Institutional `$178.61` Maker bid fill recycled on Uniswap v3 `0.01%` | **Top-of-Book Unwind** | [`0xb4f0a9ad...0896`](https://celoscan.io/tx/0xb4f0a9ad50452f187d5e4885a337dd210ba98b93d23b714a7fb963383e2e0896) |
| **4** | `2026-10-29 13:52:41Z` | `cNGN/USDT` | `#9908 Naira Desk` (`0xEfdFcb05...`) | `140.2795 USDT` | `193,716.31 cNGN` | Sold `193,747 cNGN` for `140.2908 USDT` 27s later ([`0x6f82fbaa...`](https://celoscan.io/tx/0x6f82fbaa43677a010fcc6da464719dd4edf1998468d0d5c5c2f79cf64a4f565d)) | **`+$0.0113 USDT` (`1 bps` Top-of-Book)** | [`0xd13ec8ec...937e`](https://celoscan.io/tx/0xd13ec8ec5b95d4b90e1bfe856da0e0881b38a01c6e833f225dbb11cb8ec8937e) |
| **5** | `2026-10-27 13:46:09Z` | `wBRL/USDT` | `#9991 Kiyoshi` (`0x497F1283...512f`) | `86.4820 USDT` | `459.5680 wBRL` | Active Maker `wBRL` reserve (`5.3140 wBRL/USDT`) | **`1 bps` Top-of-Book** | [`0x9e9abd6d...5a5a`](https://celoscan.io/tx/0x9e9abd6d1ebb31a309642d6e58efb7f3e68d4d50e9942ca266bc49beaf7d5a5a) |
| **6** | `2026-10-27 09:15:22Z` | `cNGN/USDT` | `#9991 Kiyoshi` (`0x497F1283...512f`) | `3,660.50 cNGN` | `2.6659 USDT` | Shielded ask `1,373.08 cNGN/USDT` vs `1,378.71` DEX mid | **`+41.0 bps` (`+$0.0109`)** | [`0x02c7f016...d783`](https://celoscan.io/tx/0x02c7f01676d4ef18f0df44e0516e0ed3060bfc58dd1a7f109033c7bff75fd783) |
| **7** | `2026-10-26 22:02:13Z` | `cNGN/USDT` | `#9995 naira-maker` (`0x8754FE21...744B`) | `24,799.26 cNGN` | `18.0620 USDT` | Bought `24,800.16 cNGN` for `17.9880 USDT` ([`0x28d4e714...`](https://celoscan.io/tx/0x28d4e71468195aae4a1275a32dc935b2936e94864838267c3ecac3e8b436c6d5)) | **`+41.1 bps` (`+$0.0740`)** | [`0x51b95699...fca4`](https://celoscan.io/tx/0x51b956998cde49e9b799573de2775279081225b0ec3fe370710579616e45fca4) |
| **8** | `2026-10-26 21:58:18Z` | `cNGN/USDT` | `#9995 naira-maker` (`0x8754FE21...744B`) | `24,811.49 cNGN` | `18.0710 USDT` | Bought `24,799.26 cNGN` for `17.9880 USDT` ([`0x28269876...`](https://celoscan.io/tx/0x28269876309cf739400af88f4dde7ead65dc70057143fcaaee22b6f3ba5dc47a)) | **`+46.1 bps` (`+$0.0830`)** | [`0x83037bbe...0400`](https://celoscan.io/tx/0x83037bbef5572efa61bd60bccb9dd61130ccd88fa715b41ea1d0312541390400) |
| **9** | `2026-10-26 21:44:27Z` | `cNGN/USDT` | `#9995 naira-maker` (`0x8754FE21...744B`) | `19,357.15 cNGN` | `14.0981 USDT` | Bought `24,811.49 cNGN` for `18.0000 USDT` ([`0x9305ab7d...`](https://celoscan.io/tx/0x9305ab7dd6183dd1bf0c26dc5ecdbbe9fd0446f120b703d9fdbf0987cc0a6953)) | **`+41.0 bps` (`+$0.0578`)** | [`0xc3ef6878...6d88`](https://celoscan.io/tx/0xc3ef68789983862fb50a8a3b444572421275914db45464eb55bb45fa1d106d88) |
| **10** | `2026-10-26 09:32:54Z` | `cNGN/USDT` | `#9991 Kiyoshi` (`0x6Cd37bC2...fE7b`) | `110,627.23 cNGN` | `79.9949 USDT` | Institutional `$80` RFQ fill served by our Maker | **`+18.0 bps` Maker spread** | [`0x855d155c...a4a9`](https://celoscan.io/tx/0x855d155c063195460508b15364a841482041bf7c3e458ff47d2a3d33b859a4a9) |

### Key Takeaway from the Head-to-Head Matchup vs. `#9995 naira-maker` (`0x8754FE21...744B`):
- On Oct 26 at `21:29Z` and `21:42Z`, external bot `0x8754FE21...` lifted our `cNGN` quotes when Textile's oracle lagged Uniswap v3 by `~34 bps`.
- At `21:43Z`, we activated our **Dual-Oracle Comparison Shield (`effectiveSellMid = max(P_textile, P_uni)`)** and **Avellaneda-Stoikov Skew**.
- On the very next 3 fills (`21:44Z`, `21:58Z`, `22:02Z` — Fills #7, #8, #9), `0x8754FE21...` paid **`1,372.92 cNGN/USDT`** to our Maker while our autonomous treasury loop (`skew-desk.mjs`) immediately refilled the exact `cNGN` on Uniswap v3 (`0.01%` tier) at **`1,378.71 cNGN/USDT`**, locking in **`+41.1 bps` (`+$0.0740 USDT`) positive replenishment margin per fill** while restoring two-way corridor parity.

---

## 3. Verified Cross-Venue Arbitrages, Inventory Seeds & Treasury Unwinds (`cNGN`, `wARS`, `wBRL`, `USDC`, `CELO`)

| Timestamp (UTC) | Strategy | Corridor | External Counterparty | Leg 1 (Textile RFQ / Maker) | Leg 2 (Uniswap v3 `0.01%` / `0.30%`) | Net Realized Profit |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: |
| `2026-11-05 08:42 – 2026-11-08 19:01Z` | **431x Firm-Guarded Bidirectional Wave + `26` Maker Fills** | `wARS`, `wBRL`, `cNGN`, `USDC` | External Makers (`0x25A5c1Ae...`, `0xa601e4ad...`) & Takers (`0xd770...`, `#9991`) | `$58,275.52 USDT` 1-leg arb + `26` Maker fills (`$791.68`, incl. `$193.47` [`0xe0f685a5...`](https://celoscan.io/tx/0xe0f685a58f07ac76a07a1fc05e1b27a71cb560a3480eb45f6623dd1de5909786)) | Settled via `verifyFirmArbQuote` (`$135.10 USDT` in [`0x8c3811cc...`](https://celoscan.io/tx/0x8c3811ccac166c5577952f5bd830295bd5365529f8bd29c2b895f56e57f4b2fc)) | **`+$35.1000 USDT` liquid** |
| `2026-11-04 06:11 – 2026-11-05 08:42Z` | **77x Firm-Guarded Bidirectional Wave + `19` Maker Fills** | `wARS`, `wBRL`, `cNGN` | External Makers (`0x25A5c1Ae...`, `#9976 Arbolito`) & Taker `#9991` | `$9,660.02 USDT` 1-leg arb + `19` Maker fills (`$528.05`, e.g., [`0xfcedf7fe...`](https://celoscan.io/tx/0xfcedf7fe6e723b9aa00d1c445486b5d9bf8a353c2d27e4cc4687ad537d12799c)) | Settled via `verifyFirmArbQuote` (`$131.69 USDT` in [`0xa52c6b36...`](https://celoscan.io/tx/0xa52c6b3689e2e71a42f2e169d64281ceedff802acf00c7d277b8030c2418c3cc)) | **`+$2.9500 USDT`** |
| `2026-10-30 18:30 – 2026-11-04 06:00Z` | **596x Continuous Multi-Slice Wave (`1,192` txs)** | `wARS` & `cNGN` | Protocol Makers (`0x25A5c1Ae...`) & `#9976` | `$80,312.84 USDT` 1-leg across multi-slice RFQ sweeps + `93` new Maker fills (`$3,096.74`) | Unwound on Uniswap v3 `0.01%` (`0x5D8ef8B8...` & `0x6519d56E...`) + `$2.00` `CELO` gas top-up | **`+$26.6700 USDT`** |
| `2026-10-29 13:50 – 2026-10-30 18:30Z` | **422x Multi-Slice Arb Wave (`631` ERC-20 txs)** | `wARS` & `cNGN` | `#9929 Arbolito` (`0x25A5c1Ae...`) & `#9908 Naira Desk` (`0xa601e4ad...`) | `$37,279.91 USDT` 1-leg (`$113–$133` slices, e.g., [`0xd0855bf8...`](https://celoscan.io/tx/0xd0855bf83154261c63c9939e14164501aa9c3f1d74a15bc8f92a35cf215a4a1b), [`0xaa1dc87f...`](https://celoscan.io/tx/0xaa1dc87f1cc2d08f43393e3c3c09d97f5c79e904d28b51b7a796dc7c43c7a7c4)) | Unwound on Uniswap v3 `0.01%` (`0x5D8ef8B8...` & `0x6519d56E...`, e.g., [`0xb4a0071e...`](https://celoscan.io/tx/0xb4a0071e8b077e1297ec306b21a5b0855f0ef01d07a49bf90b6ca3bd2787425d)) | **`+$26.4076 USDT`** |
| `2026-10-28 00:00–14:07Z` | **159x Overnight & Morning Arb Wave (`318` txs)** | `wARS` & `cNGN` | External Makers (`0x25A5c1Ae...` & `#9976 Arbolito`) | `159 × $25 = $3,975.00 USDT` across `wARS` & `cNGN` (e.g., [`0x4f1af240...`](https://celoscan.io/tx/0x4f1af2402abcf14b20f2a14cefe5d6e5eed8b6d42295e5479b9c289be94987d2)) | Unwound on Uniswap v3 `0.01%` for `$3,977.1567 USDT` (e.g., [`0x52914841...`](https://celoscan.io/tx/0x52914841f98e67b7b5e3bb9f8b0b3cce53f7f52434fa63febde73e1e6b7800b0)) | **`+$2.1567 USDT`** |
| `2026-10-27 16:18–21:38Z` | **51x Evening Arb Wave (`102` txs)** | `wARS` & `cNGN` | External Makers (`0x25A5c1Ae...` & `#9976 Arbolito`) | `51 × $25 = $1,275.00 USDT` across `wARS` & `cNGN` (e.g., [`0xd0b8b1b8...`](https://celoscan.io/tx/0xd0b8b1b89de88be679f44d0fc26eb3d3632e1000816fb3e0f3f72a622e72bc5c)) | Unwound on Uniswap v3 `0.01%` for `$1,276.1045 USDT` (e.g., [`0x29276348...`](https://celoscan.io/tx/0x29276348989dc6b3c600b024c283e7ef78e0a153a466e0fa0eb3d66cc27bf948)) | **`+$1.1045 USDT`** |
| `2026-10-27 16:08:52Z` | **Textile RFQ Inventory Unwind** | `wBRL/USDT` | External Textile Maker (`0x25A5c1Ae...AB52`) | `159.0000 wBRL → 29.7407 USDT` ([`0x3329c8f6...`](https://celoscan.io/tx/0x3329c8f625f3314369f2066f7ed4518f0c5eb38a619f47aa5886979c58c77cd5)) | Bypassed `MAX_TICK` DEX pool (`17M gas`) via `197k gas` Textile RFQ unwind | **`+$29.74 USDT` liquid** |
| `2026-10-27 16:08:48Z` | **Autonomous Gas Reserve Top-Up** | `USDT/CELO` | Uniswap v3 Pool (`0.30%`) | `AUTO_GAS_REFILL` triggered at `0.0500 CELO` | `2.0000 USDT → 24.2248 CELO` ([`0xf63c6f1b...`](https://celoscan.io/tx/0xf63c6f1b9657fccccc327db8e2493fa872846f86262ca74013955a265c0f250c)) | **`+24.22 CELO` (`~900` txs)** |
| `2026-10-27 13:01–13:29Z` | **53x Cross-Venue Arb Blitz (`106` txs)** | `cNGN/USDT` | External Maker (`0x25A5c1Ae...AB52`) | `53 × $25 = $1,325.00 USDT → 1,838,448.34 cNGN` (e.g., [`0xe8b19d37...`](https://celoscan.io/tx/0xe8b19d37fda658805c695456c273b6b7f99c6e139fd9b0b6353df4f4764b80cf)) | `1,838,448.34 cNGN → $1,331.4390 USDT` (e.g., [`0xc9b92bcd...`](https://celoscan.io/tx/0xc9b92bcdb87d7890eaca9060c7e07d3b34feca9691cfb72e4f4642e70ac8deb1)) | **`+48.6 bps` avg (`+$6.4390 USDT`)** |
| `2026-10-27 08:33:14Z` | **Textile RFQ Inventory Seed** | `wBRL/USDT` | External Textile Maker (`0xF0d95682...8639`) | `10.0000 USDT → 53.8886 wBRL` ([`0xc1fef265...`](https://celoscan.io/tx/0xc1fef26595abdbaa9455129cdc24a8ef0f7e138a2f8874bdd39a2f83113bfa53)) | Held in active Maker reserve (`$10.13` mark-to-market) | **`+130.0 bps` (`+$0.1300` NAV)** |
| `2026-10-26 17:48:34Z` | **Cross-Venue Arb** | `wARS/USDT` | `#9976 Arbolito Desk` (`0xBCB8B7dc...EdbE`) | `10.5880 USDT → 17,719.29 wARS` ([`0xb202a9f1...`](https://celoscan.io/tx/0xb202a9f1e159b37f6b8f662652141903b293246a8810ebe7ae8dfabb9b1cc995)) | `17,719.29 wARS → 10.7866 USDT` ([`0x20da628c...`](https://celoscan.io/tx/0x20da628c6a545ea95a2e9268d587b1e63be758e4fd30f147ce668a628ced2cef)) | **`+187.5 bps` (`+$0.1986 USDT`)** |
| `2026-10-26 16:40:25Z` | **Maker → DEX Unwind** | `USDC/USDT` | External RFQ Taker | Maker received `10.9754 USDC` | `10.9754 USDC → 10.9887 USDT` ([`0x1e18cfab...`](https://celoscan.io/tx/0x1e18cfab4af41bd9d88c41f4814efd8439ea62b271aa5964c139f3a3d18d11d0)) | **`+12.1 bps` (`+$0.0133 USDT`)** |

---

## 4. Live Network Orderbook Share & Autonomous Risk Officer Guardrails

Our Stitch Maker (`cmv75ay6h00bq339u3x6gdicy`) and `skew-desk.mjs` autonomous treasury manager maintain active two-way coverage across all **4 official Textile corridors (`cNGN`, `wARS`, `wBRL`, `USDC` vs `USDT` — `8 of 8` directional sides)** via zero-restart `skew-policy.json` hot-reloading:

| Corridor | Token Contract | Uniswap v3 `0.01%` Pool | Snapshot Reserve (`$290.58` Liquid Equity) | Normalized Skew ($w = \$24$) | Quoting Coverage & Active Regime |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **`cNGN / USDT`** | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` | `0x6519d56Eb0A69FC0338657784c783B169b8f7d32` | `35,768 cNGN` (`$25.92`) + `194.58 USDT` | **`-0.038`** | **Continuous `1s` WS + Firm RFQ (`2/4 bps` · `DUAL_ORACLE_SHIELD`)** |
| **`wARS / USDT`** | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` | `0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391` | `42,917 wARS` (`$25.95`) + `194.58 USDT` | **`-0.039`** | **Continuous `1s` WS + Firm RFQ (`3/4 bps` · `DUAL_ORACLE_SHIELD`)** |
| **`wBRL / USDT`** | `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` | `0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F` | `134.36 wBRL` (`$24.13`) + `194.58 USDT` | **`-0.003`** | **Continuous `1s` WS + Firm RFQ (`4/3 bps` · `TWO_WAY_ACTIVE` + `800k` Gas Guard)** |
| **`USDC / USDT`** | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | `0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846` | `20.00 USDC` (`$20.00`) + `194.58 USDT` | **`+0.091`** | **Continuous `1s` WS + Firm RFQ (`1/2 bps` · `PEG_TIGHT_TWO_WAY`)** |

> **`wBRL/USDT` `MAX_TICK` (`887,271`) Gas-Griefing Protection + Textile RFQ Reserve Seed**:
> On Celo Mainnet, the `wBRL/USDT` `0.01%` Uniswap v3 pool (`0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F`) was drained to `slot0.tick = 887,271` (`MAX_TICK - 1`), causing any `USDT -> wBRL` DEX swap to traverse `2,350` empty `TickBitmap` words (`17,039,337 gas` = `~3.45 CELO` per swap). Our Risk Officer inspects `QuoterV2.quoteExactInputSingle`'s `gasEstimate`, autonomously blocks DEX swaps exceeding `800,000 gas`, and rebalances `wBRL` inventory via Textile's `LimitOrderReactor` (`~197k gas`, tx [`0xc1fef26595abdbaa9455129cdc24a8ef0f7e138a2f8874bdd39a2f83113bfa53`](https://celoscan.io/tx/0xc1fef26595abdbaa9455129cdc24a8ef0f7e138a2f8874bdd39a2f83113bfa53)).

---

## 5. Empirical Celo Mainnet Microstructure Benchmark (`LimitOrderReactor` `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`)

An on-chain audit of transactions executed against Textile's Celo Mainnet `LimitOrderReactor` demonstrates why **Skew (`#9905`)** is the only participant operating a profitable **Dual-Engine (4-Corridor Shielded Maker + Bounded AI & Multi-Slice Cross-Venue Taker)** architecture:

| Metric / Capability | Skew (`Agent #9905` · `0xe503...7324`) | Taker-Only Arbitrage Bots | Unshielded Off-Chain FX Makers |
| :--- | :--- | :--- | :--- |
| **Role on Textile FX** | **Dual-Engine: 4-Corridor Maker (`8/8` sides) + Cross-Venue Taker** | **Taker-Only (`0` Maker fills)** | **Maker + DEX Rebalancer** |
| **On-Chain Settlements (Celo `42220`)** | **`3,911` signed EOA txs (`9,996` ERC-20 transfers · `99.82%` reliability)** | Taker-only settlement legs | Maker-only fills & periodic DEX swaps |
| **Maker Liquidity & Fills Served** | **24/7 `1s` WS quotes + `179` external fills (`$6,527.97` Maker volume)** | **`0` Maker fills (`$0` liquidity provided)** | Exposed to cross-venue oracle lag |
| **Cross-Venue Arbitrage & Total Volume** | **`1,794` 2-leg arbs (`$193,344.64` 1-leg arb · `$207,057.11` total 1-leg · `$414,114.22` 2-leg · `$828,228.43` 2-way · `1,061.8x` turnover)** | Single-venue Taker sweeps | `0` Taker arbitrages |
| **Oracle-Lag & AI Defense** | **Hard `SELL >= max(P_textile, P_uni)` shield + EWMA/Markouts + Bounded Gemini 3.8 Flash (`2s` hot-reload)** | N/A (does not quote Maker orders) | Anchors to lagging off-chain FX feeds; exposed to DEX basis lag |
| **`wBRL` `MAX_TICK` (`887,271`) Handling** | **Blocked by `800k gas` `QuoterV2` guard; rebalances via `197k gas` Textile RFQ** | N/A | Rebalancer stalls or reverts on `0x01c3...A40F` (`17.04M gas`) |
| **Net Strategy Value & PnL** | **`$290.58` liquid stablecoins (`+$95.58 USDT` net liquid · `+49.02%` RoC) · `$296.43` total strategy value (`+$101.43` · `+52.02%` RoC)** | Positive Taker PnL, `$0` Maker PnL | Negative cross-venue basis drift when off-chain FX lags Uniswap v3 |
