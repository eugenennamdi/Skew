# Security Policy & Architecture

## Credential & Key Isolation

- **Zero Committed Secrets**: No private keys, API keys, mnemonics, or `.pem` files are committed to this repository. Secret files (`*.key`, `*.pem`, `*.env`, `stitch.env`, `rfq-api.key`) are blocked by `.gitignore` and verified by `.gitleaks.toml`.
- **Zero-Secret Sandbox Mode**: By default (`LIVE=0` and no `STITCH_PRIVATE_KEY` set), `skew-desk.mjs` operates in read-only telemetry and simulation mode (`npm start`, `npm test`, `npm run check`) with zero signing capability.
- **Least-Privilege Runtime Key Loading**: On production nodes, `STITCH_PRIVATE_KEY` and `rfq-api.key` are read strictly from `0600` permissioned environment files or environment variables.

## On-Chain Execution Guardrails

1. **Dual-Oracle Comparison Shield (`max/min` Reference Anchor)**:
   - `SELL` quotes (`bid = false`) anchor to `max(P_textile, P_uniswap_v3)` so external takers can never sweep Maker reserves below the live Celo Uniswap v3 replacement cost.
   - `BUY` quotes (`bid = true`) anchor to `min(P_textile, P_uniswap_v3)`.
2. **`MAX_TICK` Gas-Griefing Protection (`800,000` gas ceiling)**:
   - Every Uniswap v3 quote via `QuoterV2.quoteExactInputSingle` inspects `gasEstimate` before execution and blocks pools whose `TickBitmap` traversal exceeds `800,000 gas` (e.g., `wBRL/USDT` at `slot0.tick = 887,271` requiring `17.04M gas`).
3. **Anti-Self-Trade Calldata Verification (`isSelfMakerOrder`)**:
   - Before submitting any `LimitOrderReactor` transaction (`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`), the Taker inspects ABI-encoded `OrderInfo.swapper` words and aborts if the matched Maker equals our own wallet (`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`).
4. **Canonical Contract Whitelisting**:
   - Transaction targets are strictly restricted to verified Celo Mainnet (`42220`) contracts: Textile `LimitOrderReactor`, Uniswap `SwapRouter02`, `Permit2`, ERC-8004 `IdentityRegistry`, and the 4 track ERC-20 tokens (`cNGN`, `wARS`, `wBRL`, `USDC`, `USDT`).
