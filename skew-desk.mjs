#!/usr/bin/env node
/**
 * Skew v2 — Autonomous Cross-Venue Arbitrage, Auto-Hedge & Telemetry Desk
 * Agent ID #9905 (ERC-8004) | Attribution: celo_7935fb97e273 (ERC-8021)
 * Wallet: 0xe5036100b4a32b83d5e1997d403ce64a4c7f7324 | Chain: Celo Mainnet (42220)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  OFFCHAIN_FX_DEFAULTS,
  computeSkewAndQuotes,
  computeSliceSizesUsdt,
  computeRegionalBankingSession,
  updateCorridorQuantState,
  evaluateMarkoutAdjustments,
  clampLlmCorridorDecision,
  buildGeminiSupervisorPrompt,
  runGeminiRiskSupervisor,
  computeRiskOfficerDecisions,
  buildRiskOfficerReport,
  syncStitchRuntimePolicy,
  syncStitchRuntimeConfig,
} from './src/risk-policy.mjs';
import { createExecutionManager } from './src/execution.mjs';

export {
  OFFCHAIN_FX_DEFAULTS,
  computeSkewAndQuotes,
  computeSliceSizesUsdt,
  computeRegionalBankingSession,
  updateCorridorQuantState,
  evaluateMarkoutAdjustments,
  clampLlmCorridorDecision,
  buildGeminiSupervisorPrompt,
  runGeminiRiskSupervisor,
  computeRiskOfficerDecisions,
  buildRiskOfficerReport,
  syncStitchRuntimePolicy,
  syncStitchRuntimeConfig,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Automatically load .env and textile-stitch/stitch.env if present (ignoring blank/placeholder values)
for (const relEnv of ['.env', path.join('textile-stitch', 'stitch.env')]) {
  const envPath = path.join(__dirname, relEnv);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const rawRhs = m[2].trim();
      const val = (/^["']/.test(rawRhs)
        ? rawRhs.replace(/^["']|["']\s*(?:#.*)?$/g, '')
        : rawRhs.replace(/\s+#.*$/, '')
      ).trim();
      if (!val || val === '0x' + '00'.repeat(32)) continue;
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const addr = (a) => ethers.getAddress(a.toLowerCase());

export const CONFIG = {
  chainId: 42220,
  rpcUrl: process.env.CELO_RPC_URL || 'https://forno.celo.org',
  textileApi: 'https://api.textilecredit.com',
  agentWallet: addr('0xe5036100b4a32b83d5e1997d403ce64a4c7f7324'),
  agentId: 9905,
  makerId: 'cmv75ay6h00bq339u3x6gdicy',
  attributionTag: 'celo_7935fb97e273',
  // Exact 35-byte ERC-8021 suffix matching textile-stitch/src/attribution.rs
  erc8021SuffixHex: '63656c6f5f373933356662393765323733110080218021802180218021802180218021',
  contracts: {
    usdt: addr('0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'),
    celo: addr('0x471EcE3750Da237f93B8E339c536989b8978a438'),
    reactor: addr('0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3'),
    permit2: addr('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
    uniQuoterV2: addr('0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'),
    uniSwapRouter02: addr('0x5615CDAb10dc425a742d643d949a7F474C01abc4'),
    erc8004Registry: addr('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'),
    cngnUsdtPool: addr('0x6519d56Eb0A69FC0338657784c783B169b8f7d32'),
    warsUsdtPool: addr('0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391'),
  },
  // Active Textile FX corridors (cNGN, wARS, wBRL, USDC + optional USAT when ENABLE_USAT=1)
  tokens: [
    { symbol: 'cNGN', address: addr('0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f'), decimals: 6, probeUsdt: 400, fxCode: 'NGN', dailyCarryBps: 8.5 },
    { symbol: 'wARS', address: addr('0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D'), decimals: 18, probeUsdt: 400, fxCode: 'ARS', dailyCarryBps: 13.3 },
    { symbol: 'wBRL', address: addr('0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0'), decimals: 18, probeUsdt: 400, fxCode: 'BRL', dailyCarryBps: 4.2 },
    { symbol: 'USDC', address: addr('0xcebA9300f2b948710d2653dD7B07f33A8B32118C'), decimals: 6, probeUsdt: 400, fxCode: 'USD', dailyCarryBps: 0.0 },
    ...(process.env.ENABLE_USAT === '1'
      ? [{ symbol: 'USAT', address: addr('0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771'), decimals: 6, probeUsdt: 400, fxCode: 'USD', dailyCarryBps: 0.0 }]
      : []),
  ],
  maxSliceUsdt: Number(process.env.MAX_SLICE_USDT || '400'),
  sliceFractions: [1.0, 0.75, 0.5, 0.35, 0.2],
  legacyUnwindTokens: [
    { symbol: 'WETH', address: addr('0xD221812de1BD094f35587EE8E174B07B6167D9Af'), decimals: 18 },
  ],
  feeTiers: [100, 500, 3000, 10000],
  minEdgeUsd: Math.max(0.005, Number(process.env.MIN_EDGE_USD || '0.012')),
  minEdgeBps: Number(process.env.MIN_EDGE_BPS || '0.55'),
  minFirmNetEdgeUsd: Number(process.env.MIN_FIRM_NET_EDGE_USD || '0.010'),
  minFirmNetEdgeBps: Number(process.env.MIN_FIRM_NET_EDGE_BPS || '0.45'),
  // Positive-EV floor for cash-first uni->textile (avoids -3 bps DEX flatten bleed when Makers reprice during Leg 2)
  minUniToTextileDexFirstBps: Number(process.env.MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS || '2.5'),
  minUniToTextileDexFirstUsd: Number(process.env.MIN_UNI_TO_TEXTILE_DEX_FIRST_USD || '0.045'),
  estimatedArbGasUsd: Number(process.env.EST_ARB_GAS_USD || '0.003'),
  maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || '1.00'),
  maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES || '2'),
  maxSingleTradeLossUsd: Number(process.env.MAX_SINGLE_TRADE_LOSS_USD || '0.35'),
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS || '3500'),
  chaseIntervalMs: Number(process.env.CHASE_INTERVAL_MS || '1000'),
  maxChaseIterations: Number(process.env.MAX_CHASE_ITERATIONS || '8'),
  llmIntervalMs: Number(process.env.LLM_INTERVAL_MS || '600000'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  targetCorridorUsd: Number(process.env.TARGET_CORRIDOR_USD || '5'),
  enableErc8021Tag: process.env.ENABLE_ERC8021_TAG !== '0',
  bindHost: process.env.BIND_HOST || '127.0.0.1',
  dashboardToken: process.env.DASHBOARD_TOKEN || '',
  port: Number(process.env.PORT || '8080'),
  liveTrading: process.env.LIVE === '1',
  tradesLogPath: path.join(__dirname, 'trades.jsonl'),
  policyFilePath: process.env.SKEW_POLICY_FILE || path.join(__dirname, 'skew-policy.json'),
  llmLogPath: path.join(__dirname, 'llm-decisions.jsonl'),
  markoutsLogPath: path.join(__dirname, 'markouts.jsonl'),
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const POOL_ABI = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) view returns (uint256 amountOut, uint160, uint32, uint256)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

/**
 * Append ERC-8021 attribution suffix (`celo_7935fb97e273`) to transaction calldata.
 */
export function appendErc8021Suffix(calldataHex = '0x') {
  const clean = calldataHex.startsWith('0x') ? calldataHex.slice(2) : calldataHex;
  if (clean.toLowerCase().endsWith(CONFIG.erc8021SuffixHex)) {
    return '0x' + clean;
  }
  return '0x' + clean + CONFIG.erc8021SuffixHex;
}

/**
 * Validate optional operator private key format (0x-prefixed 64-character hex string).
 * Returns null in read-only / telemetry mode when no private key is supplied.
 */
export function validatePrivateKey(rawKey = '') {
  const clean = String(rawKey || '').trim();
  if (!clean) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('Invalid STITCH_PRIVATE_KEY format: expected 0x-prefixed 64-character hex string');
  }
  return clean;
}

/**
 * Anti-Self-Trade Calldata Guard (`isSelfMakerOrder`):
 * Inspects the ABI-encoded `OrderInfo` struct (`reactor` word immediately followed by `swapper` word)
 * inside `LimitOrderReactor` (`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`) fill calldata (`execute` /
 * `executeBatch` / `executeWithCallback`). Rejects any Taker quote whose Maker signer is Skew's own wallet
 * (`0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324`), guaranteeing 0 self-trades on-chain.
 */
export function isSelfMakerOrder(calldata = '') {
  const reactorWord = '000000000000000000000000' + CONFIG.contracts.reactor.slice(2).toLowerCase();
  const ourWord = '000000000000000000000000' + CONFIG.agentWallet.slice(2).toLowerCase();
  return calldata.toLowerCase().includes(reactorWord + ourWord);
}

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

export function sumReceiptTokenTransfers(receipt, tokenAddr, { fromAddr = null, toAddr = null } = {}) {
  if (!receipt?.logs) return 0n;
  const tok = tokenAddr.toLowerCase();
  const fromWord = fromAddr ? '0x' + fromAddr.slice(2).toLowerCase().padStart(64, '0') : null;
  const toWord = toAddr ? '0x' + toAddr.slice(2).toLowerCase().padStart(64, '0') : null;
  let total = 0n;
  for (const log of receipt.logs) {
    if ((log.address || '').toLowerCase() !== tok) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    if (fromWord && log.topics[1].toLowerCase() !== fromWord) continue;
    if (toWord && log.topics[2].toLowerCase() !== toWord) continue;
    total += BigInt(log.data || '0x0');
  }
  return total;
}

/**
 * Pre-flight profitability gate on the signed firm Textile quote (`q.quote.buyAmount`) vs live Uniswap v3 exit.
 * Aborts BEFORE Leg 1 (0 gas spent) whenever preview-to-firm slippage makes the round-trip unprofitable after gas.
 */
export function verifyFirmArbQuote({
  inUsdt,
  firmOutUsdt,
  estimatedGasUsd = CONFIG.estimatedArbGasUsd,
  minNetEdgeUsd = CONFIG.minFirmNetEdgeUsd,
  minNetEdgeBps = CONFIG.minFirmNetEdgeBps,
}) {
  const grossEdgeUsd = Number(firmOutUsdt) - Number(inUsdt);
  const netEdgeUsd = grossEdgeUsd - Number(estimatedGasUsd);
  const grossEdgeBps = inUsdt > 0 ? (grossEdgeUsd / inUsdt) * 10000 : -9999;
  const netEdgeBps = inUsdt > 0 ? (netEdgeUsd / inUsdt) * 10000 : -9999;
  if (!(inUsdt > 0) || !(firmOutUsdt > inUsdt)) {
    return { ok: false, grossEdgeUsd, netEdgeUsd, grossEdgeBps, netEdgeBps, reason: 'firm_quote_underwater' };
  }
  if (netEdgeUsd < minNetEdgeUsd) {
    return { ok: false, grossEdgeUsd, netEdgeUsd, grossEdgeBps, netEdgeBps, reason: 'below_min_net_usd' };
  }
  if (netEdgeBps < minNetEdgeBps) {
    return { ok: false, grossEdgeUsd, netEdgeUsd, grossEdgeBps, netEdgeBps, reason: 'below_min_net_bps' };
  }
  return { ok: true, grossEdgeUsd, netEdgeUsd, grossEdgeBps, netEdgeBps, reason: 'pass' };
}

let cachedOffChainFx = { ...OFFCHAIN_FX_DEFAULTS, fetchedAt: 0 };

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOffChainFxRates() {
  if (Date.now() - cachedOffChainFx.fetchedAt < 300_000) return cachedOffChainFx;
  try {
    const [erRes, arsCriptoRes, arsOficialRes] = await Promise.all([
      fetchJson('https://open.er-api.com/v6/latest/USD', { timeoutMs: 3500 }).catch(() => null),
      fetchJson('https://dolarapi.com/v1/dolares/cripto', { timeoutMs: 3500 }).catch(() => null),
      fetchJson('https://dolarapi.com/v1/dolares/oficial', { timeoutMs: 3500 }).catch(() => null),
    ]);
    const rates = erRes?.rates || {};
    const arsMid = arsCriptoRes?.compra && arsCriptoRes?.venta
      ? (Number(arsCriptoRes.compra) + Number(arsCriptoRes.venta)) / 2
      : Number(rates.ARS || OFFCHAIN_FX_DEFAULTS.ARS);
    const arsOfficial = arsOficialRes?.compra && arsOficialRes?.venta
      ? (Number(arsOficialRes.compra) + Number(arsOficialRes.venta)) / 2
      : Number(rates.ARS || OFFCHAIN_FX_DEFAULTS.ARS_OFFICIAL);
    const arsParallelSpreadBps = arsOfficial > 0
      ? Number((((arsMid - arsOfficial) / arsOfficial) * 10000).toFixed(1))
      : OFFCHAIN_FX_DEFAULTS.ARS_PARALLEL_SPREAD_BPS;
    cachedOffChainFx = {
      NGN: Number(rates.NGN || OFFCHAIN_FX_DEFAULTS.NGN),
      ARS: arsMid,
      ARS_OFFICIAL: arsOfficial,
      ARS_PARALLEL_SPREAD_BPS: arsParallelSpreadBps,
      BRL: Number(rates.BRL || OFFCHAIN_FX_DEFAULTS.BRL),
      USD: 1.0,
      source: erRes?.rates ? 'open.er-api.com + dolarapi.com (cripto & oficial live)' : OFFCHAIN_FX_DEFAULTS.source,
      fetchedAt: Date.now(),
    };
  } catch {
    // Keep deterministic fallback if offline or rate-limited
  }
  return cachedOffChainFx;
}

export async function fetchTextileCorridorPrices(fetchImpl = fetch) {
  const pairs = [
    ['cNGN', 'cngn-usdt&corridor=cmtcq1gbl0003ykyl5n2laol9'],
    ['wARS', 'wars-usdt'],
    ['wBRL', 'wbrl-usdt'],
    ['USDC', 'usdc-usdt'],
    ...(CONFIG.tokens.some((t) => t.symbol === 'USAT') ? [['USAT', 'usat-usdt']] : []),
  ];
  const out = {};
  await Promise.all(
    pairs.map(async ([sym, query]) => {
      try {
        const r = await fetchImpl(`${CONFIG.textileApi}/price?chainId=${CONFIG.chainId}&pair=${query}`, {
          signal: AbortSignal.timeout(3500),
        });
        if (!r.ok) return;
        const j = await r.json();
        const p = Number(j?.price || j?.data?.price || 0);
        if (Number.isFinite(p) && p > 0) out[sym] = p;
      } catch {
        // Fallback handled by caller
      }
    })
  );
  return out;
}

const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
const quoter = new ethers.Contract(CONFIG.contracts.uniQuoterV2, QUOTER_ABI, provider);
const routerIface = new ethers.Interface(ROUTER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

const privKey = validatePrivateKey(process.env.STITCH_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || '');
const wallet = privKey ? new ethers.Wallet(privKey, provider) : null;

const SET_AGENT_URI_SELECTOR = ethers.id('setAgentURI(uint256,string)').slice(0, 10).toLowerCase();
const REACTOR_ALLOWED_SELECTORS = new Set(['0x3f62192e', '0x0d7a16c3']); // execute, executeBatch

/**
 * Outbound Transaction Firewall:
 * Enforces zero native CELO transfer, strict contract allowlist, function-selector allowlist,
 * approved spender allowlist (blocks ERC-20 transfer/transferFrom), and swap recipient === wallet.
 */
export function validateOutboundTx(txReq, expectedRecipient = wallet?.address || CONFIG.agentWallet) {
  if (!txReq || typeof txReq.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(txReq.to)) {
    throw new Error('TX_FIREWALL_BLOCKED: invalid destination address');
  }
  if (BigInt(txReq.value || 0n) !== 0n) {
    throw new Error('TX_FIREWALL_BLOCKED: non-zero native CELO value prohibited');
  }
  const data = String(txReq.data || '0x');
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) {
    throw new Error('TX_FIREWALL_BLOCKED: malformed calldata');
  }
  const selector = data.slice(0, 10).toLowerCase();
  const toLower = txReq.to.toLowerCase();
  const reactorLower = CONFIG.contracts.reactor.toLowerCase();
  const routerLower = CONFIG.contracts.uniSwapRouter02.toLowerCase();
  const permit2Lower = CONFIG.contracts.permit2.toLowerCase();
  const registryLower = CONFIG.contracts.erc8004Registry.toLowerCase();

  if (toLower === reactorLower) {
    if (!REACTOR_ALLOWED_SELECTORS.has(selector)) {
      throw new Error(`TX_FIREWALL_BLOCKED: unauthorized Reactor selector ${selector}`);
    }
    return true;
  }

  if (toLower === routerLower) {
    if (selector !== '0x04e45aaf' || data.length < 10 + 64 * 7) {
      throw new Error(`TX_FIREWALL_BLOCKED: unauthorized SwapRouter02 selector ${selector}`);
    }
    const [params] = routerIface.decodeFunctionData('exactInputSingle', data.slice(0, 10 + 64 * 7));
    if (params.recipient.toLowerCase() !== expectedRecipient.toLowerCase()) {
      throw new Error(`TX_FIREWALL_BLOCKED: SwapRouter02 recipient mismatch (${params.recipient})`);
    }
    return true;
  }

  if (toLower === registryLower) {
    if (selector !== SET_AGENT_URI_SELECTOR) {
      throw new Error(`TX_FIREWALL_BLOCKED: unauthorized ERC-8004 selector ${selector}`);
    }
    return true;
  }

  const allowedTokens = new Set([
    CONFIG.contracts.usdt.toLowerCase(),
    ...CONFIG.tokens.map((t) => t.address.toLowerCase()),
    ...(CONFIG.legacyUnwindTokens || []).map((t) => t.address.toLowerCase()),
  ]);
  if (allowedTokens.has(toLower)) {
    if (selector !== '0x095ea7b3' || data.length < 10 + 64 * 2) {
      throw new Error(`TX_FIREWALL_BLOCKED: only ERC-20 approve() permitted on token contracts (got ${selector})`);
    }
    const [spender] = erc20Iface.decodeFunctionData('approve', data.slice(0, 10 + 64 * 2));
    const allowedSpenders = new Set([reactorLower, permit2Lower, routerLower]);
    if (!allowedSpenders.has(spender.toLowerCase())) {
      throw new Error(`TX_FIREWALL_BLOCKED: unauthorized ERC-20 approve spender ${spender}`);
    }
    return true;
  }

  throw new Error(`TX_FIREWALL_BLOCKED: destination ${txReq.to} not in contract allowlist`);
}

/**
 * Automatic Capital-Preservation Kill Switch (Circuit Breaker):
 * Trips if rolling 24h net realized losses exceed maxDailyLossUsd, a single trade loses >= maxSingleTradeLossUsd,
 * or consecutive losing trades reach maxConsecutiveLosses.
 */
export function evaluateCircuitBreaker(arbExecutions = [], nowMs = Date.now(), cfg = CONFIG, sessionStartMs = 0) {
  const relevant = (arbExecutions || []).filter(
    (e) => e && (e.type === 'CROSS_VENUE_ARB' || e.type === 'LEG2_FLATTEN_DEX') && Number.isFinite(Number(e.edgeUsd))
  );
  const rolling24h = relevant.filter((e) => {
    const ts = Date.parse(e.timestamp || '');
    return Number.isFinite(ts) && nowMs - ts <= 86_400_000;
  });
  const rolling24hNetUsd = rolling24h.reduce((acc, e) => acc + Number(e.edgeUsd), 0);

  // ponytail: scope single-trade & consecutive-loss counters to current session (ts >= sessionStartMs) so pre-restart history never dead-locks a fresh deploy
  const sessionRecords =
    sessionStartMs > 0
      ? rolling24h.filter((e) => {
          const ts = Date.parse(e.timestamp || '');
          return Number.isFinite(ts) && ts >= sessionStartMs;
        })
      : rolling24h;
  const sessionNetUsd = sessionRecords.reduce((acc, e) => acc + Number(e.edgeUsd), 0);

  let consecutiveLosses = 0;
  for (const e of sessionRecords) {
    if (Number(e.edgeUsd) <= -0.01) consecutiveLosses += 1;
    else break;
  }
  const latestEdge = sessionRecords.length > 0 ? Number(sessionRecords[0].edgeUsd) : 0;
  const latestTs = sessionRecords.length > 0 ? Date.parse(sessionRecords[0].timestamp || '') : 0;
  const cooldownMs = Number(cfg.circuitBreakerCooldownMs ?? 15 * 60_000);

  if (latestEdge <= -(cfg.maxSingleTradeLossUsd ?? 0.35)) {
    return { tripped: true, reason: 'max_single_trade_loss', rolling24hNetUsd, sessionNetUsd, consecutiveLosses };
  }
  if (consecutiveLosses >= (cfg.maxConsecutiveLosses ?? 2) && Number.isFinite(latestTs) && nowMs - latestTs < cooldownMs) {
    return { tripped: true, reason: 'consecutive_losses', rolling24hNetUsd, sessionNetUsd, consecutiveLosses };
  }
  if (rolling24hNetUsd <= -(cfg.maxDailyLossUsd ?? 1.0) || sessionNetUsd <= -(cfg.maxDailyLossUsd ?? 1.0)) {
    return { tripped: true, reason: 'max_daily_loss', rolling24hNetUsd, sessionNetUsd, consecutiveLosses };
  }
  return { tripped: false, reason: 'ok', rolling24hNetUsd, sessionNetUsd, consecutiveLosses };
}

let cachedGasPrice = { value: null, ts: 0 };

export async function sendTagged(txReq) {
  if (!wallet) throw new Error('No STITCH_PRIVATE_KEY configured for live execution');
  validateOutboundTx(txReq, wallet.address);
  // ponytail: skip 35-byte ERC-8021 calldata suffix when ENABLE_ERC8021_TAG=0 to shave ~560 gas/tx post-hackathon
  const tagged = {
    ...txReq,
    value: 0n,
    data: CONFIG.enableErc8021Tag ? appendErc8021Suffix(txReq.data || '0x') : txReq.data || '0x',
  };
  if (!tagged.gasPrice && !tagged.maxFeePerGas) {
    if (cachedGasPrice.value && Date.now() - cachedGasPrice.ts < 15_000) {
      tagged.gasPrice = cachedGasPrice.value;
    } else {
      const fd = await provider.getFeeData().catch(() => null);
      if (fd?.gasPrice) {
        cachedGasPrice = { value: fd.gasPrice, ts: Date.now() };
        tagged.gasPrice = fd.gasPrice;
      }
    }
  }
  if (!tagged.gasLimit) {
    // ponytail: never fallback to 220k on estimateGas revert — abort at $0 gas when a Maker quote was sniped
    const est = await provider.estimateGas({ ...tagged, from: wallet.address });
    tagged.gasLimit = (est * 125n) / 100n;
  }
  const resp = await wallet.sendTransaction(tagged);
  const receipt = await resp.wait();
  return receipt;
}

async function readPoolMid(poolAddr, token0IsUsdt, tokenDecimals = 6) {
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [sqrtPriceX96] = await pool.slot0();
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const price1Per0Raw = s * s;
  if (token0IsUsdt) {
    const tokPerUsdt = price1Per0Raw / 10 ** (tokenDecimals - 6);
    return 1 / tokPerUsdt;
  } else {
    return price1Per0Raw * 10 ** (tokenDecimals - 6);
  }
}

export const MAX_UNI_QUOTE_GAS = 800000n;

/**
 * Guardrail: reject malformed Uniswap v3 pools whose TickBitmap traversal exceeds 800k gas
 * (e.g., wBRL/USDT initialized at MAX_TICK = 887,271 -> 17.04M gas).
 */
export function isValidUniQuoteGas(amountOut, gasEstimate) {
  return BigInt(amountOut || 0n) > 0n && BigInt(gasEstimate || 0n) <= MAX_UNI_QUOTE_GAS;
}

async function bestUniQuote(tokenIn, tokenOut, amountInRaw) {
  for (const fee of [100, 500]) {
    try {
      const [amountOut, , , gasEstimate] = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn: amountInRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      if (isValidUniQuoteGas(amountOut, gasEstimate)) {
        return { fee, amountOut: BigInt(amountOut) };
      }
    } catch {
      // try next tier
    }
  }
  return { fee: 100, amountOut: 0n };
}

export const PREVIEW_BUDGET = {
  limit: 60,
  remaining: 60,
  resetAtMs: 0,
  reserveForChase: Number(process.env.PREVIEW_RESERVE_CREDITS || '10'),
};

async function textilePreview(sellToken, buyToken, sellAmountRaw, opts = {}) {
  const now = Date.now();
  if (PREVIEW_BUDGET.resetAtMs > 0 && now >= PREVIEW_BUDGET.resetAtMs) {
    PREVIEW_BUDGET.remaining = PREVIEW_BUDGET.limit;
    PREVIEW_BUDGET.resetAtMs = 0;
  }
  if (!opts.priority && PREVIEW_BUDGET.remaining <= PREVIEW_BUDGET.reserveForChase && PREVIEW_BUDGET.resetAtMs > now) {
    return { status: 'rate_budget_reserved', reason: 'rate_budget_reserved' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${CONFIG.textileApi}/v2/rfq/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId: CONFIG.chainId,
        sellToken,
        buyToken,
        sellAmount: sellAmountRaw.toString(),
      }),
      signal: ctrl.signal,
    });
    const limHdr = Number(res.headers.get('x-ratelimit-limit'));
    const remHdr = Number(res.headers.get('x-ratelimit-remaining'));
    const rstHdr = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(limHdr) && limHdr > 0) PREVIEW_BUDGET.limit = limHdr;
    if (Number.isFinite(remHdr) && remHdr >= 0) PREVIEW_BUDGET.remaining = remHdr;
    if (Number.isFinite(rstHdr) && rstHdr > 0) PREVIEW_BUDGET.resetAtMs = Date.now() + rstHdr * 1000;
    if (res.status === 429) {
      PREVIEW_BUDGET.remaining = 0;
      if (PREVIEW_BUDGET.resetAtMs <= Date.now()) PREVIEW_BUDGET.resetAtMs = Date.now() + 15000;
      return { status: 'rate_limited', reason: 'http_429' };
    }
    const json = await res.json().catch(() => ({}));
    return json?.data || json;
  } finally {
    clearTimeout(timer);
  }
}

async function signTakerControl() {
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');
  const issuedAt = Date.now();
  const signature = await wallet.signTypedData(
    { name: 'Textile Taker Control', version: '1', chainId: CONFIG.chainId },
    {
      TakerControl: [
        { name: 'taker', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint256' },
      ],
    },
    { taker: wallet.address, chainId: BigInt(CONFIG.chainId), nonce, issuedAt: BigInt(issuedAt) }
  );
  return { nonce, issuedAt, signature };
}

async function textileRequestQuote(sellToken, buyToken, sellAmountRaw) {
  const sendReq = async (extra = {}) => {
    const res = await fetch(`${CONFIG.textileApi}/v2/rfq/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId: CONFIG.chainId,
        sellToken,
        buyToken,
        sellAmount: sellAmountRaw.toString(),
        taker: wallet.address,
        ...extra,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let r = await sendReq();
    if (r.status === 401 && r.body?.error?.details?.reason === 'proof_of_control_required') {
      r = await sendReq({ takerProof: await signTakerControl() });
    }
    if (!r.ok) {
      const errStr = JSON.stringify(r.body?.error || r.body);
      if (attempt < 2 && errStr.includes('insufficient_funds')) {
        await new Promise((res) => setTimeout(res, 2500));
        continue;
      }
      throw new Error(`Textile /v2/rfq/request ${r.status}: ${errStr.slice(0, 160)}`);
    }
    return r.body?.data || r.body;
  }
}

async function textileSubmitTx(rfqId, claimToken, txHash) {
  if (!rfqId || !claimToken) return;
  await fetch(`${CONFIG.textileApi}/v2/rfq/${rfqId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rfq-claim': claimToken },
    body: JSON.stringify({ txHash }),
  }).catch(() => {});
}

/**
 * Scan a single token across one or both directions with Multi-Slice (100% / 75% / 50% / 35% / 20%) + adaptive availableSellAmount sizing.
 */
async function scanCorridor(token, maxUsdtBudget, onlyDirection = null, opts = {}) {
  const candidateSlices = computeSliceSizesUsdt(
    maxUsdtBudget || token.probeUsdt,
    Math.min(CONFIG.maxSliceUsdt, token.probeUsdt)
  );
  const probeUsdt = candidateSlices[0] || 25;
  const usdtInRaw = ethers.parseUnits(probeUsdt.toFixed(6), 6);
  const rows = [];

  // ponytail: zero-HTTP-cost RPC liquidity pre-check — skips spending Textile preview quota on one-way/empty DEX pools (e.g. wBRL/USDT)
  const sampleMidUsd = Number(STATE.textileMids?.[token.symbol] || 0);
  const sampleUnits = sampleMidUsd > 0 ? Math.max(1, Math.floor(15 / sampleMidUsd)) : 15;
  const sampleSellRaw = ethers.parseUnits(String(sampleUnits), token.decimals);
  const dexSellProbe = await bestUniQuote(token.address, CONFIG.contracts.usdt, sampleSellRaw);
  const hasDexSellExit = dexSellProbe.amountOut > 0n;

  // Direction 1: TEXTILE -> UNI
  if (!onlyDirection || onlyDirection === 'textile->uni') {
    if (!hasDexSellExit) {
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        direction: 'textile->uni',
        sizeUsdt: probeUsdt,
        expectedOutUsdt: 0,
        edgeUsd: 0,
        edgeBps: 0,
        sliceCandidatesUsdt: candidateSlices,
        status: 'ILLIQUID_DEX',
        note: 'no_uniswap_sell_exit',
      });
    } else try {
      let preview = await textilePreview(CONFIG.contracts.usdt, token.address, usdtInRaw, opts);
      let actualInRaw = usdtInRaw;

      if (preview && preview.availableSellAmount && BigInt(preview.availableSellAmount) >= 1000000n) {
        const avail = BigInt(preview.availableSellAmount);
        if (preview.status !== 'preview' || avail < usdtInRaw) {
          const resized = (avail * 98n) / 100n;
          if (resized >= 1000000n) {
            actualInRaw = resized;
            preview = await textilePreview(CONFIG.contracts.usdt, token.address, actualInRaw, opts);
          }
        }
      }

      if (preview && preview.status === 'preview' && preview.buyAmount) {
        let bestInRaw = actualInRaw;
        let bestTokenOutRaw = BigInt(preview.buyAmount);
        let bestUniBack = await bestUniQuote(token.address, CONFIG.contracts.usdt, bestTokenOutRaw);
        let bestEdgeUsd = Number(bestUniBack.amountOut) / 1e6 - Number(bestInRaw) / 1e6;
        let sliceLabel =
          actualInRaw < usdtInRaw
            ? `Adaptive size ($${(Number(actualInRaw) / 1e6).toFixed(2)} max depth)`
            : `100% slice ($${(Number(actualInRaw) / 1e6).toFixed(2)})`;

        if (bestUniBack.amountOut > 0n && actualInRaw >= 20000000n) {
          const subChecks = await Promise.all(
            [75n, 50n, 35n, 20n].map(async (frac) => {
              const sliceInRaw = (actualInRaw * frac) / 100n;
              const sliceTokenRaw = (BigInt(preview.buyAmount) * frac) / 100n;
              if (sliceInRaw < 5000000n || sliceTokenRaw <= 0n) return null;
              const sliceUni = await bestUniQuote(token.address, CONFIG.contracts.usdt, sliceTokenRaw);
              return {
                frac,
                sliceInRaw,
                sliceTokenRaw,
                sliceUni,
                sliceEdgeUsd: Number(sliceUni.amountOut) / 1e6 - Number(sliceInRaw) / 1e6,
              };
            })
          );
          for (const sub of subChecks) {
            if (sub && sub.sliceEdgeUsd > bestEdgeUsd) {
              bestInRaw = sub.sliceInRaw;
              bestTokenOutRaw = sub.sliceTokenRaw;
              bestUniBack = sub.sliceUni;
              bestEdgeUsd = sub.sliceEdgeUsd;
              sliceLabel = `${sub.frac}% multi-slice ($${(Number(sub.sliceInRaw) / 1e6).toFixed(2)})`;
            }
          }

          // ponytail: conditional 25% top-of-book preview only when close to positive edge (> -2.5 bps) and quota has headroom
          const currBps = Number(bestInRaw) > 0 ? (bestEdgeUsd / (Number(bestInRaw) / 1e6)) * 10000 : -999;
          if (
            bestEdgeUsd < CONFIG.minEdgeUsd &&
            currBps > -2.5 &&
            actualInRaw >= 40000000n &&
            (opts.priority || PREVIEW_BUDGET.remaining >= 28)
          ) {
            const topSliceInRaw = (actualInRaw * 25n) / 100n;
            const topPreview = await textilePreview(CONFIG.contracts.usdt, token.address, topSliceInRaw, opts).catch(() => null);
            if (topPreview && topPreview.status === 'preview' && topPreview.buyAmount) {
              const topTokenRaw = BigInt(topPreview.buyAmount);
              const topUni = await bestUniQuote(token.address, CONFIG.contracts.usdt, topTokenRaw);
              const topEdgeUsd = Number(topUni.amountOut) / 1e6 - Number(topSliceInRaw) / 1e6;
              if (topEdgeUsd > bestEdgeUsd) {
                bestInRaw = topSliceInRaw;
                bestTokenOutRaw = topTokenRaw;
                bestUniBack = topUni;
                bestEdgeUsd = topEdgeUsd;
                sliceLabel = '25% top-of-book ($' + (Number(topSliceInRaw) / 1e6).toFixed(2) + ')';
              }
            }
          }
        }

        const usdtInNum = Number(bestInRaw) / 1e6;
        const usdtOutNum = Number(bestUniBack.amountOut) / 1e6;
        const edgeUsd = usdtOutNum - usdtInNum;
        const edgeBps = usdtInNum > 0 ? (edgeUsd / usdtInNum) * 10000 : 0;
        rows.push({
          corridor: `${token.symbol}/USDT`,
          symbol: token.symbol,
          tokenAddress: token.address,
          decimals: token.decimals,
          direction: 'textile->uni',
          sizeUsdt: usdtInNum,
          amountInRaw: bestInRaw.toString(),
          midTokenRaw: bestTokenOutRaw.toString(),
          expectedOutUsdt: usdtOutNum,
          uniFee: bestUniBack.fee,
          edgeUsd,
          edgeBps,
          sliceCandidatesUsdt: candidateSlices,
          status: edgeUsd >= CONFIG.minEdgeUsd && edgeBps >= CONFIG.minEdgeBps ? 'ACTIONABLE' : 'WATCH',
          note: sliceLabel,
        });
      } else {
        const isDeferred = preview?.status === 'rate_budget_reserved' || preview?.status === 'rate_limited';
        rows.push({
          corridor: `${token.symbol}/USDT`,
          symbol: token.symbol,
          direction: 'textile->uni',
          sizeUsdt: Number(actualInRaw) / 1e6,
          expectedOutUsdt: 0,
          edgeUsd: 0,
          edgeBps: 0,
          sliceCandidatesUsdt: candidateSlices,
          status: isDeferred ? 'DEFERRED_QUOTA' : 'NO_MAKER',
          note: preview?.reason || 'no_makers_online',
        });
      }
    } catch (e) {
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        direction: 'textile->uni',
        sizeUsdt: probeUsdt,
        expectedOutUsdt: 0,
        edgeUsd: 0,
        edgeBps: 0,
        sliceCandidatesUsdt: candidateSlices,
        status: 'ERR',
        note: e.message?.slice(0, 40) || 'error',
      });
    }
  }

  // Direction 2: UNI -> TEXTILE
  if (!onlyDirection || onlyDirection === 'uni->textile') {
    const preBalUnits = Number(STATE.balances?.[token.symbol.toLowerCase()] || 0);
    const preMidUsd = Number(STATE.textileMids?.[token.symbol] || 0);
    const preBalUsd = preBalUnits * preMidUsd;
    if (!hasDexSellExit && preBalUsd < 6.0) {
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        direction: 'uni->textile',
        sizeUsdt: probeUsdt,
        expectedOutUsdt: 0,
        edgeUsd: 0,
        edgeBps: 0,
        sliceCandidatesUsdt: candidateSlices,
        status: 'ILLIQUID_DEX',
        note: 'one_way_pool_blocked',
      });
    } else try {
      const uniBuy = await bestUniQuote(CONFIG.contracts.usdt, token.address, usdtInRaw);
      if (uniBuy.amountOut > 0n) {
        let preview = await textilePreview(token.address, CONFIG.contracts.usdt, uniBuy.amountOut, opts);
        let actualUsdtInRaw = usdtInRaw;
        let actualTokenRaw = uniBuy.amountOut;

        if (preview && preview.availableSellAmount && BigInt(preview.availableSellAmount) > 0n) {
          const availToken = BigInt(preview.availableSellAmount);
          if (preview.status !== 'preview' || availToken < uniBuy.amountOut) {
            const ratio = Number(availToken) / Number(uniBuy.amountOut);
            const resizedUsdt = BigInt(Math.floor(Number(usdtInRaw) * ratio * 0.98));
            if (resizedUsdt >= 1000000n) {
              const reUni = await bestUniQuote(CONFIG.contracts.usdt, token.address, resizedUsdt);
              if (reUni.amountOut > 0n) {
                actualUsdtInRaw = resizedUsdt;
                actualTokenRaw = reUni.amountOut;
                preview = await textilePreview(token.address, CONFIG.contracts.usdt, actualTokenRaw, opts);
              }
            }
          }
        }

        if (preview && preview.status === 'preview' && preview.buyAmount) {
          let bestInRaw = actualUsdtInRaw;
          let bestTokenRaw = actualTokenRaw;
          let bestOutRaw = BigInt(preview.buyAmount);
          let bestFee = uniBuy.fee;
          let bestEdgeUsd = Number(bestOutRaw) / 1e6 - Number(bestInRaw) / 1e6;
          let noteLabel =
            actualUsdtInRaw < usdtInRaw
              ? `Adaptive size ($${(Number(actualUsdtInRaw) / 1e6).toFixed(2)} max depth)`
              : `100% slice ($${(Number(actualUsdtInRaw) / 1e6).toFixed(2)})`;

          // ponytail: zero-HTTP-cost RPC multi-slice on uni->textile — scales Maker rate across exact Uniswap v3 sub-quotes, saving 3 previews/corridor
          const fullBuyAmountRaw = BigInt(preview.buyAmount);
          if (actualUsdtInRaw >= 25000000n && actualTokenRaw > 0n) {
            const subSlices = await Promise.all(
              [75n, 50n, 35n, 20n].map(async (frac) => {
                const subInRaw = (actualUsdtInRaw * frac) / 100n;
                if (subInRaw < 10000000n) return null;
                const subUni = await bestUniQuote(CONFIG.contracts.usdt, token.address, subInRaw);
                if (subUni.amountOut <= 0n) return null;
                const subOutRaw = (fullBuyAmountRaw * subUni.amountOut) / actualTokenRaw;
                return {
                  frac,
                  subInRaw,
                  subTokenRaw: subUni.amountOut,
                  subOutRaw,
                  subFee: subUni.fee,
                  subEdgeUsd: Number(subOutRaw) / 1e6 - Number(subInRaw) / 1e6,
                };
              })
            );
            for (const sub of subSlices) {
              if (sub && sub.subEdgeUsd > bestEdgeUsd) {
                bestInRaw = sub.subInRaw;
                bestTokenRaw = sub.subTokenRaw;
                bestOutRaw = sub.subOutRaw;
                bestFee = sub.subFee;
                bestEdgeUsd = sub.subEdgeUsd;
                noteLabel = `${sub.frac}% multi-slice ($` + (Number(sub.subInRaw) / 1e6).toFixed(2) + ')';
              }
            }

            const invCoversSub = preBalUsd >= Math.max(6.0, (Number(bestInRaw) / 1e6) * 0.95);
            const subMinReqUsd = invCoversSub ? CONFIG.minEdgeUsd : CONFIG.minUniToTextileDexFirstUsd;
            const currBps = Number(bestInRaw) > 0 ? (bestEdgeUsd / (Number(bestInRaw) / 1e6)) * 10000 : -999;
            if (
              bestEdgeUsd < subMinReqUsd &&
              currBps > -2.5 &&
              actualUsdtInRaw >= 40000000n &&
              (opts.priority || PREVIEW_BUDGET.remaining >= 28)
            ) {
              const topInRaw = (actualUsdtInRaw * 25n) / 100n;
              const topUni = await bestUniQuote(CONFIG.contracts.usdt, token.address, topInRaw);
              if (topUni.amountOut > 0n) {
                const topPrev = await textilePreview(token.address, CONFIG.contracts.usdt, topUni.amountOut, opts).catch(() => null);
                if (topPrev && topPrev.status === 'preview' && topPrev.buyAmount) {
                  const topOutRaw = BigInt(topPrev.buyAmount);
                  const topEdgeUsd = Number(topOutRaw) / 1e6 - Number(topInRaw) / 1e6;
                  if (topEdgeUsd > bestEdgeUsd) {
                    bestInRaw = topInRaw;
                    bestTokenRaw = topUni.amountOut;
                    bestOutRaw = topOutRaw;
                    bestFee = topUni.fee;
                    bestEdgeUsd = topEdgeUsd;
                    noteLabel = '25% top-of-book ($' + (Number(topInRaw) / 1e6).toFixed(2) + ')';
                  }
                }
              }
            }
          }

          const usdtInNum = Number(bestInRaw) / 1e6;
          const usdtOutNum = Number(bestOutRaw) / 1e6;
          const edgeUsd = usdtOutNum - usdtInNum;
          const edgeBps = usdtInNum > 0 ? (edgeUsd / usdtInNum) * 10000 : 0;
          const localBalUnits = Number(STATE.balances?.[token.symbol.toLowerCase()] || 0);
          const localMidUsd = Number(STATE.textileMids?.[token.symbol] || 0);
          const invCoversClip = localBalUnits * localMidUsd >= Math.max(6.0, usdtInNum * 0.95);
          const minReqBps = invCoversClip ? CONFIG.minEdgeBps : CONFIG.minUniToTextileDexFirstBps;
          const minReqUsd = invCoversClip ? CONFIG.minEdgeUsd : CONFIG.minUniToTextileDexFirstUsd;
          rows.push({
            corridor: `${token.symbol}/USDT`,
            symbol: token.symbol,
            tokenAddress: token.address,
            decimals: token.decimals,
            direction: 'uni->textile',
            sizeUsdt: usdtInNum,
            amountInRaw: bestInRaw.toString(),
            midTokenRaw: bestTokenRaw.toString(),
            expectedOutUsdt: usdtOutNum,
            uniFee: bestFee,
            edgeUsd,
            edgeBps,
            sliceCandidatesUsdt: candidateSlices,
            status: edgeUsd >= minReqUsd && edgeBps >= minReqBps ? 'ACTIONABLE' : 'WATCH',
            note: noteLabel,
          });
        } else {
          const isDeferred = preview?.status === 'rate_budget_reserved' || preview?.status === 'rate_limited';
          rows.push({
            corridor: `${token.symbol}/USDT`,
            symbol: token.symbol,
            direction: 'uni->textile',
            sizeUsdt: probeUsdt,
            expectedOutUsdt: 0,
            edgeUsd: 0,
            edgeBps: 0,
            sliceCandidatesUsdt: candidateSlices,
            status: isDeferred ? 'DEFERRED_QUOTA' : 'NO_MAKER',
            note: preview?.reason || 'no_makers_online',
          });
        }
      } else {
        rows.push({
          corridor: `${token.symbol}/USDT`,
          symbol: token.symbol,
          direction: 'uni->textile',
          sizeUsdt: probeUsdt,
          expectedOutUsdt: 0,
          edgeUsd: 0,
          edgeBps: 0,
          sliceCandidatesUsdt: candidateSlices,
          status: 'ILLIQUID_DEX',
          note: 'no_uniswap_buy_liquidity',
        });
      }
    } catch (e) {
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        direction: 'uni->textile',
        sizeUsdt: probeUsdt,
        expectedOutUsdt: 0,
        edgeUsd: 0,
        edgeBps: 0,
        sliceCandidatesUsdt: candidateSlices,
        status: 'ERR',
        note: e.message?.slice(0, 40) || 'error',
      });
    }
  }

  return rows;
}

const STATE = {
  startedAt: new Date().toISOString(),
  lastScanAt: null,
  scanCount: 0,
  balances: { usdt: 0, cngn: 0, wars: 0, wbrl: 0, usdc: 0, celo: 0 },
  textileMids: {},
  quantBySymbol: {},
  markoutBySymbol: {},
  markoutRecords: [],
  llmSupervisor: null,
  lastLlmReviewMs: 0,
  skewMetrics: null,
  riskOfficer: null,
  corridorRowCache: {},
  opportunities: [],
  onChainActivity: [],
  arbExecutions: [],
};

if (fs.existsSync(CONFIG.markoutsLogPath)) {
  try {
    STATE.markoutRecords = fs
      .readFileSync(CONFIG.markoutsLogPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .slice(0, 100);
  } catch {
    STATE.markoutRecords = [];
  }
}

const executionManager = createExecutionManager({
  CONFIG,
  STATE,
  wallet,
  provider,
  routerIface,
  erc20Iface,
  sendTagged,
  bestUniQuote,
  textilePreview: (s, b, a) => textilePreview(s, b, a, { priority: true }),
  textileRequestQuote,
  textileSubmitTx,
  fetchJson,
  isSelfMakerOrder,
  verifyFirmArbQuote,
  sumReceiptTokenTransfers,
  getCachedOffChainFx: () => cachedOffChainFx,
});

const {
  ensureErc8004Metadata,
  settlePendingHoldings,
  executeOpportunity,
  autoManageTreasuryInventory,
  persistMarkoutRecords,
  loadOnChainHistory,
} = executionManager;

let isBusy = false;

export async function runSingleScan() {
  if (isBusy) return STATE;
  isBusy = true;
  try {
    if (CONFIG.liveTrading && wallet) {
      try {
        await settlePendingHoldings();
      } catch (err) {
        console.error(`[SETTLE-ERR] ${err.message}`);
      }
    }

    const usdtC = new ethers.Contract(CONFIG.contracts.usdt, ERC20_ABI, provider);
    const cngnC = new ethers.Contract(CONFIG.tokens[0].address, ERC20_ABI, provider);
    const warsC = new ethers.Contract(CONFIG.tokens[1].address, ERC20_ABI, provider);
    const wbrlC = new ethers.Contract(CONFIG.tokens[2].address, ERC20_ABI, provider);
    const usdcC = new ethers.Contract(CONFIG.tokens[3].address, ERC20_ABI, provider);

    const usatTok = CONFIG.tokens.find((t) => t.symbol === 'USAT');
    const usatC = usatTok ? new ethers.Contract(usatTok.address, ERC20_ABI, provider) : null;

    let usdt = 97.6;
    let cngn = 25020.0;
    let wars = 22191.0;
    let wbrl = 390.6;
    let usdc = 15.0;
    let usat = 0.0;
    let celo = 10.6;
    let uniCngnMid = 0.00072538;
    let uniWarsMid = 0.00067808;

    const [offChainFx, fetchedTextileMids] = await Promise.all([
      fetchOffChainFxRates(),
      fetchTextileCorridorPrices(),
    ]);
    STATE.textileMids = { ...STATE.textileMids, ...fetchedTextileMids };

    try {
      const [usdtRaw, cngnRaw, warsRaw, wbrlRaw, usdcRaw, usatRaw, celoRaw, poolCngnMid, poolWarsMid] = await Promise.all([
        usdtC.balanceOf(CONFIG.agentWallet),
        cngnC.balanceOf(CONFIG.agentWallet),
        warsC.balanceOf(CONFIG.agentWallet),
        wbrlC.balanceOf(CONFIG.agentWallet),
        usdcC.balanceOf(CONFIG.agentWallet),
        usatC ? usatC.balanceOf(CONFIG.agentWallet) : Promise.resolve(0n),
        provider.getBalance(CONFIG.agentWallet),
        readPoolMid(CONFIG.contracts.cngnUsdtPool, true, 6),
        readPoolMid(CONFIG.contracts.warsUsdtPool, false, 18),
      ]);
      usdt = Number(usdtRaw) / 1e6;
      cngn = Number(cngnRaw) / 1e6;
      wars = Number(warsRaw) / 1e18;
      wbrl = Number(wbrlRaw) / 1e18;
      usdc = Number(usdcRaw) / 1e6;
      usat = Number(usatRaw) / 1e6;
      celo = Number(celoRaw) / 1e18;
      uniCngnMid = poolCngnMid;
      uniWarsMid = poolWarsMid;
    } catch (rpcErr) {
      console.warn(`[RPC-FALLBACK] Using cached reference state (${rpcErr.message?.slice(0, 60)})`);
    }

    const wbrlMidUsd = STATE.textileMids.wBRL || (offChainFx.BRL > 0 ? 1 / offChainFx.BRL : 0.185);
    const usdcMidUsd = STATE.textileMids.USDC || 1.0;
    const usatMidUsd = STATE.textileMids.USAT || 1.0;
    const totalUsd =
      usdt +
      cngn * uniCngnMid +
      wars * uniWarsMid +
      wbrl * wbrlMidUsd +
      usdc * usdcMidUsd +
      usat * usatMidUsd;
    STATE.balances = { usdt, cngn, wars, wbrl, usdc, usat, celo, totalUsd, uniWarsPerUsdt: 1 / uniWarsMid };

    const textileMid = STATE.textileMids.cNGN || uniCngnMid || 0.00072295;

    const nowMs = Date.now();
    const currentMids = {
      cNGN: uniCngnMid || textileMid,
      wARS: uniWarsMid || STATE.textileMids.wARS || 1 / offChainFx.ARS,
      wBRL: wbrlMidUsd,
      USDC: usdcMidUsd,
      USAT: usatMidUsd,
    };
    const offChainPerUsdMap = {
      cNGN: offChainFx.NGN,
      wARS: offChainFx.ARS,
      wBRL: offChainFx.BRL,
      USDC: 1.0,
      USAT: 1.0,
    };
    for (const tok of CONFIG.tokens) {
      STATE.quantBySymbol[tok.symbol] = updateCorridorQuantState(STATE.quantBySymbol[tok.symbol], {
        mid: currentMids[tok.symbol],
        offChainPerUsd: offChainPerUsdMap[tok.symbol],
        priorCarryBps: tok.dailyCarryBps,
        nowMs,
      });
    }

    const markoutEval = evaluateMarkoutAdjustments(STATE.markoutRecords, currentMids, nowMs, CONFIG.tokens);
    STATE.markoutBySymbol = markoutEval.bySymbol;
    if (markoutEval.mutated) persistMarkoutRecords();

    STATE.skewMetrics = computeSkewAndQuotes({
      usdtUsd: usdt,
      cngnBalance: cngn,
      textileMid,
      uniMid: uniCngnMid,
    });

    const baseRisk = computeRiskOfficerDecisions({
      usdt,
      cngn,
      wars,
      wbrl,
      usdc,
      uniCngnMid,
      uniWarsMid,
      skewMetrics: STATE.skewMetrics,
      offChainFx,
      textileMids: STATE.textileMids,
      quantBySymbol: STATE.quantBySymbol,
      markoutBySymbol: STATE.markoutBySymbol,
      llmOverlay: STATE.llmSupervisor,
      now: new Date(nowMs),
      targetCorridorUsd: CONFIG.targetCorridorUsd,
      maxSliceUsdt: CONFIG.maxSliceUsdt,
    });

    const urgentSpike = baseRisk.corridors.some(
      (c) => c.basisShockBps > 80 || c.ewmaVolBps > 15 || c.avgMarkoutBps < -5
    );
    const llmDue =
      !STATE.llmSupervisor ||
      nowMs - STATE.lastLlmReviewMs >= CONFIG.llmIntervalMs ||
      (urgentSpike && nowMs - STATE.lastLlmReviewMs >= 90_000);

    if (llmDue && !STATE.llmInFlight) {
      STATE.lastLlmReviewMs = nowMs;
      if (STATE.scanCount === 0) {
        STATE.llmSupervisor = await runGeminiRiskSupervisor({
          corridors: baseRisk.corridors,
          nowMs,
        });
      } else {
        // ponytail: non-blocking background LLM refresh so 3.5s Taker arbitrage scans never stall on HTTP latency
        STATE.llmInFlight = true;
        runGeminiRiskSupervisor({ corridors: baseRisk.corridors, nowMs })
          .then((res) => {
            STATE.llmSupervisor = res;
          })
          .catch(() => {})
          .finally(() => {
            STATE.llmInFlight = false;
          });
      }
    }

    STATE.riskOfficer = computeRiskOfficerDecisions({
      usdt,
      cngn,
      wars,
      wbrl,
      usdc,
      uniCngnMid,
      uniWarsMid,
      skewMetrics: STATE.skewMetrics,
      offChainFx,
      textileMids: STATE.textileMids,
      quantBySymbol: STATE.quantBySymbol,
      markoutBySymbol: STATE.markoutBySymbol,
      llmOverlay: STATE.llmSupervisor,
      now: new Date(nowMs),
      targetCorridorUsd: CONFIG.targetCorridorUsd,
      maxSliceUsdt: CONFIG.maxSliceUsdt,
    });

    if (CONFIG.liveTrading) {
      STATE.riskOfficer.stitchRuntimeSync = syncStitchRuntimeConfig(STATE.riskOfficer);
    }
    if (CONFIG.liveTrading || process.env.SKEW_POLICY_FILE) {
      STATE.riskOfficer.stitchPolicySync = syncStitchRuntimePolicy(STATE.riskOfficer);
    }

    // ponytail: tiered rate-aware rotation — always scan cNGN + wARS + 1 rotating secondary (~5 previews/tick <= 50/min out of 60/min cap)
    const liquidUsdtBudget = Math.max(1, usdt);
    let activeTokens = CONFIG.tokens;
    if (STATE.scanCount > 0 && CONFIG.tokens.length > 2) {
      const hotTokens = CONFIG.tokens.filter((t) => t.symbol === 'cNGN' || t.symbol === 'wARS');
      const secondaryTokens = CONFIG.tokens.filter((t) => t.symbol !== 'cNGN' && t.symbol !== 'wARS');
      const rotated = secondaryTokens.length > 0 ? [secondaryTokens[(STATE.scanCount - 1) % secondaryTokens.length]] : [];
      activeTokens = [...hotTokens, ...rotated];
    }

    const scanBatches = await Promise.all(activeTokens.map((t) => scanCorridor(t, liquidUsdtBudget)));
    activeTokens.forEach((tok, idx) => {
      const freshRows = scanBatches[idx] || [];
      if (!freshRows.every((r) => r.status === 'DEFERRED_QUOTA')) {
        STATE.corridorRowCache[tok.symbol] = freshRows.filter((r) => r.status !== 'DEFERRED_QUOTA');
      }
    });

    const rank = (s) => (s === 'ACTIONABLE' ? 0 : s === 'WATCH' ? 1 : s === 'NO_MAKER' ? 2 : 3);
    const allRows = CONFIG.tokens
      .flatMap((t) => STATE.corridorRowCache[t.symbol] || [])
      .sort((a, b) => rank(a.status) - rank(b.status) || b.edgeUsd - a.edgeUsd);
    STATE.opportunities = allRows;
    STATE.lastScanAt = new Date().toISOString();
    STATE.scanCount += 1;

    const actionableRows = allRows
      .filter((r) => r.status === 'ACTIONABLE' && r.edgeUsd >= CONFIG.minEdgeUsd)
      .slice(0, 2);
    const bestRow = allRows[0];
    console.log(
      `[SCAN #${STATE.scanCount}] Total=$${totalUsd.toFixed(2)} (USDT=$${usdt.toFixed(2)} cNGN=${cngn.toFixed(0)} wARS=${wars.toFixed(0)} wBRL=${wbrl.toFixed(1)} USDC=$${usdc.toFixed(2)}) quota=${PREVIEW_BUDGET.remaining}/${PREVIEW_BUDGET.limit} | best=${bestRow ? `${bestRow.corridor}(${bestRow.direction}) $${bestRow.sizeUsdt.toFixed(1)} edge=$${bestRow.edgeUsd.toFixed(4)} (${bestRow.edgeBps.toFixed(2)}bps) [${bestRow.status}]` : 'none'}`
    );

    const sessionStartMs = Date.parse(STATE.startedAt) || 0;
    STATE.circuitBreaker = evaluateCircuitBreaker(STATE.arbExecutions, nowMs, CONFIG, sessionStartMs);
    let arbExecutedThisTick = false;
    if (STATE.circuitBreaker.tripped && CONFIG.liveTrading) {
      console.warn(
        `[CIRCUIT-BREAKER] Live Taker execution paused (${STATE.circuitBreaker.reason}): 24hNet=$${STATE.circuitBreaker.rolling24hNetUsd.toFixed(4)} consecutiveLosses=${STATE.circuitBreaker.consecutiveLosses}`
      );
    } else if (actionableRows.length > 0 && CONFIG.liveTrading && wallet && celo >= 0.15) {
      for (const candidate of actionableRows) {
        try {
          const execRec = await executeOpportunity(candidate);
          if (execRec) {
            arbExecutedThisTick = true;
            STATE.arbExecutions.unshift(execRec);
            STATE.circuitBreaker = evaluateCircuitBreaker(STATE.arbExecutions, Date.now(), CONFIG, sessionStartMs);
            // ponytail: 1.0s hot-corridor chase loop uses reserved priority quota credits to drain external Makers before Kiyoshi's 30s timer
            const corridorTok = CONFIG.tokens.find((t) => t.symbol === candidate.symbol);
            if (corridorTok && execRec.edgeUsd > 0 && !STATE.circuitBreaker.tripped && CONFIG.chaseIntervalMs > 0) {
              for (let chaseIdx = 1; chaseIdx <= CONFIG.maxChaseIterations; chaseIdx++) {
                await new Promise((res) => setTimeout(res, CONFIG.chaseIntervalMs));
                const [freshUsdtRaw, freshCeloRaw] = await Promise.all([
                  usdtC.balanceOf(CONFIG.agentWallet),
                  provider.getBalance(CONFIG.agentWallet),
                ]).catch(() => [0n, 0n]);
                const freshUsdt = Number(freshUsdtRaw) / 1e6;
                const freshCelo = Number(freshCeloRaw) / 1e18;
                if (freshUsdt < 10 || freshCelo < 0.15) break;
                const chaseRows = await scanCorridor(corridorTok, freshUsdt, candidate.direction, { priority: true });
                const chaseOpp = chaseRows.find(
                  (r) => r.status === 'ACTIONABLE' && r.edgeUsd >= CONFIG.minEdgeUsd && r.edgeBps >= CONFIG.minEdgeBps
                );
                if (!chaseOpp) break;
                console.log(
                  `[CHASE #${chaseIdx}/${CONFIG.maxChaseIterations}] ${chaseOpp.corridor}(${chaseOpp.direction}) $${chaseOpp.sizeUsdt.toFixed(2)} estEdge=+$${chaseOpp.edgeUsd.toFixed(4)} (+${chaseOpp.edgeBps.toFixed(2)} bps)`
                );
                const chaseExec = await executeOpportunity(chaseOpp);
                if (!chaseExec) break;
                STATE.arbExecutions.unshift(chaseExec);
                STATE.circuitBreaker = evaluateCircuitBreaker(STATE.arbExecutions, Date.now(), CONFIG, sessionStartMs);
                if (chaseExec.edgeUsd <= 0 || STATE.circuitBreaker.tripped) break;
              }
            }
            break;
          }
        } catch (err) {
          console.error(`[EXEC-ERR] ${err.message}`);
        }
      }
    }

    if (!arbExecutedThisTick && CONFIG.liveTrading && process.env.AUTO_REFILL === '1' && wallet) {
      try {
        const treasuryRec = await autoManageTreasuryInventory({ usdt, cngn, wars, wbrl, usdc, celo, uniCngnMid, uniWarsMid });
        if (treasuryRec) STATE.arbExecutions.unshift(treasuryRec);
      } catch (err) {
        console.error(`[TREASURY-ERR] ${err.message}`);
      }
    }

    return STATE;
  } finally {
    isBusy = false;
  }
}

export function renderDashboardHtml() {
  return fs.readFileSync(path.join(__dirname, 'docs', 'index.html'), 'utf8');
}

export function runDryRunVerification() {
  const tagged = appendErc8021Suffix('0x12345678');
  if (!tagged.endsWith(CONFIG.erc8021SuffixHex) || (tagged.length - 2) / 2 !== 4 + 35) {
    throw new Error(`ERC-8021 suffix check failed: ${tagged}`);
  }
  const sim = computeSkewAndQuotes({
    usdtUsd: 191.52,
    cngnBalance: 4840.99,
    textileMid: 0.00072295,
    uniMid: 0.00072538,
  });
  if (sim.effectiveSellMid < sim.uniMid) {
    throw new Error('Dual-oracle anti-arb shield failed: effectiveSellMid < uniMid');
  }
  if (!isValidUniQuoteGas(1000000n, 150000n) || isValidUniQuoteGas(1000000n, 17039337n)) {
    throw new Error('MAX_TICK gas-griefing filter check failed');
  }
  if (!renderDashboardHtml().includes('Skew')) {
    throw new Error('Dashboard HTML check failed');
  }
  return {
    check: 'PASS',
    mode: 'DRY_RUN_SANDBOX',
    chainId: CONFIG.chainId,
    agentId: CONFIG.agentId,
    erc8004Registry: CONFIG.contracts.erc8004Registry,
    wallet: CONFIG.agentWallet,
    attributionTag: CONFIG.attributionTag,
    erc8021SuffixBytes: 35,
    corridors: CONFIG.tokens.map((t) => `${t.symbol}/USDT`),
    simulatedSkew: Number(sim.skew.toFixed(4)),
    simulatedShieldedAskCngnPerUsdt: sim.askCngnPerUsdt ? Number(sim.askCngnPerUsdt.toFixed(2)) : 'HALTED_HIGH_SKEW',
    simulatedReplenishEdgeBps: Number(sim.replenishEdgeBps.toFixed(2)),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(runDryRunVerification(), null, 2));
    process.exit(0);
  }

  if (process.argv.includes('--check')) {
    const dry = runDryRunVerification();
    await loadOnChainHistory();
    const state = await runSingleScan();
    console.log(JSON.stringify({
      ...dry,
      mode: 'LIVE_MAINNET_CHECK',
      balances: state.balances,
      skew: Number(state.skewMetrics.skew.toFixed(4)),
      textileRateCngnPerUsdt: Number((1 / state.skewMetrics.textileMid).toFixed(2)),
      uniRateCngnPerUsdt: Number((1 / state.skewMetrics.uniMid).toFixed(2)),
      shieldedAskCngnPerUsdt: state.skewMetrics.askCngnPerUsdt ? Number(state.skewMetrics.askCngnPerUsdt.toFixed(2)) : 'HALTED_HIGH_SKEW',
      replenishEdgeBps: Number(state.skewMetrics.replenishEdgeBps.toFixed(2)),
      riskOfficerCorridors: state.riskOfficer?.corridors?.length || 0,
      llmSupervisorStatus: state.llmSupervisor?.status || 'DETERMINISTIC_FALLBACK',
      llmModel: state.llmSupervisor?.model || CONFIG.geminiModel,
      topOpportunity: state.opportunities[0] || null,
      onChainTxCount: state.onChainActivity.length,
    }, null, 2));
    process.exit(0);
  }

  STATE.skewMetrics = computeSkewAndQuotes({
    usdtUsd: 97.6,
    cngnBalance: 25020,
    textileMid: 0.00072295,
    uniMid: 0.00072538,
  });
  STATE.riskOfficer = computeRiskOfficerDecisions({
    usdt: 97.6,
    cngn: 25020,
    wars: 22191,
    wbrl: 390.6,
    usdc: 15.0,
    uniCngnMid: 0.00072538,
    uniWarsMid: 0.00067808,
    skewMetrics: STATE.skewMetrics,
  });

  let lastManualScanMs = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
    const origin = req.headers.origin || '';
    const corsHeaders =
      origin === `http://localhost:${CONFIG.port}` || origin === `http://127.0.0.1:${CONFIG.port}`
        ? { 'access-control-allow-origin': origin }
        : {};

    if (CONFIG.dashboardToken) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${CONFIG.dashboardToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    }

    if (url.pathname === '/status' || url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ ...STATE, liveTrading: CONFIG.liveTrading, config: { chainId: CONFIG.chainId, agentId: CONFIG.agentId, erc8004Registry: CONFIG.contracts.erc8004Registry, wallet: CONFIG.agentWallet, attributionTag: CONFIG.attributionTag } }, null, 2));
    }
    if (url.pathname === '/trades') {
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ arbExecutions: STATE.arbExecutions, onChainActivity: STATE.onChainActivity }, null, 2));
    }
    if (url.pathname === '/llm') {
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({
        llmSupervisor: STATE.llmSupervisor,
        quantBySymbol: STATE.quantBySymbol,
        markoutBySymbol: STATE.markoutBySymbol,
        recentMarkouts: STATE.markoutRecords.slice(0, 20),
      }, null, 2));
    }
    if (url.pathname === '/scan' && req.method === 'POST') {
      const remoteIp = req.socket?.remoteAddress || '';
      const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
      if (!isLoopback && !CONFIG.dashboardToken) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'loopback_only' }));
      }
      if (Date.now() - lastManualScanMs < 5000) {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'rate_limited' }));
      }
      lastManualScanMs = Date.now();
      await runSingleScan();
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ ok: true, lastScanAt: STATE.lastScanAt }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml());
  });

  server.listen(CONFIG.port, CONFIG.bindHost, () => {
    console.log(`[SKEW-DESK] Agent #${CONFIG.agentId} (${CONFIG.attributionTag}) listening on http://${CONFIG.bindHost}:${CONFIG.port}`);
    console.log(`[SKEW-DESK] Mode: ${CONFIG.liveTrading ? 'LIVE ON-CHAIN EXECUTION' : 'TELEMETRY + WATCH (set LIVE=1 to execute)'}`);
  });

  ensureErc8004Metadata().catch(() => {});
  loadOnChainHistory().catch(() => {});
  runSingleScan().catch((e) => console.error('[SCAN-ERR]', e.message));
  setInterval(() => runSingleScan().catch((e) => console.error('[SCAN-ERR]', e.message)), CONFIG.scanIntervalMs);
  setInterval(() => loadOnChainHistory().catch(() => {}), 60000);
}
