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
const FLASH_ROUTER_SAVE_PATH = path.join(__dirname, 'flash-router.json');

function loadSavedFlashRouterAddress() {
  if (process.env.FLASH_ROUTER_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(process.env.FLASH_ROUTER_ADDRESS)) {
    return addr(process.env.FLASH_ROUTER_ADDRESS);
  }
  try {
    if (fs.existsSync(FLASH_ROUTER_SAVE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(FLASH_ROUTER_SAVE_PATH, 'utf8'));
      if (saved?.address && /^0x[0-9a-fA-F]{40}$/.test(saved.address)) return addr(saved.address);
    }
  } catch {}
  return '';
}

export const CONFIG = {
  chainId: 42220,
  rpcUrl: process.env.CELO_RPC_URL || 'https://forno.celo.org',
  wsRpcUrl: process.env.CELO_WS_URL || 'wss://forno.celo.org/ws',
  textileApi: 'https://api.textilecredit.com',
  textileApiKey: (process.env.TEXTILE_API_KEY || '').trim(),
  flashRouterAddress: loadSavedFlashRouterAddress(),
  flashRouterSavePath: FLASH_ROUTER_SAVE_PATH,
  maxFlashSliceUsdt: Number(process.env.MAX_FLASH_SLICE_USDT || '12000'),
  maxUsdFlashSliceUsdt: Number(process.env.MAX_USD_FLASH_SLICE_USDT || '35000'),
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
    multicall3: addr('0xcA11bde05977b3631167028862bE2a173976CA11'),
    uniSwapRouter02: addr('0x5615CDAb10dc425a742d643d949a7F474C01abc4'),
    erc8004Registry: addr('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'),
    cngnUsdtPool: addr('0x6519d56Eb0A69FC0338657784c783B169b8f7d32'),
    warsUsdtPool: addr('0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391'),
    flashPools: {
      cNGN: addr('0x6519d56Eb0A69FC0338657784c783B169b8f7d32'),
      wARS: addr('0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391'),
      wBRL: addr('0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F'),
      USDC: addr('0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846'),
      USAT: addr('0x070D575a713EaF5025462D0865Fb0Dac4B14bC38'),
      CELO: addr('0x6cde5f5a192fBf3fD84df983aa6DC30dbd9f8Fac'),
      VGBP: addr('0x8C7545d227140fabB2709eA41E1A927F4e65b946'),
      WETH: addr('0xF55791AfBB35aD42984f18D6Fe3e1fF73D81900c'),
      COPM: addr('0x4495F525C4ECaCF9713a51eC3e8d1e81d7dFf870'),
    },
  },
  // Pure zero-allowance flash-only Celo corridors (never held or approved by EOA wallet)
  extraFlashTokens: [
    { symbol: 'CELO', address: addr('0x471EcE3750Da237f93B8E339c536989b8978a438'), decimals: 18, probeUsdt: 400, fxCode: 'ASSET', flashOnly: true },
    { symbol: 'VGBP', address: addr('0x7aE4265eCFC1F31bc0E112DfCFe3D78E01f4BB7f'), decimals: 18, probeUsdt: 400, fxCode: 'GBP', flashOnly: true },
    { symbol: 'WETH', address: addr('0xD221812de1BD094f35587EE8E174B07B6167D9Af'), decimals: 18, probeUsdt: 400, fxCode: 'ASSET', flashOnly: true },
    { symbol: 'COPM', address: addr('0xC92E8Fc2947E32F2B574CCA9F2F12097A71d5606'), decimals: 18, probeUsdt: 400, fxCode: 'COP', flashOnly: true },
  ],
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
  minFlashEdgeBps: Number(process.env.MIN_FLASH_EDGE_BPS || '0.05'),
  minFirmNetEdgeUsd: Number(process.env.MIN_FIRM_NET_EDGE_USD || '0.010'),
  minFirmNetEdgeBps: Number(process.env.MIN_FIRM_NET_EDGE_BPS || '0.45'),
  // Positive-EV floor for cash-first uni->textile (avoids -3 bps DEX flatten bleed when Makers reprice during Leg 2)
  minUniToTextileDexFirstBps: Number(process.env.MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS || '2.5'),
  minUniToTextileDexFirstUsd: Number(process.env.MIN_UNI_TO_TEXTILE_DEX_FIRST_USD || '0.045'),
  estimatedArbGasUsd: Number(process.env.EST_ARB_GAS_USD || '0.003'),
  priorityTipGwei: Number(process.env.PRIORITY_TIP_GWEI || '20'),
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

let cachedGasPrice = { value: null, ts: 0 };

/**
 * Compute live 2-leg arbitrage gas cost in USD from Celo baseFee + priority tip (~320k combined gas).
 * Falls back to CONFIG.estimatedArbGasUsd when offline so unit tests stay deterministic.
 */
export function estimateLiveArbGasUsd(gasPriceWei = cachedGasPrice.value, celoUsd = 0.065) {
  if (!gasPriceWei || BigInt(gasPriceWei) <= 0n) return CONFIG.estimatedArbGasUsd;
  const tipWei = BigInt(Math.round((CONFIG.priorityTipGwei || 20) * 1e9));
  const effGasWei = BigInt(gasPriceWei) + tipWei;
  const totalCelo = (Number(effGasWei) * 320_000) / 1e18;
  return Math.max(CONFIG.estimatedArbGasUsd, Number((totalCelo * celoUsd).toFixed(6)));
}

/**
 * Pre-flight profitability gate on the signed firm Textile quote (`q.quote.buyAmount`) vs live Uniswap v3 exit.
 * Aborts BEFORE Leg 1 (0 gas spent) whenever preview-to-firm slippage makes the round-trip unprofitable after gas.
 */
export function verifyFirmArbQuote({
  inUsdt,
  firmOutUsdt,
  estimatedGasUsd = estimateLiveArbGasUsd(),
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

let cachedTextileMids = { data: {}, fetchedAt: 0 };

export async function fetchTextileCorridorPrices(fetchImpl = fetch) {
  if (fetchImpl === fetch && Date.now() - cachedTextileMids.fetchedAt < 15_000 && Object.keys(cachedTextileMids.data).length > 0) {
    return cachedTextileMids.data;
  }
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
  if (fetchImpl === fetch && Object.keys(out).length > 0) {
    cachedTextileMids = { data: out, fetchedAt: Date.now() };
  }
  return out;
}

// ponytail: hard 10s HTTP timeout on Celo JSON-RPC requests prevents hung TCP sockets from wedging isBusy forever
const rpcFetchReq = new ethers.FetchRequest(CONFIG.rpcUrl);
rpcFetchReq.timeout = 10_000;
const provider = new ethers.JsonRpcProvider(rpcFetchReq, CONFIG.chainId, { staticNetwork: true });
const quoter = new ethers.Contract(CONFIG.contracts.uniQuoterV2, QUOTER_ABI, provider);
const routerIface = new ethers.Interface(ROUTER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

const privKey = validatePrivateKey(process.env.STITCH_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || '');
const wallet = privKey ? new ethers.Wallet(privKey, provider) : null;

const SET_AGENT_URI_SELECTOR = ethers.id('setAgentURI(uint256,string)').slice(0, 10).toLowerCase();
const REACTOR_ALLOWED_SELECTORS = new Set(['0x3f62192e', '0x0d7a16c3']); // execute, executeBatch
const FLASH_ROUTER_ALLOWED_SELECTORS = new Set([
  '0xbbccecf8', // executeFlashArb((address,address,bool,uint256,uint256,uint256,address,address,bytes))
  ethers.id('rescueTokens(address)').slice(0, 10).toLowerCase(),
]);

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

  const allowedTokens = new Set([
    CONFIG.contracts.usdt.toLowerCase(),
    ...CONFIG.tokens.map((t) => t.address.toLowerCase()),
    ...(CONFIG.legacyUnwindTokens || []).map((t) => t.address.toLowerCase()),
  ]);

  if (toLower === reactorLower) {
    if (!REACTOR_ALLOWED_SELECTORS.has(selector)) {
      throw new Error(`TX_FIREWALL_BLOCKED: unauthorized Reactor selector ${selector}`);
    }
    return true;
  }

  const flashRouterLower = (CONFIG.flashRouterAddress || '').toLowerCase();
  if (flashRouterLower && toLower === flashRouterLower) {
    if (!FLASH_ROUTER_ALLOWED_SELECTORS.has(selector)) {
      throw new Error(`TX_FIREWALL_BLOCKED: unauthorized SkewAtomicRouter selector ${selector}`);
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
    const inLower = params.tokenIn.toLowerCase();
    const outLower = params.tokenOut.toLowerCase();
    // ponytail: permit bounded one-way USDT -> CELO (<= $5) strictly for AUTO_GAS_REFILL without granting CELO approve/sell surface
    const isBoundedGasRefill =
      inLower === CONFIG.contracts.usdt.toLowerCase() &&
      outLower === CONFIG.contracts.celo.toLowerCase() &&
      BigInt(params.amountIn || 0n) <= 5_000_000n;
    if (!isBoundedGasRefill && (!allowedTokens.has(inLower) || !allowedTokens.has(outLower))) {
      throw new Error(`TX_FIREWALL_BLOCKED: SwapRouter02 unvetted token (${params.tokenIn} -> ${params.tokenOut})`);
    }
    return true;
  }

  if (toLower === registryLower) {
    if (selector !== SET_AGENT_URI_SELECTOR) {
      throw new Error(`TX_FIREWALL_BLOCKED: unauthorized ERC-8004 selector ${selector}`);
    }
    return true;
  }

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
  const singleLossCooldownMs = Number(cfg.singleLossCooldownMs ?? 60 * 60_000);

  if (
    latestEdge <= -(cfg.maxSingleTradeLossUsd ?? 0.35) &&
    (rolling24hNetUsd <= 0 || (Number.isFinite(latestTs) && nowMs - latestTs < singleLossCooldownMs))
  ) {
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

export function computeDynamicPriorityTipGwei(expectedProfitUsd = 0, baseTipGwei = CONFIG.priorityTipGwei || 20) {
  const base = Number(baseTipGwei) || 20;
  const edge = Number(expectedProfitUsd) || 0;
  if (edge >= 10.0) return Math.max(base, 420);
  if (edge >= 2.0) return Math.max(base, 300);
  if (edge >= 0.25) return Math.max(base, 165);
  return base;
}

export async function sendTagged(txReq, opts = {}) {
  if (!wallet) throw new Error('No STITCH_PRIVATE_KEY configured for live execution');
  validateOutboundTx(txReq, wallet.address);
  // ponytail: skip 35-byte ERC-8021 calldata suffix when ENABLE_ERC8021_TAG=0 to shave ~560 gas/tx post-hackathon
  const tagged = {
    ...txReq,
    value: 0n,
    chainId: CONFIG.chainId,
    data: CONFIG.enableErc8021Tag ? appendErc8021Suffix(txReq.data || '0x') : txReq.data || '0x',
  };
  if (!tagged.gasPrice && !tagged.maxFeePerGas) {
    let baseGasPrice = cachedGasPrice.value;
    if (!baseGasPrice || Date.now() - cachedGasPrice.ts >= 15_000) {
      const fd = await provider.getFeeData().catch(() => null);
      if (fd?.gasPrice) {
        baseGasPrice = fd.gasPrice;
        cachedGasPrice = { value: baseGasPrice, ts: Date.now() };
      }
    }
    if (baseGasPrice) {
      if (opts.priorityTip) {
        // ponytail: profit-tiered EIP-1559 priority tip (65 gwei base -> 140 gwei mid -> 260 gwei on >=$2 whale clips) wins idx 1 without overpaying on micro-arbs
        const tipGwei = computeDynamicPriorityTipGwei(opts.expectedProfitUsd, CONFIG.priorityTipGwei || 20);
        const tipWei = BigInt(Math.round(tipGwei * 1e9));
        const baseMult = Number(opts.expectedProfitUsd || 0) >= 2.0 ? 200n : 140n;
        tagged.type = 2;
        tagged.maxPriorityFeePerGas = tipWei;
        tagged.maxFeePerGas = (baseGasPrice * baseMult) / 100n + tipWei;
      } else {
        tagged.gasPrice = baseGasPrice;
      }
    }
  }
  // ponytail: batch estimateGas + pending nonce in one parallel RPC round-trip so wallet.sendTransaction signs locally in 0ms
  const [est, pendingNonce] = await Promise.all([
    tagged.gasLimit ? Promise.resolve(BigInt(tagged.gasLimit)) : provider.estimateGas({ ...tagged, from: wallet.address }),
    tagged.nonce != null ? Promise.resolve(tagged.nonce) : provider.getTransactionCount(wallet.address, 'pending'),
  ]);
  if (!tagged.gasLimit) tagged.gasLimit = (est * 125n) / 100n;
  if (tagged.nonce == null) tagged.nonce = pendingNonce;
  const resp = await wallet.sendTransaction(tagged);
  // ponytail: bound receipt polling to 25s on 1s-block Celo so a dropped Forno socket after broadcast never hangs runSingleScan forever
  const receipt = await resp.wait(1, 25_000).catch(async (waitErr) => {
    const fallbackRec = await provider.getTransactionReceipt(resp.hash).catch(() => null);
    if (fallbackRec) {
      if (fallbackRec.status === 0) {
        const revErr = new Error(`transaction execution reverted (${resp.hash})`);
        revErr.receipt = fallbackRec;
        throw revErr;
      }
      return fallbackRec;
    }
    throw waitErr;
  });
  return receipt;
}

function decodeSqrtPriceToMid(sqrtPriceX96, token0IsUsdt, tokenDecimals = 6) {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const price1Per0Raw = s * s;
  if (token0IsUsdt) {
    const tokPerUsdt = price1Per0Raw / 10 ** (tokenDecimals - 6);
    return 1 / tokPerUsdt;
  }
  return price1Per0Raw * 10 ** (tokenDecimals - 6);
}

async function readPoolMid(poolAddr, token0IsUsdt, tokenDecimals = 6) {
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [sqrtPriceX96] = await pool.slot0();
  return decodeSqrtPriceToMid(sqrtPriceX96, token0IsUsdt, tokenDecimals);
}

export const MAX_UNI_QUOTE_GAS = 800000n;

/**
 * Guardrail: reject malformed Uniswap v3 pools whose TickBitmap traversal exceeds 800k gas
 * (e.g., wBRL/USDT initialized at MAX_TICK = 887,271 -> 17.04M gas).
 */
export function isValidUniQuoteGas(amountOut, gasEstimate) {
  return BigInt(amountOut || 0n) > 0n && BigInt(gasEstimate || 0n) <= MAX_UNI_QUOTE_GAS;
}

const poolIface = new ethers.Interface(POOL_ABI);
const quoterIface = new ethers.Interface(QUOTER_ABI);
const multicall3Iface = new ethers.Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

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

// ponytail: coalesce concurrent QuoterV2 calls across all 9 corridors into 1 Multicall3 eth_call (~350ms vs 90+ HTTP POSTs)
let pendingQuoteQueue = [];
let quoteFlushScheduled = false;

function queuedBestUniQuote(tokenIn, tokenOut, amountInRaw) {
  return new Promise((resolve) => {
    pendingQuoteQueue.push({ tokenIn, tokenOut, amountInRaw, resolve });
    if (!quoteFlushScheduled) {
      quoteFlushScheduled = true;
      queueMicrotask(flushPendingUniQuotes);
    }
  });
}

async function flushPendingUniQuotes() {
  const batch = pendingQuoteQueue;
  pendingQuoteQueue = [];
  quoteFlushScheduled = false;
  if (batch.length === 0) return;
  if (batch.length <= 2) {
    await Promise.all(batch.map(async (it) => it.resolve(await bestUniQuote(it.tokenIn, it.tokenOut, it.amountInRaw))));
    return;
  }
  try {
    const chunks = [];
    for (let i = 0; i < batch.length; i += 45) chunks.push(batch.slice(i, i + 45));
    await Promise.all(
      chunks.map(async (chunk) => {
        const calls = chunk.map((it) => ({
          target: CONFIG.contracts.uniQuoterV2,
          allowFailure: true,
          callData: quoterIface.encodeFunctionData('quoteExactInputSingle', [
            { tokenIn: it.tokenIn, tokenOut: it.tokenOut, amountIn: it.amountInRaw, fee: 100, sqrtPriceLimitX96: 0n },
          ]),
        }));
        const raw = await provider.call({
          to: CONFIG.contracts.multicall3,
          data: multicall3Iface.encodeFunctionData('aggregate3', [calls]),
        });
        const [resArr] = multicall3Iface.decodeFunctionResult('aggregate3', raw);
        const fallbacks = [];
        resArr.forEach((r, idx) => {
          if (r.success && r.returnData && r.returnData.length >= 128) {
            try {
              const [amtOut, , , gasEst] = quoterIface.decodeFunctionResult('quoteExactInputSingle', r.returnData);
              if (isValidUniQuoteGas(amtOut, gasEst)) {
                chunk[idx].resolve({ fee: 100, amountOut: BigInt(amtOut) });
                return;
              }
            } catch {}
          }
          fallbacks.push(chunk[idx]);
        });
        if (fallbacks.length > 0) {
          await Promise.all(
            fallbacks.map(async (it) => {
              try {
                const [amt500, , , gas500] = await quoter.quoteExactInputSingle.staticCall({
                  tokenIn: it.tokenIn,
                  tokenOut: it.tokenOut,
                  amountIn: it.amountInRaw,
                  fee: 500,
                  sqrtPriceLimitX96: 0n,
                });
                if (isValidUniQuoteGas(amt500, gas500)) {
                  it.resolve({ fee: 500, amountOut: BigInt(amt500) });
                  return;
                }
              } catch {}
              it.resolve({ fee: 100, amountOut: 0n });
            })
          );
        }
      })
    );
  } catch {
    await Promise.all(batch.map(async (it) => it.resolve(await bestUniQuote(it.tokenIn, it.tokenOut, it.amountInRaw))));
  }
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
    const headers = { 'content-type': 'application/json' };
    if (CONFIG.textileApiKey) headers.authorization = `Bearer ${CONFIG.textileApiKey}`;
    const res = await fetch(`${CONFIG.textileApi}/v2/rfq/preview`, {
      method: 'POST',
      headers,
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

async function textileRequestQuote(sellToken, buyToken, sellAmountRaw, opts = {}) {
  const targetTaker = opts.taker || wallet.address;
  const sendReq = async (extra = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (CONFIG.textileApiKey) headers.authorization = `Bearer ${CONFIG.textileApiKey}`;
    const res = await fetch(`${CONFIG.textileApi}/v2/rfq/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chainId: CONFIG.chainId,
        sellToken,
        buyToken,
        sellAmount: sellAmountRaw.toString(),
        taker: targetTaker,
        ...extra,
      }),
      signal: AbortSignal.timeout(6000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  };

  const isEoaTaker = !opts.taker || (wallet && opts.taker.toLowerCase() === wallet.address.toLowerCase());
  for (let attempt = 0; attempt < 3; attempt++) {
    let r = await sendReq();
    if (!CONFIG.textileApiKey && r.status === 401 && r.body?.error?.details?.reason === 'proof_of_control_required') {
      r = await sendReq({ takerProof: await signTakerControl() });
    }
    if (!r.ok) {
      const errStr = JSON.stringify(r.body?.error || r.body);
      if (isEoaTaker && attempt < 2 && errStr.includes('insufficient_funds')) {
        await new Promise((res) => setTimeout(res, 2500));
        continue;
      }
      const err = new Error(`Textile /v2/rfq/request ${r.status}: ${errStr.slice(0, 160)}`);
      const avail =
        r.body?.data?.availableSellAmount ||
        r.body?.error?.details?.availableSellAmount ||
        r.body?.availableSellAmount;
      if (avail) err.availableSellAmount = String(avail);
      throw err;
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
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

const corridorDepthCache = new Map();
const DEPTH_CACHE_TTL_MS = 24000;
const topProbeNegCache = new Map();
const TOP_PROBE_NEG_TTL_MS = 12000;
const dexSellExitCache = new Map();

/**
 * Piecewise linear interpolation across Textile's `/v2/rfq/levels` exact-input Maker depth knots (fee-inclusive).
 */
export function interpolateLadderBuyAmount(levels, sellAmountRaw) {
  if (!Array.isArray(levels) || levels.length === 0) return 0n;
  const x = BigInt(sellAmountRaw);
  const pts = levels
    .map((l) => ({ s: BigInt(l.sellAmount || 0), b: BigInt(l.buyAmount || 0) }))
    .filter((p) => p.s > 0n && p.b > 0n)
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  if (pts.length === 0) return 0n;
  if (x < pts[0].s || x > pts[pts.length - 1].s) return 0n;
  for (let i = 0; i < pts.length; i++) {
    if (x === pts[i].s) return pts[i].b;
    if (i + 1 < pts.length && x > pts[i].s && x < pts[i + 1].s) {
      const ds = pts[i + 1].s - pts[i].s;
      if (ds <= 0n) continue;
      return pts[i].b + ((pts[i + 1].b - pts[i].b) * (x - pts[i].s)) / ds;
    }
  }
  return pts[pts.length - 1].b;
}

const LADDER_BUDGET = { limit: 60, remaining: 60, resetAtMs: 0 };
let ladderBackoffUntilMs = 0;
let lastGoodLadder = { data: null, fetchedAtMs: 0 };

async function fetchTextileLadder(fetchImpl = fetch) {
  const now = Date.now();
  const cachedFresh = () =>
    fetchImpl === fetch && lastGoodLadder.data && Date.now() - lastGoodLadder.fetchedAtMs <= 8_000
      ? lastGoodLadder.data
      : null;
  if (fetchImpl === fetch && now < ladderBackoffUntilMs) return cachedFresh();
  if (LADDER_BUDGET.resetAtMs > 0 && now >= LADDER_BUDGET.resetAtMs) {
    LADDER_BUDGET.remaining = LADDER_BUDGET.limit;
    LADDER_BUDGET.resetAtMs = 0;
  }
  if (PREVIEW_BUDGET.resetAtMs > 0 && now >= PREVIEW_BUDGET.resetAtMs) {
    PREVIEW_BUDGET.remaining = PREVIEW_BUDGET.limit;
    PREVIEW_BUDGET.resetAtMs = 0;
  }
  // ponytail: /v2/rfq/levels requires no API key; draw from public IP quota first so 60/60 Partner Key credits stay free for firm quotes & chase
  const useAuthOverflow =
    Boolean(CONFIG.textileApiKey) && LADDER_BUDGET.remaining <= 4 && LADDER_BUDGET.resetAtMs > now;
  if (!useAuthOverflow && LADDER_BUDGET.remaining <= 2 && LADDER_BUDGET.resetAtMs > now) return cachedFresh();
  if (useAuthOverflow && PREVIEW_BUDGET.remaining <= 15 && PREVIEW_BUDGET.resetAtMs > now) return cachedFresh();

  const targetBudget = useAuthOverflow ? PREVIEW_BUDGET : LADDER_BUDGET;
  try {
    const headers = {};
    if (useAuthOverflow) headers.authorization = `Bearer ${CONFIG.textileApiKey}`;
    const res = await fetchImpl(`${CONFIG.textileApi}/v2/rfq/levels?chainId=${CONFIG.chainId}`, {
      headers,
      signal: AbortSignal.timeout(5500),
    });
    const limHdr = Number(res.headers.get('x-ratelimit-limit'));
    const remHdr = Number(res.headers.get('x-ratelimit-remaining'));
    const rstHdr = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(limHdr) && limHdr > 0) targetBudget.limit = limHdr;
    if (Number.isFinite(remHdr) && remHdr >= 0) targetBudget.remaining = remHdr;
    if (Number.isFinite(rstHdr) && rstHdr > 0) targetBudget.resetAtMs = Date.now() + rstHdr * 1000;
    if (res.status === 429) {
      targetBudget.remaining = 0;
      if (targetBudget.resetAtMs <= Date.now()) targetBudget.resetAtMs = Date.now() + 15_000;
      return cachedFresh();
    }
    if (!res.ok) {
      if (fetchImpl === fetch && res.status >= 500) ladderBackoffUntilMs = Date.now() + 8_000;
      return cachedFresh();
    }
    const json = await res.json().catch(() => null);
    const data = json?.data || json;
    if (!Array.isArray(data?.pairs)) return cachedFresh();
    if (fetchImpl === fetch) lastGoodLadder = { data, fetchedAtMs: Date.now() };
    return data;
  } catch {
    if (fetchImpl === fetch) ladderBackoffUntilMs = Date.now() + 1_200;
    return cachedFresh();
  }
}

// ponytail: evaluate exact Maker knots + concave midpoints across wide gaps while ALWAYS preserving sub-$1k micro-anchors
export function buildLadderCandidates(knotRaws, gridRaws, minRaw, maxRaw) {
  if (maxRaw < minRaw) return [];
  const validKnots = [...new Set(knotRaws.filter((v) => v >= minRaw && v <= maxRaw))].sort((a, b) =>
    a > b ? -1 : a < b ? 1 : 0
  );
  const denseKnots = [...validKnots];
  for (let i = 0; i + 1 < validKnots.length; i++) {
    if (validKnots[i] - validKnots[i + 1] >= 400_000000n) {
      denseKnots.push((validKnots[i] + validKnots[i + 1]) / 2n);
    }
  }
  denseKnots.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

  const kept = [];
  for (const k of denseKnots) {
    if (kept.length === 0 || (kept[kept.length - 1] - k >= 8_000000n && k * 100n <= kept[kept.length - 1] * 94n)) {
      kept.push(k);
    }
  }
  const validGrid = [...new Set(gridRaws.filter((v) => v >= minRaw && v <= maxRaw))].sort((a, b) =>
    a > b ? -1 : a < b ? 1 : 0
  );
  for (const g of validGrid) {
    const farFromAll = kept.every(
      (k) => (k > g ? k - g >= 12_000000n && g * 100n <= k * 90n : g - k >= 12_000000n && k * 100n <= g * 90n)
    );
    if (farFromAll) kept.push(g);
  }
  const sorted = kept.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  if (sorted.length <= 24) return sorted;
  const microTail = sorted.slice(-4);
  const headAndMid = sorted.slice(0, 20);
  return [...new Set([...headAndMid, ...microTail])].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

export function getMaxFlashSliceUsdt(token, cfg = CONFIG) {
  return token?.fxCode === 'USD'
    ? Number(cfg.maxUsdFlashSliceUsdt || cfg.maxFlashSliceUsdt || 35000)
    : Number(cfg.maxFlashSliceUsdt || 12000);
}

function computeDexProbeSellRaw(token) {
  const fallbackMid =
    token.symbol === 'WETH' ? 2500 : token.symbol === 'VGBP' ? 1.35 : token.symbol === 'CELO' ? 0.14 : token.symbol === 'COPM' ? 0.00025 : 1;
  const midUsd = Number(STATE.textileMids?.[token.symbol] || fallbackMid);
  const units = Math.max(1e-6, 15 / Math.max(1e-9, midUsd));
  return ethers.parseUnits(units.toFixed(Math.min(6, token.decimals)), token.decimals);
}

export async function scanTokenFromLadder(token, pairMap, maxUsdtBudget, quoteFn = queuedBestUniQuote) {
  const isFlashMode = Boolean(
    CONFIG.textileApiKey && CONFIG.flashRouterAddress && CONFIG.contracts.flashPools?.[token.symbol]
  );
  const flashCapUsdt = getMaxFlashSliceUsdt(token);
  const candidateSlices = isFlashMode
    ? [flashCapUsdt, 30000, 25000, 20000, 15000, 10000, 7000, 5000, 3500, 2500, 1500, 1000, 500, 200, 40].filter(
        (x, i, a) => x <= flashCapUsdt && a.indexOf(x) === i
      )
    : computeSliceSizesUsdt(maxUsdtBudget || token.probeUsdt, Math.min(CONFIG.maxSliceUsdt, token.probeUsdt));
  const maxCapUsdt = candidateSlices[0] || 25;
  const maxCapRaw = ethers.parseUnits(maxCapUsdt.toFixed(6), 6);
  const rows = [];

  const isDefaultQuoter = quoteFn === queuedBestUniQuote || quoteFn === bestUniQuote;
  const exitCacheEntry = dexSellExitCache.get(token.symbol);
  let hasDexSellExit;
  if (isDefaultQuoter && exitCacheEntry && Date.now() - exitCacheEntry.ts < 60_000) {
    hasDexSellExit = exitCacheEntry.ok;
  } else {
    const dexSellProbe = await quoteFn(token.address, CONFIG.contracts.usdt, computeDexProbeSellRaw(token));
    hasDexSellExit = dexSellProbe.amountOut > 0n;
    if (isDefaultQuoter) dexSellExitCache.set(token.symbol, { ok: hasDexSellExit, ts: Date.now() });
  }

  const usdtLower = CONFIG.contracts.usdt.toLowerCase();
  const tokLower = token.address.toLowerCase();

  // Direction 1: TEXTILE -> UNI (sell USDT, buy FX on Textile -> sell FX on Uniswap)
  const pT2U = pairMap.get(`${usdtLower}->${tokLower}`);
  if (!hasDexSellExit) {
    rows.push({
      corridor: `${token.symbol}/USDT`,
      symbol: token.symbol,
      direction: 'textile->uni',
      sizeUsdt: maxCapUsdt,
      expectedOutUsdt: 0,
      edgeUsd: 0,
      edgeBps: 0,
      sliceCandidatesUsdt: candidateSlices,
      status: 'ILLIQUID_DEX',
      note: 'no_uniswap_sell_exit',
    });
  } else if (!pT2U || !pT2U.levels?.length || BigInt(pT2U.maxSellAmount || 0) < 1_000000n) {
    rows.push({
      corridor: `${token.symbol}/USDT`,
      symbol: token.symbol,
      direction: 'textile->uni',
      sizeUsdt: maxCapUsdt,
      expectedOutUsdt: 0,
      edgeUsd: 0,
      edgeBps: 0,
      sliceCandidatesUsdt: candidateSlices,
      status: 'NO_MAKER',
      note: 'no_makers_online',
    });
  } else {
    const minSellRaw = BigInt(pT2U.minSellAmount || 1_000000);
    const availMaxRaw = (BigInt(pT2U.maxSellAmount) * 98n) / 100n;
    const effMaxRaw = availMaxRaw < maxCapRaw ? availMaxRaw : maxCapRaw;
    const floorRaw = effMaxRaw < 15_000000n ? minSellRaw : minSellRaw > 15_000000n ? minSellRaw : 15_000000n;
    const knotRaws = pT2U.levels.map((l) => BigInt(l.sellAmount || 0));
    const gridRaws = candidateSlices.map((u) => ethers.parseUnits(u.toFixed(6), 6));
    const testRaws = buildLadderCandidates([effMaxRaw, ...knotRaws], gridRaws, floorRaw, effMaxRaw);

    const evals = await Promise.all(
      testRaws.map(async (inRaw) => {
        const fxOutRaw = interpolateLadderBuyAmount(pT2U.levels, inRaw);
        if (fxOutRaw <= 0n) return null;
        const uniBack = await quoteFn(token.address, CONFIG.contracts.usdt, fxOutRaw);
        if (uniBack.amountOut <= 0n) return null;
        const inU = Number(inRaw) / 1e6;
        const outU = Number(uniBack.amountOut) / 1e6;
        return { inRaw, fxOutRaw, uniBack, inU, outU, edgeUsd: outU - inU };
      })
    );
    let best = null;
    for (const ev of evals) {
      if (ev && (!best || ev.edgeUsd > best.edgeUsd)) best = ev;
    }
    if (best) {
      const edgeBps = best.inU > 0 ? (best.edgeUsd / best.inU) * 10000 : 0;
      const t2uMinBps = isFlashMode ? (CONFIG.minFlashEdgeBps ?? 0.05) : CONFIG.minEdgeBps;
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        tokenAddress: token.address,
        decimals: token.decimals,
        direction: 'textile->uni',
        sizeUsdt: best.inU,
        amountInRaw: best.inRaw.toString(),
        midTokenRaw: best.fxOutRaw.toString(),
        expectedOutUsdt: best.outU,
        uniFee: best.uniBack.fee,
        edgeUsd: best.edgeUsd,
        edgeBps,
        sliceCandidatesUsdt: candidateSlices,
        scannedAtMs: Date.now(),
        status: best.edgeUsd >= CONFIG.minEdgeUsd && edgeBps >= t2uMinBps ? 'ACTIONABLE' : 'WATCH',
        note: `Ladder tier ($${best.inU.toFixed(2)})`,
      });
    }
  }

  // Direction 2: UNI -> TEXTILE (buy FX on Uniswap -> sell FX on Textile for USDT)
  const pU2T = pairMap.get(`${tokLower}->${usdtLower}`);
  const preBalUnits = Number(STATE.balances?.[token.symbol.toLowerCase()] || 0);
  const preMidUsd = Number(STATE.textileMids?.[token.symbol] || 0);
  const preBalUsd = preBalUnits * preMidUsd;
  if (!hasDexSellExit && preBalUsd < 6.0 && !isFlashMode) {
    rows.push({
      corridor: `${token.symbol}/USDT`,
      symbol: token.symbol,
      direction: 'uni->textile',
      sizeUsdt: maxCapUsdt,
      expectedOutUsdt: 0,
      edgeUsd: 0,
      edgeBps: 0,
      sliceCandidatesUsdt: candidateSlices,
      status: 'ILLIQUID_DEX',
      note: 'one_way_pool_blocked',
    });
  } else if (!pU2T || !pU2T.levels?.length || BigInt(pU2T.maxSellAmount || 0) <= 0n) {
    rows.push({
      corridor: `${token.symbol}/USDT`,
      symbol: token.symbol,
      direction: 'uni->textile',
      sizeUsdt: maxCapUsdt,
      expectedOutUsdt: 0,
      edgeUsd: 0,
      edgeBps: 0,
      sliceCandidatesUsdt: candidateSlices,
      status: 'NO_MAKER',
      note: 'no_makers_online',
    });
  } else {
    const maxLevelBuyRaw = pU2T.levels.reduce((m, l) => {
      const b = BigInt(l.buyAmount || 0);
      return b > m ? b : m;
    }, 0n);
    const topBookBuyUsdtRaw = (maxLevelBuyRaw * 98n) / 100n;
    const effMaxRaw = topBookBuyUsdtRaw > 0n && topBookBuyUsdtRaw < maxCapRaw ? topBookBuyUsdtRaw : maxCapRaw;
    const floorUsdtRaw = effMaxRaw < 15_000000n ? 1_000000n : 15_000000n;
    const knotUsdtRaws = pU2T.levels.map((l) => BigInt(l.buyAmount || 0));
    const gridRaws = candidateSlices.map((u) => ethers.parseUnits(u.toFixed(6), 6));
    const testRaws = buildLadderCandidates([effMaxRaw, ...knotUsdtRaws], gridRaws, floorUsdtRaw, effMaxRaw);

    const maxFxRaw = (BigInt(pU2T.maxSellAmount) * 99n) / 100n;
    const minFxRaw = BigInt(pU2T.minSellAmount || 1);
    const evals2 = await Promise.all(
      testRaws.map(async (inRaw) => {
        let effInRaw = inRaw;
        let uniBuy = await quoteFn(CONFIG.contracts.usdt, token.address, effInRaw);
        if (uniBuy.amountOut < minFxRaw) return null;
        if (uniBuy.amountOut > maxFxRaw) {
          effInRaw = (effInRaw * maxFxRaw) / uniBuy.amountOut;
          if (effInRaw <= 0n) return null;
          uniBuy = await quoteFn(CONFIG.contracts.usdt, token.address, effInRaw);
          if (uniBuy.amountOut < minFxRaw || uniBuy.amountOut > BigInt(pU2T.maxSellAmount)) return null;
        }
        const sellFxRaw = uniBuy.amountOut;
        const usdtOutRaw = interpolateLadderBuyAmount(pU2T.levels, sellFxRaw);
        if (usdtOutRaw <= 0n) return null;
        const inU = Number(effInRaw) / 1e6;
        const outU = Number(usdtOutRaw) / 1e6;
        return { inRaw: effInRaw, sellFxRaw, fee: uniBuy.fee, inU, outU, edgeUsd: outU - inU };
      })
    );
    let best2 = null;
    for (const ev of evals2) {
      if (ev && (!best2 || ev.edgeUsd > best2.edgeUsd)) best2 = ev;
    }
    if (best2) {
      const edgeBps = best2.inU > 0 ? (best2.edgeUsd / best2.inU) * 10000 : 0;
      const invCoversClip = isFlashMode || preBalUsd >= Math.max(6.0, best2.inU * 0.95);
      const minReqBps = isFlashMode
        ? (CONFIG.minFlashEdgeBps ?? 0.05)
        : invCoversClip
          ? CONFIG.minEdgeBps
          : CONFIG.minUniToTextileDexFirstBps;
      const minReqUsd = invCoversClip ? CONFIG.minEdgeUsd : CONFIG.minUniToTextileDexFirstUsd;
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        tokenAddress: token.address,
        decimals: token.decimals,
        direction: 'uni->textile',
        sizeUsdt: best2.inU,
        amountInRaw: best2.inRaw.toString(),
        midTokenRaw: best2.sellFxRaw.toString(),
        expectedOutUsdt: best2.outU,
        uniFee: best2.fee,
        edgeUsd: best2.edgeUsd,
        edgeBps,
        sliceCandidatesUsdt: candidateSlices,
        scannedAtMs: Date.now(),
        status: best2.edgeUsd >= minReqUsd && edgeBps >= minReqBps ? 'ACTIONABLE' : 'WATCH',
        note: `Ladder tier ($${best2.inU.toFixed(2)})`,
      });
    }
  }

  return rows;
}

/**
 * Scan a single token across one or both directions with Multi-Slice (100% / 75% / 50% / 35% / 20%) + adaptive availableSellAmount sizing.
 */
async function scanCorridor(token, maxUsdtBudget, onlyDirection = null, opts = {}) {
  const isFlashMode = Boolean(
    CONFIG.textileApiKey && CONFIG.flashRouterAddress && CONFIG.contracts.flashPools?.[token.symbol]
  );
  const flashCapUsdt = getMaxFlashSliceUsdt(token);
  const candidateSlices = isFlashMode
    ? [flashCapUsdt, 15000, 8000, 5000, 3500, 2000, 1250, 750, 350, 100].filter(
        (x, i, a) => x <= flashCapUsdt && a.indexOf(x) === i
      )
    : computeSliceSizesUsdt(maxUsdtBudget || token.probeUsdt, Math.min(CONFIG.maxSliceUsdt, token.probeUsdt));
  const probeUsdt = candidateSlices[0] || 25;
  const usdtInRaw = ethers.parseUnits(probeUsdt.toFixed(6), 6);
  const rows = [];

  // ponytail: zero-HTTP-cost RPC liquidity pre-check — skips spending Textile preview quota on one-way/empty DEX pools (e.g. wBRL/USDT)
  const dexSellProbe = await bestUniQuote(token.address, CONFIG.contracts.usdt, computeDexProbeSellRaw(token));
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
      const depthKey1 = `${token.symbol}:textile->uni`;
      const cachedDepth1 = corridorDepthCache.get(depthKey1);
      let actualInRaw =
        cachedDepth1 && Date.now() - cachedDepth1.ts < DEPTH_CACHE_TTL_MS && cachedDepth1.usdtRaw < usdtInRaw
          ? cachedDepth1.usdtRaw
          : usdtInRaw;
      let preview = await textilePreview(CONFIG.contracts.usdt, token.address, actualInRaw, opts);

      if (preview && preview.availableSellAmount && BigInt(preview.availableSellAmount) >= 1000000n) {
        const avail = BigInt(preview.availableSellAmount);
        if (preview.status !== 'preview' || avail < actualInRaw) {
          const resized = (avail * 98n) / 100n;
          if (resized >= 1000000n) {
            actualInRaw = resized;
            corridorDepthCache.set(depthKey1, { usdtRaw: resized, ts: Date.now() });
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
          const subFracs = actualInRaw > 500000000n ? [75n, 50n, 33n, 20n, 10n, 4n, 2n] : [75n, 50n, 35n, 20n];
          const subChecks = await Promise.all(
            subFracs.map(async (frac) => {
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

          // ponytail: probe ~28% (~$100 sweet spot) on cNGN & wARS down to -16 bps (with 12s dry cache) to snipe stacked $100 Maker tiers
          const topGateBps = token.symbol === 'cNGN' || token.symbol === 'wARS' ? -16.0 : -2.5;
          const currBps = Number(bestInRaw) > 0 ? (bestEdgeUsd / (Number(bestInRaw) / 1e6)) * 10000 : -999;
          const topNegKey1 = `${token.symbol}:t2u`;
          if (
            bestEdgeUsd < CONFIG.minEdgeUsd &&
            currBps > topGateBps &&
            actualInRaw >= 40000000n &&
            (opts.priority || ((topProbeNegCache.get(topNegKey1) || 0) <= Date.now() && PREVIEW_BUDGET.remaining >= 24))
          ) {
            const topSliceInRaw = actualInRaw > 450000000n ? 100000000n : (actualInRaw * 28n) / 100n;
            const topPreview = await textilePreview(CONFIG.contracts.usdt, token.address, topSliceInRaw, opts).catch(() => null);
            if (topPreview && topPreview.status === 'preview' && topPreview.buyAmount) {
              const topTokenRaw = BigInt(topPreview.buyAmount);
              const topUni = await bestUniQuote(token.address, CONFIG.contracts.usdt, topTokenRaw);
              const topEdgeUsd = Number(topUni.amountOut) / 1e6 - Number(topSliceInRaw) / 1e6;
              if (topEdgeUsd >= CONFIG.minEdgeUsd) {
                topProbeNegCache.delete(topNegKey1);
              } else {
                topProbeNegCache.set(topNegKey1, Date.now() + TOP_PROBE_NEG_TTL_MS);
              }
              if (topEdgeUsd > bestEdgeUsd) {
                bestInRaw = topSliceInRaw;
                bestTokenOutRaw = topTokenRaw;
                bestUniBack = topUni;
                bestEdgeUsd = topEdgeUsd;
                sliceLabel = '28% top-of-book ($' + (Number(topSliceInRaw) / 1e6).toFixed(2) + ')';
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
          scannedAtMs: Date.now(),
          status:
            edgeUsd >= CONFIG.minEdgeUsd &&
            edgeBps >= (isFlashMode ? (CONFIG.minFlashEdgeBps ?? 0.05) : CONFIG.minEdgeBps)
              ? 'ACTIONABLE'
              : 'WATCH',
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
    if (!hasDexSellExit && preBalUsd < 6.0 && !isFlashMode) {
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
      const depthKey2 = `${token.symbol}:uni->textile`;
      const cachedDepth2 = corridorDepthCache.get(depthKey2);
      let actualUsdtInRaw =
        cachedDepth2 && Date.now() - cachedDepth2.ts < DEPTH_CACHE_TTL_MS && cachedDepth2.usdtRaw < usdtInRaw
          ? cachedDepth2.usdtRaw
          : usdtInRaw;
      const uniBuy = await bestUniQuote(CONFIG.contracts.usdt, token.address, actualUsdtInRaw);
      if (uniBuy.amountOut > 0n) {
        let preview = await textilePreview(token.address, CONFIG.contracts.usdt, uniBuy.amountOut, opts);
        let actualTokenRaw = uniBuy.amountOut;

        if (preview && preview.availableSellAmount && BigInt(preview.availableSellAmount) > 0n) {
          const availToken = BigInt(preview.availableSellAmount);
          if (preview.status !== 'preview' || availToken < uniBuy.amountOut) {
            const ratio = Number(availToken) / Number(uniBuy.amountOut);
            const resizedUsdt = BigInt(Math.floor(Number(actualUsdtInRaw) * ratio * 0.98));
            if (resizedUsdt >= 1000000n) {
              const reUni = await bestUniQuote(CONFIG.contracts.usdt, token.address, resizedUsdt);
              if (reUni.amountOut > 0n) {
                actualUsdtInRaw = resizedUsdt;
                actualTokenRaw = reUni.amountOut;
                corridorDepthCache.set(depthKey2, { usdtRaw: resizedUsdt, ts: Date.now() });
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
            const subFracs2 = actualUsdtInRaw > 500000000n ? [75n, 50n, 33n, 20n, 10n, 4n, 2n] : [75n, 50n, 35n, 20n];
            const subSlices = await Promise.all(
              subFracs2.map(async (frac) => {
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

            const invCoversSub = isFlashMode || preBalUsd >= Math.max(6.0, (Number(bestInRaw) / 1e6) * 0.95);
            const subMinReqUsd = invCoversSub ? CONFIG.minEdgeUsd : CONFIG.minUniToTextileDexFirstUsd;
            const topGateBps = token.symbol === 'cNGN' || token.symbol === 'wARS' ? -16.0 : -2.5;
            const currBps = Number(bestInRaw) > 0 ? (bestEdgeUsd / (Number(bestInRaw) / 1e6)) * 10000 : -999;
            const topNegKey2 = `${token.symbol}:u2t`;
            if (
              bestEdgeUsd < subMinReqUsd &&
              currBps > topGateBps &&
              actualUsdtInRaw >= 40000000n &&
              (opts.priority || ((topProbeNegCache.get(topNegKey2) || 0) <= Date.now() && PREVIEW_BUDGET.remaining >= 24))
            ) {
              const topInRaw = actualUsdtInRaw > 450000000n ? 100000000n : (actualUsdtInRaw * 28n) / 100n;
              const topUni = await bestUniQuote(CONFIG.contracts.usdt, token.address, topInRaw);
              if (topUni.amountOut > 0n) {
                const topPrev = await textilePreview(token.address, CONFIG.contracts.usdt, topUni.amountOut, opts).catch(() => null);
                if (topPrev && topPrev.status === 'preview' && topPrev.buyAmount) {
                  const topOutRaw = BigInt(topPrev.buyAmount);
                  const topEdgeUsd = Number(topOutRaw) / 1e6 - Number(topInRaw) / 1e6;
                  if (topEdgeUsd >= subMinReqUsd) {
                    topProbeNegCache.delete(topNegKey2);
                  } else {
                    topProbeNegCache.set(topNegKey2, Date.now() + TOP_PROBE_NEG_TTL_MS);
                  }
                  if (topEdgeUsd > bestEdgeUsd) {
                    bestInRaw = topInRaw;
                    bestTokenRaw = topUni.amountOut;
                    bestOutRaw = topOutRaw;
                    bestFee = topUni.fee;
                    bestEdgeUsd = topEdgeUsd;
                    noteLabel = '28% top-of-book ($' + (Number(topInRaw) / 1e6).toFixed(2) + ')';
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
          const invCoversClip = isFlashMode || localBalUnits * localMidUsd >= Math.max(6.0, usdtInNum * 0.95);
          const minReqBps = isFlashMode
            ? (CONFIG.minFlashEdgeBps ?? 0.05)
            : invCoversClip
              ? CONFIG.minEdgeBps
              : CONFIG.minUniToTextileDexFirstBps;
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
            scannedAtMs: Date.now(),
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
  ensureFlashRouterDeployed,
  settlePendingHoldings,
  executeOpportunity,
  autoManageTreasuryInventory,
  persistMarkoutRecords,
  loadOnChainHistory,
} = executionManager;

let isBusy = false;
function pushArbExecutionBounded(rec) {
  STATE.arbExecutions.unshift(rec);
  if (STATE.arbExecutions.length > 300) STATE.arbExecutions.length = 300;
}
let isShuttingDown = false;
let lastScanDoneMs = Date.now();
let cachedRpcBalances = { data: null, ts: 0 };
let bgPriceRefreshInFlight = false;
let bgFxRefreshInFlight = false;

async function fetchRpcBundleMulticall(needFreshBalances, usatTok) {
  const poolSpecs = [
    { addr: CONFIG.contracts.cngnUsdtPool, token0IsUsdt: true, dec: 6, fallback: 0.00072538 },
    { addr: CONFIG.contracts.warsUsdtPool, token0IsUsdt: false, dec: 18, fallback: 0.00067808 },
    { addr: CONFIG.contracts.flashPools.USDC, token0IsUsdt: true, dec: 6, fallback: 1.0 },
    { addr: usatTok ? CONFIG.contracts.flashPools.USAT : CONFIG.contracts.flashPools.USDC, token0IsUsdt: true, dec: 6, fallback: 1.0 },
    { addr: CONFIG.contracts.flashPools.CELO, token0IsUsdt: false, dec: 18, fallback: 0.14 },
    { addr: CONFIG.contracts.flashPools.VGBP, token0IsUsdt: true, dec: 18, fallback: 1.35 },
    { addr: CONFIG.contracts.flashPools.WETH, token0IsUsdt: true, dec: 18, fallback: 2500.0 },
    { addr: CONFIG.contracts.flashPools.COPM, token0IsUsdt: true, dec: 18, fallback: 0.00025 },
  ];
  const slot0Data = poolIface.encodeFunctionData('slot0');
  const calls = poolSpecs.map((p) => ({ target: p.addr, allowFailure: true, callData: slot0Data }));
  if (needFreshBalances) {
    const balData = erc20Iface.encodeFunctionData('balanceOf', [CONFIG.agentWallet]);
    const tokAddrs = [
      CONFIG.contracts.usdt,
      CONFIG.tokens[0].address,
      CONFIG.tokens[1].address,
      CONFIG.tokens[2].address,
      CONFIG.tokens[3].address,
      usatTok ? usatTok.address : CONFIG.contracts.usdt,
    ];
    for (const ta of tokAddrs) calls.push({ target: ta, allowFailure: true, callData: balData });
    calls.push({
      target: CONFIG.contracts.multicall3,
      allowFailure: true,
      callData: multicall3Iface.encodeFunctionData('getEthBalance', [CONFIG.agentWallet]),
    });
  }

  const [rawMc, feeData] = await Promise.all([
    provider.call({
      to: CONFIG.contracts.multicall3,
      data: multicall3Iface.encodeFunctionData('aggregate3', [calls]),
    }),
    !cachedGasPrice.value || Date.now() - cachedGasPrice.ts >= 30_000
      ? provider.getFeeData().catch(() => null)
      : Promise.resolve(null),
  ]);
  const [resArr] = multicall3Iface.decodeFunctionResult('aggregate3', rawMc);
  const mids = poolSpecs.map((spec, idx) => {
    const r = resArr[idx];
    if (r?.success && r.returnData && r.returnData.length >= 66) {
      try {
        const [sqrtPriceX96] = poolIface.decodeFunctionResult('slot0', r.returnData);
        const mid = decodeSqrtPriceToMid(sqrtPriceX96, spec.token0IsUsdt, spec.dec);
        if (Number.isFinite(mid) && mid > 0) return mid;
      } catch {}
    }
    return spec.fallback;
  });
  if (!usatTok) mids[3] = 1.0;

  let balTuple = cachedRpcBalances.data;
  if (needFreshBalances) {
    const decodeBal = (idx) => {
      const r = resArr[idx];
      if (r?.success && r.returnData && r.returnData.length >= 66) {
        return erc20Iface.decodeFunctionResult('balanceOf', r.returnData)[0];
      }
      return 0n;
    };
    const ethRes = resArr[14];
    const celoBal =
      ethRes?.success && ethRes.returnData && ethRes.returnData.length >= 66
        ? multicall3Iface.decodeFunctionResult('getEthBalance', ethRes.returnData)[0]
        : 0n;
    balTuple = [
      decodeBal(8),
      decodeBal(9),
      decodeBal(10),
      decodeBal(11),
      decodeBal(12),
      usatTok ? decodeBal(13) : 0n,
      celoBal,
    ];
  }
  return [balTuple, ...mids, feeData];
}

export async function runSingleScan() {
  if (isBusy || isShuttingDown) return STATE;
  isBusy = true;
  try {
    if (CONFIG.liveTrading && wallet && !STATE.pendingSettledOnce) {
      STATE.pendingSettledOnce = true;
      try {
        await settlePendingHoldings();
      } catch (err) {
        console.error(`[SETTLE-ERR] ${err.message}`);
      }
    }

    const usdtC = new ethers.Contract(CONFIG.contracts.usdt, ERC20_ABI, provider);
    const usatTok = CONFIG.tokens.find((t) => t.symbol === 'USAT');

    let usdt = 97.6;
    let cngn = 25020.0;
    let wars = 22191.0;
    let wbrl = 390.6;
    let usdc = 15.0;
    let usat = 0.0;
    let celo = 10.6;
    let uniCngnMid = 0.00072538;
    let uniWarsMid = 0.00067808;
    let uniUsdcMid = 1.0;
    let uniUsatMid = 1.0;
    let uniCeloMid = 0.14;
    let uniVgbpMid = 1.35;
    let uniWethMid = 2500.0;
    let uniCopmMid = 0.00025;

    // ponytail: keep slow /price (1.6s) & dolarapi (0.9s) refreshes off the critical path after boot; read 8 slot0 + 7 balances in ONE Multicall3 eth_call (~500ms vs 1.73s)
    if (STATE.scanCount > 0) {
      if (!bgFxRefreshInFlight && Date.now() - cachedOffChainFx.fetchedAt >= 300_000) {
        bgFxRefreshInFlight = true;
        fetchOffChainFxRates().catch(() => {}).finally(() => { bgFxRefreshInFlight = false; });
      }
      if (!bgPriceRefreshInFlight && Date.now() - cachedTextileMids.fetchedAt >= 15_000) {
        bgPriceRefreshInFlight = true;
        fetchTextileCorridorPrices()
          .then((m) => { STATE.textileMids = { ...STATE.textileMids, ...m }; })
          .catch(() => {})
          .finally(() => { bgPriceRefreshInFlight = false; });
      }
    }

    const needFreshBalances = !cachedRpcBalances.data || Date.now() - cachedRpcBalances.ts >= 12_000;
    const [offChainFx, fetchedTextileMids, ladderData, rpcBundle] = await Promise.all([
      STATE.scanCount === 0 ? fetchOffChainFxRates() : Promise.resolve(cachedOffChainFx),
      STATE.scanCount === 0 ? fetchTextileCorridorPrices() : Promise.resolve(cachedTextileMids.data),
      fetchTextileLadder(),
      fetchRpcBundleMulticall(needFreshBalances, usatTok).catch((rpcErr) => {
        console.warn(`[RPC-FALLBACK] Using cached reference state (${rpcErr.message?.slice(0, 60)})`);
        return null;
      }),
    ]);
    STATE.textileMids = { ...STATE.textileMids, ...fetchedTextileMids };

    if (rpcBundle) {
      const [
        balTuple,
        poolCngnMid,
        poolWarsMid,
        poolUsdcMid,
        poolUsatMid,
        poolCeloMid,
        poolVgbpMid,
        poolWethMid,
        poolCopmMid,
        feeData,
      ] = rpcBundle;
      if (needFreshBalances && balTuple) {
        cachedRpcBalances = { data: balTuple, ts: Date.now() };
      }
      if (feeData?.gasPrice) {
        cachedGasPrice = { value: feeData.gasPrice, ts: Date.now() };
      }
      const [usdtRaw, cngnRaw, warsRaw, wbrlRaw, usdcRaw, usatRaw, celoRaw] = balTuple;
      usdt = Number(usdtRaw) / 1e6;
      cngn = Number(cngnRaw) / 1e6;
      wars = Number(warsRaw) / 1e18;
      wbrl = Number(wbrlRaw) / 1e18;
      usdc = Number(usdcRaw) / 1e6;
      usat = Number(usatRaw) / 1e6;
      celo = Number(celoRaw) / 1e18;
      uniCngnMid = poolCngnMid;
      uniWarsMid = poolWarsMid;
      uniUsdcMid = poolUsdcMid;
      uniUsatMid = poolUsatMid;
      uniCeloMid = poolCeloMid;
      uniVgbpMid = poolVgbpMid;
      uniWethMid = poolWethMid;
      uniCopmMid = poolCopmMid;
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

    // ponytail: 1.8s single-GET `/v2/rfq/levels` aggregator ladder scan — evaluates all 4 corridors & exact Maker depth knots in 1 HTTP call (falling back to `/preview` if ladder unavailable)
    const liquidUsdtBudget = Math.max(1, usdt);
    const cngnMoved =
      !STATE.lastSlot0Mids ||
      Math.abs(uniCngnMid - STATE.lastSlot0Mids.cNGN) / Math.max(1e-12, uniCngnMid) >= 0.000015;
    const warsMoved =
      !STATE.lastSlot0Mids ||
      Math.abs(uniWarsMid - STATE.lastSlot0Mids.wARS) / Math.max(1e-12, uniWarsMid) >= 0.000015;
    const usdcMoved =
      !STATE.lastSlot0Mids ||
      Math.abs(uniUsdcMid - (STATE.lastSlot0Mids.USDC || 1.0)) / Math.max(1e-12, uniUsdcMid) >= 0.00001;
    const usatMoved =
      Boolean(usatTok) &&
      (!STATE.lastSlot0Mids ||
        Math.abs(uniUsatMid - (STATE.lastSlot0Mids.USAT || 1.0)) / Math.max(1e-12, uniUsatMid) >= 0.00001);
    const celoMoved =
      !STATE.lastSlot0Mids ||
      Math.abs(uniCeloMid - (STATE.lastSlot0Mids.CELO || 0.14)) / Math.max(1e-12, uniCeloMid) >= 0.00015;
    const vgbpMoved =
      !STATE.lastSlot0Mids ||
      Math.abs(uniVgbpMid - (STATE.lastSlot0Mids.VGBP || 1.35)) / Math.max(1e-12, uniVgbpMid) >= 0.00015;
    const wethMoved =
      !STATE.lastSlot0Mids ||
      Math.abs(uniWethMid - (STATE.lastSlot0Mids.WETH || 2500.0)) / Math.max(1e-12, uniWethMid) >= 0.00015;
    const copmMoved =
      !STATE.lastSlot0Mids ||
      Math.abs(uniCopmMid - (STATE.lastSlot0Mids.COPM || 0.00025)) / Math.max(1e-12, uniCopmMid) >= 0.00015;
    STATE.lastSlot0Mids = {
      cNGN: uniCngnMid,
      wARS: uniWarsMid,
      USDC: uniUsdcMid,
      USAT: uniUsatMid,
      CELO: uniCeloMid,
      VGBP: uniVgbpMid,
      WETH: uniWethMid,
      COPM: uniCopmMid,
    };

    const isFlashReady = Boolean(CONFIG.textileApiKey && CONFIG.flashRouterAddress);
    const fullScanUniverse = isFlashReady ? [...CONFIG.tokens, ...(CONFIG.extraFlashTokens || [])] : CONFIG.tokens;

    if (ladderData?.pairs?.length) {
      const ladderChanged = !STATE.lastLadderAsOf || ladderData.asOf !== STATE.lastLadderAsOf;
      STATE.lastLadderAsOf = ladderData.asOf || '';
      const hasCachedRows = Object.keys(STATE.corridorRowCache).length > 0;
      if (
        STATE.scanCount === 0 ||
        ladderChanged ||
        cngnMoved ||
        warsMoved ||
        usdcMoved ||
        usatMoved ||
        celoMoved ||
        vgbpMoved ||
        wethMoved ||
        copmMoved ||
        !hasCachedRows
      ) {
        const pairMap = new Map();
        for (const pItem of ladderData.pairs) {
          if (pItem?.sellToken && pItem?.buyToken) {
            pairMap.set(`${pItem.sellToken.toLowerCase()}->${pItem.buyToken.toLowerCase()}`, pItem);
          }
        }
        const ladderBatches = await Promise.all(
          fullScanUniverse.map((t) => scanTokenFromLadder(t, pairMap, liquidUsdtBudget))
        );
        fullScanUniverse.forEach((tok, idx) => {
          STATE.corridorRowCache[tok.symbol] = ladderBatches[idx] || [];
        });
      }
    } else {
      let activeTokens = CONFIG.tokens;
      if (STATE.scanCount > 0 && CONFIG.tokens.length > 2) {
        const quotaHealthy = STATE.scanCount % 2 === 0;
        const hotTokens = CONFIG.tokens.filter((t) => {
          if (t.symbol === 'cNGN') return cngnMoved || quotaHealthy;
          if (t.symbol === 'wARS') return warsMoved || quotaHealthy;
          if (t.symbol === 'USAT') return usatMoved || quotaHealthy;
          if (t.symbol === 'USDC' && usdcMoved) return true;
          return false;
        });
        const secondaryTokens = CONFIG.tokens.filter(
          (t) => t.symbol !== 'cNGN' && t.symbol !== 'wARS' && t.symbol !== 'USAT' && !(t.symbol === 'USDC' && usdcMoved)
        );
        const rotated =
          secondaryTokens.length > 0 && STATE.scanCount % 4 === 0
            ? [secondaryTokens[Math.floor(STATE.scanCount / 4) % secondaryTokens.length]]
            : [];
        activeTokens = [...hotTokens, ...rotated];
      }
      const scanBatches = await Promise.all(activeTokens.map((t) => scanCorridor(t, liquidUsdtBudget)));
      activeTokens.forEach((tok, idx) => {
        const freshRows = scanBatches[idx] || [];
        if (!freshRows.every((r) => r.status === 'DEFERRED_QUOTA')) {
          STATE.corridorRowCache[tok.symbol] = freshRows.filter((r) => r.status !== 'DEFERRED_QUOTA');
        }
      });
    }

    const rank = (s) => (s === 'ACTIONABLE' ? 0 : s === 'WATCH' ? 1 : s === 'NO_MAKER' ? 2 : 3);
    const allRows = fullScanUniverse
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
      `[SCAN #${STATE.scanCount}] Total=$${totalUsd.toFixed(2)} (USDT=$${usdt.toFixed(2)} cNGN=${cngn.toFixed(0)} wARS=${wars.toFixed(0)} wBRL=${wbrl.toFixed(1)} USDC=$${usdc.toFixed(2)}) quota=${PREVIEW_BUDGET.remaining}/${PREVIEW_BUDGET.limit}(lad=${LADDER_BUDGET.remaining}) | best=${bestRow ? `${bestRow.corridor}(${bestRow.direction}) $${bestRow.sizeUsdt.toFixed(1)} edge=$${bestRow.edgeUsd.toFixed(4)} (${bestRow.edgeBps.toFixed(2)}bps) [${bestRow.status}]` : 'none'}`
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
            cachedRpcBalances = { data: null, ts: 0 };
            STATE.lastLadderAsOf = '';
            pushArbExecutionBounded(execRec);
            STATE.circuitBreaker = evaluateCircuitBreaker(STATE.arbExecutions, Date.now(), CONFIG, sessionStartMs);
            // ponytail: bidirectional 0.65s hot-corridor chase catches both Maker reloads and reverse pool whip-saws
            const corridorTok = fullScanUniverse.find((t) => t.symbol === candidate.symbol);
            if (corridorTok && execRec.edgeUsd > 0 && !STATE.circuitBreaker.tripped && CONFIG.chaseIntervalMs > 0) {
              for (let chaseIdx = 1; chaseIdx <= CONFIG.maxChaseIterations; chaseIdx++) {
                await new Promise((res) => setTimeout(res, CONFIG.chaseIntervalMs));
                const isFlashChase = Boolean(
                  CONFIG.textileApiKey && CONFIG.flashRouterAddress && CONFIG.contracts.flashPools?.[corridorTok.symbol]
                );
                let freshUsdt = usdt;
                let freshCelo = celo;
                if (!isFlashChase || celo < 1.0) {
                  const [freshUsdtRaw, freshCeloRaw] = await Promise.all([
                    usdtC.balanceOf(CONFIG.agentWallet),
                    provider.getBalance(CONFIG.agentWallet),
                  ]).catch(() => [0n, 0n]);
                  freshUsdt = Number(freshUsdtRaw) / 1e6;
                  freshCelo = Number(freshCeloRaw) / 1e18;
                }
                if ((!isFlashChase && freshUsdt < 10) || freshCelo < 0.15) break;
                let chaseRows = null;
                if (isFlashChase) {
                  const chaseLadder = await fetchTextileLadder();
                  if (chaseLadder?.pairs?.length) {
                    const chasePairMap = new Map();
                    for (const pItem of chaseLadder.pairs) {
                      if (pItem?.sellToken && pItem?.buyToken) {
                        chasePairMap.set(`${pItem.sellToken.toLowerCase()}->${pItem.buyToken.toLowerCase()}`, pItem);
                      }
                    }
                    chaseRows = await scanTokenFromLadder(corridorTok, chasePairMap, Math.max(1, freshUsdt));
                  }
                }
                if (!chaseRows) {
                  chaseRows = await scanCorridor(corridorTok, freshUsdt, null, { priority: true });
                }
                const chaseMinBps = isFlashChase ? (CONFIG.minFlashEdgeBps ?? 0.05) : CONFIG.minEdgeBps;
                const chaseOpp = chaseRows
                  .filter((r) => r.status === 'ACTIONABLE' && r.edgeUsd >= CONFIG.minEdgeUsd && r.edgeBps >= chaseMinBps)
                  .sort((a, b) => b.edgeUsd - a.edgeUsd)[0];
                if (!chaseOpp) break;
                console.log(
                  `[CHASE #${chaseIdx}/${CONFIG.maxChaseIterations}] ${chaseOpp.corridor}(${chaseOpp.direction}) $${chaseOpp.sizeUsdt.toFixed(2)} estEdge=+$${chaseOpp.edgeUsd.toFixed(4)} (+${chaseOpp.edgeBps.toFixed(2)} bps)`
                );
                const chaseExec = await executeOpportunity(chaseOpp);
                if (!chaseExec) break;
                pushArbExecutionBounded(chaseExec);
                STATE.circuitBreaker = evaluateCircuitBreaker(STATE.arbExecutions, Date.now(), CONFIG, sessionStartMs);
                if (chaseExec.edgeUsd <= 0 || STATE.circuitBreaker.tripped) break;
              }
            }
            if (STATE.circuitBreaker.tripped) break;
          }
        } catch (err) {
          console.error(`[EXEC-ERR] ${err.message}`);
        }
      }
    }

    if (!arbExecutedThisTick && CONFIG.liveTrading && process.env.AUTO_REFILL === '1' && wallet) {
      try {
        const treasuryRec = await autoManageTreasuryInventory({ usdt, cngn, wars, wbrl, usdc, celo, uniCngnMid, uniWarsMid });
        if (treasuryRec) {
          cachedRpcBalances = { data: null, ts: 0 };
          pushArbExecutionBounded(treasuryRec);
        }
      } catch (err) {
        console.error(`[TREASURY-ERR] ${err.message}`);
      }
    }

    return STATE;
  } finally {
    lastScanDoneMs = Date.now();
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

const UNI_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
let activeSwapWs = null;
let lastWsStrikeAtBySym = new Map();

// ponytail: real-time Celo WebSocket Swap push (0ms wakeup on DEX whale swaps -> ~500ms Block N+1 flash strike against cached ladder)
function startCeloSwapStream() {
  if (typeof WebSocket === 'undefined' || !CONFIG.wsRpcUrl || isShuttingDown) return;
  const poolToToken = new Map();
  const allFlashUniverse = [...CONFIG.tokens, ...(CONFIG.extraFlashTokens || [])];
  for (const tok of allFlashUniverse) {
    const pAddr = CONFIG.contracts.flashPools?.[tok.symbol];
    if (pAddr && tok.symbol !== 'wBRL') poolToToken.set(pAddr.toLowerCase(), tok);
  }
  const poolAddrs = [...poolToToken.keys()];
  if (poolAddrs.length === 0) return;

  const connect = () => {
    if (isShuttingDown) return;
    let ws;
    let lastWsMsgMs = Date.now();
    try {
      ws = new WebSocket(CONFIG.wsRpcUrl);
      activeSwapWs = ws;
    } catch {
      setTimeout(connect, 5_000).unref?.();
      return;
    }
    const wsWatch = setInterval(() => {
      if (Date.now() - lastWsMsgMs > 600_000) {
        try { ws.close(); } catch {}
      }
    }, 60_000);
    wsWatch.unref?.();
    ws.addEventListener('open', () => {
      lastWsMsgMs = Date.now();
      try {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_subscribe',
            params: ['logs', { address: poolAddrs, topics: [UNI_SWAP_TOPIC] }],
          })
        );
      } catch {}
    });
    ws.addEventListener('message', async (ev) => {
      lastWsMsgMs = Date.now();
      if (isShuttingDown) return;
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg?.method !== 'eth_subscription') return;
      const poolLower = String(msg?.params?.result?.address || '').toLowerCase();
      const tok = poolToToken.get(poolLower);
      if (!tok) return;
      STATE.lastSlot0Mids = null;
      const now = Date.now();
      if (now - (lastWsStrikeAtBySym.get(tok.symbol) || 0) < 450) return;
      lastWsStrikeAtBySym.set(tok.symbol, now);
      if (isBusy) return;

      if (
        CONFIG.liveTrading &&
        wallet &&
        CONFIG.textileApiKey &&
        CONFIG.flashRouterAddress &&
        (STATE.balances?.celo ?? 10) >= 0.15 &&
        !STATE.circuitBreaker?.tripped &&
        lastGoodLadder.data?.pairs?.length &&
        now - lastGoodLadder.fetchedAtMs <= 8_000
      ) {
        isBusy = true;
        try {
          const pairMap = new Map();
          for (const pItem of lastGoodLadder.data.pairs) {
            if (pItem?.sellToken && pItem?.buyToken) {
              pairMap.set(`${pItem.sellToken.toLowerCase()}->${pItem.buyToken.toLowerCase()}`, pItem);
            }
          }
          const rows = await scanTokenFromLadder(tok, pairMap, Math.max(1, STATE.balances?.usdt || 100));
          STATE.corridorRowCache[tok.symbol] = rows;
          const minBps = CONFIG.minFlashEdgeBps ?? 0.05;
          const opp = rows
            .filter((r) => r.status === 'ACTIONABLE' && r.edgeUsd >= CONFIG.minEdgeUsd && r.edgeBps >= minBps)
            .sort((a, b) => b.edgeUsd - a.edgeUsd)[0];
          if (opp) {
            console.log(
              `[WS-STRIKE] Instant Swap push on ${opp.corridor}(${opp.direction}) $${opp.sizeUsdt.toFixed(2)} estEdge=+$${opp.edgeUsd.toFixed(4)} (+${opp.edgeBps.toFixed(2)} bps)`
            );
            const execRec = await executeOpportunity(opp);
            if (execRec) {
              cachedRpcBalances = { data: null, ts: 0 };
              STATE.lastLadderAsOf = '';
              pushArbExecutionBounded(execRec);
              const sessionStartMs = Date.parse(STATE.startedAt) || 0;
              STATE.circuitBreaker = evaluateCircuitBreaker(STATE.arbExecutions, Date.now(), CONFIG, sessionStartMs);
            }
          }
        } catch (err) {
          console.error(`[WS-STRIKE-ERR] ${err.message}`);
        } finally {
          isBusy = false;
        }
      } else {
        runSingleScan().catch(() => {});
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(wsWatch);
      if (activeSwapWs === ws) activeSwapWs = null;
      if (!isShuttingDown) setTimeout(connect, 3_000).unref?.();
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  };
  connect();
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
      flashAggregatorConfigured: Boolean(CONFIG.textileApiKey),
      flashRouterAddress: CONFIG.flashRouterAddress || (CONFIG.textileApiKey ? 'AUTO_DEPLOY_ON_BOOT' : 'DISABLED_EOA_MODE'),
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

  const gracefulExit = (sig) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try { activeSwapWs?.close(); } catch {}
    console.log(`[SKEW-DESK] ${sig} received; draining any in-flight 2-leg trade before exit...`);
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (!isBusy || Date.now() - t0 > 11000) {
        clearInterval(poll);
        process.exit(0);
      }
    }, 150);
  };
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));
  process.on('SIGINT', () => gracefulExit('SIGINT'));

  await ensureFlashRouterDeployed().catch((e) => console.error('[FLASH-ROUTER-ERR]', e.message));
  ensureErc8004Metadata().catch(() => {});
  loadOnChainHistory().catch(() => {});
  startCeloSwapStream();
  runSingleScan().catch((e) => console.error('[SCAN-ERR]', e.message));
  setInterval(() => runSingleScan().catch((e) => console.error('[SCAN-ERR]', e.message)), CONFIG.scanIntervalMs);
  setInterval(() => loadOnChainHistory().catch(() => {}), 60000);
  // ponytail: self-healing deadlock breaker — if isBusy wedges >90s on a hung socket, exit cleanly so cron/systemd restarts immediately
  setInterval(() => {
    if (!isShuttingDown && Date.now() - lastScanDoneMs > 90_000) {
      console.error(`[WATCHDOG] Scan loop stalled for ${Math.round((Date.now() - lastScanDoneMs) / 1000)}s; exiting for clean restart.`);
      process.exit(1);
    }
  }, 30_000).unref();
}
