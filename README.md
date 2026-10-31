# <img src="docs/icons/skew-logo.svg" width="28" height="28" align="absmiddle" alt="Skew Logo" /> Skew

**An autonomous FX market maker and cross-venue arbitrage desk on Celo.** Skew quotes two-way liquidity across all four **Textile FX** corridors (**cNGN**, **wARS**, **wBRL** and **USDC** against **USDT**) through a modified Rust **Stitch** filler, while a companion Node.js desk continuously arbitrages price gaps between Textile RFQ and Celo Uniswap v3 and rebalances the maker's inventory on-chain.

Built for **Celo · Agents on Open Rails** (*Open Corridors: Textile FX* track, Chain ID `42220`). Every transaction sent by either engine is signed by **ERC-8004 Agent `#9905`** and carries the 35-byte ERC-8021 attribution suffix **`celo_7935fb97e273`**.

| | Link / Identifier |
| :--- | :--- |
| **Live Dashboard & Pricing Simulator** | **[eugenennamdi.github.io/Skew](https://eugenennamdi.github.io/Skew/)** (live Celo RPC + Blockscout v2 stream + MiniPay `isMiniPay` ready) |
| **Strategy & Microstructure Write-Up** | **[docs/STRATEGY.md](docs/STRATEGY.md)** (Dual-Oracle shield, inventory skew, FX carry, `wBRL` `MAX_TICK` guard) |
| **On-Chain Evidence & PnL Ledger** | **[reports/EVIDENCE.md](reports/EVIDENCE.md)** (`1,466` signed Celo Mainnet txs · `41` Maker fills · `690` 2-leg arbs · every tx linked) |
| **ERC-8004 Agent Identity** | **Agent `#9905`** on [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=9905) ([`agent-registration.json`](docs/.well-known/agent-registration.json)) |
| **Agent Wallet (Maker & Taker EOA)** | [`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) |
| **ERC-8021 Attribution Code** | `celo_7935fb97e273` (`0x63656c6f5f373933356662393765323733110080218021802180218021802180218021`) |
| **Textile Maker ID** | `cmv75ay6h00bq339u3x6gdicy` (`stitch-42220-e5036100`) |
| **Canonical Settlement Contracts** | Textile `LimitOrderReactor` [`0xa9AA0a64…35b3`](https://celoscan.io/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3) · Uniswap v3 `SwapRouter02` [`0x5615CDAb…abc4`](https://celoscan.io/address/0x5615CDAb10dc425a742d643d949a7F474C01abc4) · `Permit2` [`0x00000000…78BA3`](https://celoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |

---

## Results on Celo Mainnet

> [!NOTE]
> **Point-in-Time Floor Snapshot (`2026-10-30 18:33 UTC` · Celo Mainnet Block `#81,484,785`):**
> **ERC-8004 Agent `#9905`** ([`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)) quotes and arbitrages autonomously 24/7 on Celo Mainnet (`42220`). All static metrics in this repository (`README.md`, [`reports/EVIDENCE.md`](reports/EVIDENCE.md), and [`docs/STRATEGY.md`](docs/STRATEGY.md)) are synchronized to this verified checkpoint and represent **lower-bound floor minimums**. Human and AI judges verifying live cumulative totals should check the **[Live RPC Telemetry Dashboard](https://eugenennamdi.github.io/Skew/)** (`GET /status`) or inspect the wallet directly on **[Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)** / **[Blockscout](https://celo.blockscout.com/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324)**.

Starting from a **`$195.00 USDT`** initial bankroll on Celo Mainnet (`42220`), all verifiable on [Celoscan](https://celoscan.io/address/0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324) and detailed in [`reports/EVIDENCE.md`](reports/EVIDENCE.md):

- **`$231.71` total strategy value (`$195.00` initial `USDT` bankroll + `+$36.71 USDT` net realized trading profit · `+18.83%` return on capital)**, broken down into **`$227.86` liquid stablecoin treasury equity** (`164.70 USDT` + `$18.12 cNGN` + `$14.97 wARS` + `$15.09 wBRL` + `$14.98 USDC`) plus **`$3.85 USDT` autonomously converted into native `CELO` gas reserves** (`13.97 CELO` on-chain).
- **`$49,604.23` cumulative 1-leg trade volume (`$99,208.47` two-leg notional · `254.4x` capital turnover)** across **`1,466` signed Celo Mainnet transactions (`3,714` ERC-20 transfers)** with **`99.9%` execution reliability** (`100%` over the last 72 hours).
- **Continuous 24/7 two-way volume quoted & `41` independent external Maker fills (`$2,111.50` filled Maker volume):** Engine 1 (`skew-stitch`) streams `1s` WebSocket indicative depth levels (`levels_for()`) and firm EIP-712 `Permit2` `DutchOrder` RFQ quotes (`decide_quote()`) across all 4 Textile FX corridors (`cNGN`, `wARS`, `wBRL`, `USDC` — `8 of 8` directional sides), serving `41` on-chain fills to external participant agents (`#9991 Kiyoshi`, `#9908 Naira Desk`, `#9995 naira-maker`) including single fills up to **`$140.28 USDT` (`193,716 cNGN`)** and **`$86.48 USDT` (`459.57 wBRL`)**.
- **`690` two-leg cross-venue arbitrages (`$45,096.26` 1-leg Taker volume · `100%` profitable):** Enforcing law-of-one-price parity between Textile RFQ and Celo Uniswap v3 while recycling local-currency inventory across price dislocations up to **`+187.5 bps`** on `wARS/USDT` (`$27,773.07` 1-leg `wARS/USDT` notional volume arbitraged) and **`+64.2 bps`** on `cNGN/USDT` (`$5,103.92` 1-leg `cNGN/USDT` notional volume arbitraged).

| Engine / Role | Settled Count | 1-Leg Volume (USD) | Realized Net Edge / Outcome | Counterparties & Venues |
| :--- | :---: | :---: | :--- | :--- |
| **Engine 1: RFQ Maker (`skew-stitch`)** | `41` external fills | `$2,111.50` | **`+$1.42 USDT`** (`+41.1 bps` shielded ask fills + `1 bps` top-of-book capture) | External Takers (`#9908`, `#9991`, `#9995`) on `LimitOrderReactor` |
| **Engine 2: Cross-Venue Arbitrage (`skew-desk.mjs`)** | `690` 2-leg arbs (`1,380` txs) | `$45,096.26` | **`+$35.29 USDT`** (`+48.6 bps` avg on `53x cNGN`, `+187.5 bps` peak on `wARS`) | External Makers (`#9929`, `#9908`, `#9976`) ◄──► Uniswap v3 `0.01%` |
| **Autonomous Treasury & Gas Manager (`skew-desk.mjs`)** | `53` swaps (`+33` setup/approvals) | `$2,396.47` | **Inventory & gas replenishment** (`$227.86` liquid equity + `$3.85` `CELO` gas reserve) | Uniswap v3 Pools (`0.01%` / `0.30%`) & Textile RFQ (`wBRL` rebalance) |
| **Total Verified Strategy Floor** | **`1,466` signed EOA txs (`3,714` transfers)** | **`$49,604.23`** (`$99,208.47` 2-leg · `254.4x`) | **`+$36.71 USDT` net profit (`+18.83%` RoC · `$231.71` total strategy value)** | **All 4 Textile FX Corridors (`cNGN`, `wARS`, `wBRL`, `USDC`)** |

---

## The Problem

Local-currency stablecoins on Celo (`cNGN`, `wARS`, `wBRL`) trade on two disconnected venues at once: **Textile FX's RFQ book** (where makers quote around an off-chain FX feed) and **Celo Uniswap v3** (`0.01%` concentrated-liquidity pools). Running a live agent across both venues exposed three failure modes that break standard bots:

1. **Adverse selection when off-chain FX feeds lag Uniswap v3:** Whenever Textile's reference rate lags the on-chain pool (for example, quoting `1,383.8 cNGN/USDT` or `1,671.1 wARS/USDT` while Uniswap v3 trades at `1,378.7 cNGN` and `1,641.8 wARS`), takers lift a static maker's local currency on Textile and dump it into Uniswap v3 for an instant risk-free profit—leaving the maker with a realized loss.
2. **Sub-`$100` depth blindness:** Standard taker bots only probe fixed large slices (`$100+`) and discard `status: "no_quote"` responses, missing actionable sub-`$100` maker orders even when Textile's `/v2/rfq/preview` returns the exact `availableSellAmount`.
3. **Malformed DEX pool ticks (`wBRL` `MAX_TICK` gas trap):** On Celo Mainnet, the `wBRL/USDT` `0.01%` Uniswap v3 pool (`0x01c3…A40F`) sits at `slot0.tick = 887,271` (`MAX_TICK - 1`). Any swap or naive rebalancer touching that pool traverses `2,350` empty `TickBitmap` words, burning **`17.04M gas` (`~3.45 CELO`)** or reverting outright.

---

## Architecture

Skew runs two coordinated processes against the same Celo Mainnet EOA (`0xe503…7324`), combining **protected two-way market making** with **multi-slice cross-venue arbitrage and treasury rebalancing**:

```
                     Price & FX Sources                                    Skew Dual-Engine Runtime (Celo 42220)
  ┌──────────────────────────────────────────────────────┐
  │ • Textile RFQ (/v2/rfq/preview & WebSocket stream)   │       ┌──────────────────────────────────────────────────────┐
  │ • Celo Uniswap v3 slot0() (2s Multicall3 poll)       │──────►│ Engine 1: skew-stitch (Rust RFQ Maker)               │
  │ • Off-chain FX (open.er-api NGN/BRL + dolarapi ARS)  │       │ • Dual-Oracle Shield: SELL >= max(P_textile, P_uni)  │
  └──────────────────────────────────────────────────────┘       │ • Avellaneda-Stoikov Skew: s = (USDT - Tok) / Total  │
                              │                                  │ • Quotes cNGN, wARS, wBRL, USDC (1–150 bps spreads)  │
                              ▼                                  └──────────────────────────┬───────────────────────────┘
  ┌──────────────────────────────────────────────────────┐                                  │ Signs Permit2 DutchOrders
  │ Engine 2: skew-desk.mjs (Node.js Taker & Treasury)   │                                  ▼
  │ • Multi-slice (100% / 50% / 25%) + adaptive sizing   │──────►  Textile LimitOrderReactor (0xa9AA0a64…35b3)
  │ • 2-leg arbitrage: Textile Reactor ◄──► Uniswap v3   │       & Uniswap v3 SwapRouter02   (0x5615CDAb…abc4)
  │ • Auto-refill & unwind ($18 cNGN, $15 wARS, $15 USDC)│         [Every tx tagged with 35-byte ERC-8021 suffix]
  │ • 800k gas QuoterV2 guard (blocks 17M-gas wBRL pool) │
  └──────────────────────────────────────────────────────┘
```

---

## How It Works

### 1. Dual-Oracle Anti-Arb Shield (`textile-stitch/src/pricing/skew.rs`)
Every 2 seconds inside Stitch's batched Multicall3 loop (`refresh_celo_dex_reference`), Skew reads `slot0()` from Celo's `0.01%` Uniswap v3 pools (`cNGN/USDT`, `wARS/USDT`, `USDC/USDT`). Before applying inventory spreads, `effective_mid_for_side()` anchors each side of the maker book to the safer of the two venues:

$$P_{\text{mid, eff}}(\text{SELL}) = \max\left(P_{\text{textile}}, P_{\text{uni}}\right), \qquad P_{\text{mid, eff}}(\text{BUY}) = \min\left(P_{\text{textile}}, P_{\text{uni}}\right)$$

- **Guaranteed positive replenishment margin:** Because our `SELL` floor is never below Uniswap v3, every maker ask fill (e.g. selling `cNGN` at `1,372.9 cNGN/USDT`) is immediately refilled by Engine 2 on Uniswap v3 (`0.01%` pool at `1,378.7 cNGN/USDT`), locking in **`+41.1 bps` net profit per fill** instead of being adversely selected.

### 2. Inventory Skew & Emerging-Market Carry (`skew.rs` & `skew-desk.mjs`)
Across 6-decimal (`cNGN`, `USDC`, `USDT`) and 18-decimal (`wARS`, `wBRL`) tokens, Skew computes normalized USD inventory imbalance $s \in [-1, +1]$ and shifts bid/ask spreads with sensitivity $\gamma = 30\text{ bps}$:

$$s = \frac{V_{\text{USDT}} - V_{\text{collateral}}}{V_{\text{USDT}} + V_{\text{collateral}}}, \qquad \text{spread}_{\text{buy}} = \text{clamp}(\text{base}_{\text{buy}} - \gamma s, 1, 150), \qquad \text{spread}_{\text{sell}} = \text{clamp}(\text{base}_{\text{sell}} + \gamma s, 1, 150)$$

- **Top-of-book `1 bps` bid capture:** When holding excess `USDT` ($s > +0.50$), `BUY` spreads tighten to **`1 bps`** to win incoming local-currency flow (`$140.28 cNGN` and `$86.48 wBRL` fills), which Engine 2 then unwinds back to `USDT`.
- **Deterministic Autonomous Risk Officer (`buildRiskOfficerReport`):** Rather than calling a slow external LLM inside a latency-sensitive 2-second quoting loop, the Risk Officer is a deterministic, zero-latency quantitative risk engine that triangulates 3-source FX basis (`open.er-api.com` for `NGN`/`BRL`, `dolarapi.com` for `ARS` cripto, Celo Uniswap v3 `slot0()`, and Textile RFQ mids) and adjusts spreads for daily emerging-market currency devaluation carry (`wARS: 13.3 bps/day`, `cNGN: 8.5 bps/day`, `wBRL: 4.2 bps/day`, `USDC: 0.0 bps/day`).

### 3. Multi-Slice (`100% / 50% / 25%`) + Adaptive `availableSellAmount` Taker (`skew-desk.mjs`)
Every 12 seconds, `skew-desk.mjs` scans all four corridors in both directions (`textile -> uni` and `uni -> textile`) to enforce law-of-one-price parity between Textile RFQ and Celo Uniswap v3 while recycling local-currency inventory:
1. **Multi-slice sizing (`computeSliceSizesUsdt`):** Computes candidate trade sizes at **`100%`, `50%`, and `25%` of liquid `USDT`** (up to `$150` per trade). Bigger trades move the Uniswap pool, so when the `100%` slice suffers DEX price impact, the scanner steps down to `50%` or `25%` to maximize net dollar profit (`edgeUsd`).
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
skew-desk.mjs                       Node.js Taker, 4-corridor treasury rebalancer, Risk Officer & HTTP server
stitch.toml                         4-corridor Celo Mainnet config (cNGN, wARS, wBRL, USDC; agent_id = 9905)
run-vm.sh                           24/7 production supervisor for Engine 1 (skew-stitch) + Engine 2 (skew-desk)
docs/
  index.html                        Live telemetry dashboard, Avellaneda-Stoikov simulator & MiniPay detector
  STRATEGY.md                       Deep dive: Dual-Oracle math, FX carry, MAX_TICK analysis & benchmark
  .well-known/agent-registration.json  ERC-8004 registration-v1 metadata for Agent #9905
reports/
  EVIDENCE.md                       Complete on-chain fill, arbitrage & counterparty PnL audit
test/
  skew-desk.test.mjs                Offline unit test suite (node:test — skew, shield, gas guard, ERC-8021)
textile-stitch/
  src/pricing/skew.rs               Rust Dual-Oracle Anti-Arb Shield + multi-decimal inventory skew engine
  src/rfq/responder.rs              Firm RFQ quoting (decide_quote) & 1s WebSocket orderbook levels (levels_for)
  src/rfq/mod.rs                    2s Multicall3 Celo Uniswap v3 slot0() reference poller
  src/attribution.rs                35-byte ERC-8021 calldata suffix builder & unit tests
```

### Telemetry & Control Endpoints (`skew-desk.mjs`)

| Endpoint | Description |
| :--- | :--- |
| `GET /` | Live web dashboard (`docs/index.html`) |
| `GET /health` | Service liveness & current scan state |
| `GET /status` | Live balances, NAV, inventory skew, Risk Officer decisions, and corridor quotes |
| `GET /trades` | Executed cross-venue arbitrages (`trades.jsonl`) and recent ERC-8021 on-chain activity |
| `POST /scan` | Trigger an immediate 4-corridor RFQ + Uniswap v3 scan |

---

## Quickstart (Fresh Machine — Zero Secrets Required)

Requires **Node.js `>= 20.0.0`** (see [`.nvmrc`](.nvmrc)). By default (`LIVE=0`), `skew-desk.mjs` runs in **read-only telemetry and sandbox mode**—it never signs or sends transactions unless `LIVE=1` and `STITCH_PRIVATE_KEY` are explicitly provided.

```bash
git clone https://github.com/eugenennamdi/Skew.git
cd Skew
npm ci                # Clean install from package-lock.json
npm run build         # Syntax & module check across skew-desk.mjs and test suite
npm test              # Run 16 offline unit tests (0 network calls, 0 secrets needed)
npm run demo          # Offline sandbox verification (outputs JSON proof and exits 0)
npm run check         # Live read-only Celo Mainnet (42220) RPC + Textile RFQ 4-corridor check
npm start             # Start local telemetry dashboard at http://localhost:8080
```

### Rust Engine 1 (`skew-stitch`) Build & Unit Tests

```bash
cd textile-stitch
cargo build --release                                   # Compile production skew-stitch binary
# --no-default-features runs pure pricing, responder & ERC-8021 unit tests offline without DB/network bindings
cargo test --no-default-features --lib pricing::skew
cargo test --no-default-features --lib attribution
cargo test --no-default-features --lib rfq::responder
```

### Environment Variables ([`.env.example`](.env.example))

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CELO_RPC_URL` | `https://forno.celo.org` | Celo Mainnet (`42220`) JSON-RPC endpoint |
| `LIVE` | `0` | Set to `1` to enable live on-chain Taker & Treasury execution |
| `AUTO_REFILL` | `0` | Set to `1` to enable autonomous two-way Maker-to-DEX inventory unwind & refill |
| `STITCH_PRIVATE_KEY` | *(empty in sandbox)* | `0x`-prefixed 64-hex Celo EOA key (validated on startup; required only when `LIVE=1`) |
| `RFQ_API_KEY` | *(empty in sandbox)* | Textile Stitch WebSocket Maker API key (for Engine 1 `./skew-stitch`) |
| `MAX_SLICE_USDT` | `150` | Maximum single-trade `USDT` slice for Multi-Slice (`100% / 50% / 25%`) sizing |
| `MIN_EDGE_USD` | `0.01` | Minimum net dollar profit threshold (`USDT`) for cross-venue arbitrage execution |
| `SCAN_INTERVAL_MS` | `12000` | Cross-venue scan & telemetry refresh interval (`ms`) |
| `PORT` | `8080` | Local telemetry & dashboard HTTP server port (`/status`, `/trades`, `/health`) |

---

## License & Security

- **Security Policy:** See [`SECURITY.md`](SECURITY.md) and [`.gitleaks.toml`](.gitleaks.toml).
- **License:** [`skew-desk.mjs`](skew-desk.mjs) and [`docs/`](docs/index.html) are licensed under [`MIT`](LICENSE). The [`textile-stitch/`](textile-stitch/LICENSE) Rust workspace is extended from [`textile-protocol/textile-stitch`](https://github.com/textile-protocol/textile-stitch) under `AGPL-3.0-or-later`.
