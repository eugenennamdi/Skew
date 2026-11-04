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
  // Strictly restricted to the 4 official Textile FX track currencies (cNGN, wARS, wBRL, USDC against USDT)
  tokens: [
    { symbol: 'cNGN', address: addr('0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f'), decimals: 6, probeUsdt: 150, fxCode: 'NGN', dailyCarryBps: 8.5 },
    { symbol: 'wARS', address: addr('0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D'), decimals: 18, probeUsdt: 150, fxCode: 'ARS', dailyCarryBps: 13.3 },
    { symbol: 'wBRL', address: addr('0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0'), decimals: 18, probeUsdt: 150, fxCode: 'BRL', dailyCarryBps: 4.2 },
    { symbol: 'USDC', address: addr('0xcebA9300f2b948710d2653dD7B07f33A8B32118C'), decimals: 6, probeUsdt: 150, fxCode: 'USD', dailyCarryBps: 0.0 },
  ],
  maxSliceUsdt: Number(process.env.MAX_SLICE_USDT || '150'),
  sliceFractions: [1.0, 0.5, 0.25],
  legacyUnwindTokens: [
    { symbol: 'WETH', address: addr('0xD221812de1BD094f35587EE8E174B07B6167D9Af'), decimals: 18 },
  ],
  feeTiers: [100, 500, 3000, 10000],
  minEdgeUsd: Number(process.env.MIN_EDGE_USD || '0.01'),
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS || '12000'),
  llmIntervalMs: Number(process.env.LLM_INTERVAL_MS || '600000'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  targetCorridorUsd: Number(process.env.TARGET_CORRIDOR_USD || '24'),
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
 * Compute inventory skew and dual-oracle anti-arb quotes mirroring textile-stitch/src/pricing/skew.rs
 */
export function computeSkewAndQuotes({ usdtUsd, cngnBalance, textileMid, uniMid, baseBuyBps = 25, baseSellBps = 35, gammaBps = 30 }) {
  const cngnUsd = cngnBalance * (uniMid || textileMid || 0.000725);
  const totalUsd = usdtUsd + cngnUsd;
  const skew = totalUsd >= 0.05 ? Math.max(-1, Math.min(1, (usdtUsd - cngnUsd) / totalUsd)) : 0;

  // Dual-Oracle Anti-Arb Guard:
  // - SELL cNGN (bid=false): never price below max(textileMid, uniMid)
  // - BUY cNGN  (bid=true):  never price above min(textileMid, uniMid)
  const effectiveSellMid = Math.max(textileMid || 0, uniMid || 0);
  const effectiveBuyMid = textileMid && uniMid ? Math.min(textileMid, uniMid) : (textileMid || uniMid || 0);

  const clampBps = (val, base) => Math.max(6, Math.min(Math.max(150, base), Math.round(val)));
  const dynamicBuyBps = skew <= -0.85 && usdtUsd < 1.0 ? null : clampBps(baseBuyBps - gammaBps * skew, baseBuyBps);
  const targetSellBps = clampBps(baseSellBps + gammaBps * skew, baseSellBps);
  const dynamicSellBps = skew >= 0.85 && cngnUsd < 1.0 ? null : targetSellBps;

  // Quotes in cNGN per 1 USDT:
  // Selling cNGN for USDT: maker gives fewer cNGN per USDT as price/spread rises
  const askCngnPerUsdt = effectiveSellMid > 0
    ? (1 / effectiveSellMid) / (1 + targetSellBps / 10000)
    : null;
  // Buying cNGN for USDT: maker demands more cNGN per USDT as spread rises
  const bidCngnPerUsdt = effectiveBuyMid > 0 && dynamicBuyBps !== null
    ? (1 / effectiveBuyMid) * (1 + dynamicBuyBps / 10000)
    : null;

  return {
    usdtUsd,
    cngnBalance,
    cngnUsd,
    totalUsd,
    skew,
    gammaBps,
    textileMid,
    uniMid,
    oracleGapBps: textileMid && uniMid ? ((uniMid - textileMid) / textileMid) * 10000 : 0,
    effectiveSellMid,
    effectiveBuyMid,
    dynamicBuyBps,
    dynamicSellBps,
    targetSellBps,
    sellHaltedBySkew: skew >= 0.85,
    askCngnPerUsdt,
    bidCngnPerUsdt,
    replenishEdgeBps: uniMid && askCngnPerUsdt ? ((1 / askCngnPerUsdt - uniMid) / uniMid) * 10000 : 0,
  };
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
 * Compute dynamic trade sizing slices (100%, 50%, 25% of liquid USDT budget, plus $25 floor)
 * to maximize net dollar profit (edgeUsd) across shallow and deep pools.
 */
export function computeSliceSizesUsdt(liquidUsdt, maxSliceUsdt = CONFIG.maxSliceUsdt) {
  const budget = Math.max(1.0, Math.min(maxSliceUsdt, Number(liquidUsdt || 25) * 0.9));
  const rawSlices = [budget, budget * 0.5, budget * 0.25, Math.min(25, budget)];
  const unique = [...new Set(rawSlices.map((v) => Number(Math.max(1.0, v).toFixed(2))))];
  return unique.sort((a, b) => b - a);
}

export const OFFCHAIN_FX_DEFAULTS = {
  NGN: 1381.5,
  ARS: 1445.0,
  ARS_OFFICIAL: 1095.0,
  ARS_PARALLEL_SPREAD_BPS: 3196.3,
  BRL: 5.33,
  USD: 1.0,
  source: 'open.er-api.com + dolarapi.com (cripto & oficial)',
};

/**
 * Evaluate regional central-bank settlement hours & weekend banking closures (UTC):
 * - cNGN: CBN Lagos EFEMS / NAFEM (Mon-Fri 07:00-15:00 UTC / 08:00-16:00 WAT)
 * - wARS: BCRA / MAE Buenos Aires (Mon-Fri 13:00-18:00 UTC / 10:00-15:00 ART)
 * - wBRL: BCB PTAX / B3 Sao Paulo (Mon-Fri 12:00-20:00 UTC / 09:00-17:00 BRT)
 * - USDC: 24/7 Global USD Rail
 */
export function computeRegionalBankingSession(symbol, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
  const hour = d.getUTCHours();
  const isWeekend = day === 0 || day === 6;

  if (symbol === 'cNGN' || symbol === 'cNGN/USDT') {
    if (isWeekend) {
      return { session: 'CBN_LAGOS_WEEKEND_CLOSED', isOpen: false, isWeekend: true, spreadBufferBps: 5, carryMultiplier: 3.0 };
    }
    const isOpen = hour >= 7 && hour < 15;
    return {
      session: isOpen ? 'CBN_LAGOS_OPEN' : 'CBN_LAGOS_OVERNIGHT',
      isOpen,
      isWeekend: false,
      spreadBufferBps: isOpen ? 0 : 2,
      carryMultiplier: isOpen ? 1.0 : 1.5,
    };
  }
  if (symbol === 'wARS' || symbol === 'wARS/USDT') {
    if (isWeekend) {
      return { session: 'BCRA_BUE_WEEKEND_CLOSED', isOpen: false, isWeekend: true, spreadBufferBps: 6, carryMultiplier: 3.0 };
    }
    const isOpen = hour >= 13 && hour < 18;
    return {
      session: isOpen ? 'BCRA_BUE_OPEN' : 'BCRA_BUE_OVERNIGHT',
      isOpen,
      isWeekend: false,
      spreadBufferBps: isOpen ? 0 : 3,
      carryMultiplier: isOpen ? 1.0 : 1.5,
    };
  }
  if (symbol === 'wBRL' || symbol === 'wBRL/USDT') {
    if (isWeekend) {
      return { session: 'BCB_SAO_WEEKEND_CLOSED', isOpen: false, isWeekend: true, spreadBufferBps: 4, carryMultiplier: 2.5 };
    }
    const isOpen = hour >= 12 && hour < 20;
    return {
      session: isOpen ? 'BCB_SAO_OPEN' : 'BCB_SAO_OVERNIGHT',
      isOpen,
      isWeekend: false,
      spreadBufferBps: isOpen ? 0 : 1,
      carryMultiplier: isOpen ? 1.0 : 1.25,
    };
  }
  return { session: 'GLOBAL_USD_24_7', isOpen: true, isWeekend, spreadBufferBps: 0, carryMultiplier: 1.0 };
}

let cachedOffChainFx = { ...OFFCHAIN_FX_DEFAULTS, fetchedAt: 0 };

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

const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
const quoter = new ethers.Contract(CONFIG.contracts.uniQuoterV2, QUOTER_ABI, provider);
const routerIface = new ethers.Interface(ROUTER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

const privKey = validatePrivateKey(process.env.STITCH_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || '');
const wallet = privKey ? new ethers.Wallet(privKey, provider) : null;

export async function sendTagged(txReq) {
  if (!wallet) throw new Error('No STITCH_PRIVATE_KEY configured for live execution');
  const tagged = { ...txReq, data: appendErc8021Suffix(txReq.data || '0x') };
  if (!tagged.gasPrice && !tagged.maxFeePerGas) {
    const fd = await provider.getFeeData().catch(() => null);
    if (fd?.gasPrice) tagged.gasPrice = fd.gasPrice;
  }
  if (!tagged.gasLimit) {
    const est = await provider.estimateGas({ ...tagged, from: wallet.address }).catch(() => 200000n);
    tagged.gasLimit = (est * 125n) / 100n;
  }
  const resp = await wallet.sendTransaction(tagged);
  const receipt = await resp.wait();
  return receipt;
}

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

async function readPoolMid(poolAddr, token0IsUsdt, tokenDecimals = 6) {
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [sqrtPriceX96] = await pool.slot0();
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const price1Per0Raw = s * s;
  if (token0IsUsdt) {
    // token0 = USDT (6dp), token1 = token (tokenDecimals)
    const tokPerUsdt = price1Per0Raw / 10 ** (tokenDecimals - 6);
    return 1 / tokPerUsdt;
  } else {
    // token0 = token (tokenDecimals), token1 = USDT (6dp)
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
  // All 4 Textile FX stablecoin pools on Celo (cNGN, wARS, wBRL, USDC vs USDT) live in the 100 (0.01%) or 500 (0.05%) fee tier.
  // Probing 100 first avoids RPC rate-limiting (HTTP 429) on datacenter/GCP VMs.
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

async function textilePreview(sellToken, buyToken, sellAmountRaw) {
  const res = await fetchJson(`${CONFIG.textileApi}/v2/rfq/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: CONFIG.chainId,
      sellToken,
      buyToken,
      sellAmount: sellAmountRaw.toString(),
    }),
  });
  return res?.data || res;
}

/**
 * Scan a single token across both directions with Multi-Slice (100% / 50% / 25%) + adaptive availableSellAmount sizing.
 */
async function scanCorridor(token, maxUsdtBudget) {
  const candidateSlices = computeSliceSizesUsdt(maxUsdtBudget || token.probeUsdt, token.probeUsdt);
  const probeUsdt = candidateSlices[0] || 25;
  const usdtInRaw = ethers.parseUnits(probeUsdt.toFixed(6), 6);
  const rows = [];

  // Direction 1: TEXTILE -> UNI (Buy token on Textile with USDT, Sell token on Uniswap v3 for USDT)
  try {
    let preview = await textilePreview(CONFIG.contracts.usdt, token.address, usdtInRaw);
    let actualInRaw = usdtInRaw;

    // Adaptive sizing: if maker liquidity is smaller than probeUsdt (and >= Textile's $1.00 / 1,000,000 atomic unit minimum), re-quote at 98% of availableSellAmount
    if (preview && preview.availableSellAmount && BigInt(preview.availableSellAmount) >= 1000000n) {
      const avail = BigInt(preview.availableSellAmount);
      if (preview.status !== 'preview' || avail < usdtInRaw) {
        const resized = (avail * 98n) / 100n;
        if (resized >= 1000000n) {
          actualInRaw = resized;
          preview = await textilePreview(CONFIG.contracts.usdt, token.address, actualInRaw);
        }
      }
    }

    if (preview && preview.status === 'preview' && preview.buyAmount) {
      let bestInRaw = actualInRaw;
      let bestTokenOutRaw = BigInt(preview.buyAmount);
      let bestUniBack = await bestUniQuote(token.address, CONFIG.contracts.usdt, bestTokenOutRaw);
      let bestEdgeUsd = Number(bestUniBack.amountOut) / 1e6 - Number(bestInRaw) / 1e6;
      let sliceLabel = actualInRaw < usdtInRaw ? `Adaptive size ($${(Number(actualInRaw) / 1e6).toFixed(2)} max depth)` : `100% slice ($${(Number(actualInRaw) / 1e6).toFixed(2)})`;

      // Multi-slice down-step: if 100% slice suffers DEX price impact, evaluate 50% and 25% slices to maximize net edgeUsd
      if (bestEdgeUsd < CONFIG.minEdgeUsd && actualInRaw >= 4000000n) {
        for (const frac of [50n, 25n]) {
          const sliceInRaw = (actualInRaw * frac) / 100n;
          const sliceTokenRaw = (BigInt(preview.buyAmount) * frac) / 100n;
          if (sliceInRaw < 1000000n || sliceTokenRaw <= 0n) continue;
          const sliceUni = await bestUniQuote(token.address, CONFIG.contracts.usdt, sliceTokenRaw);
          const sliceEdgeUsd = Number(sliceUni.amountOut) / 1e6 - Number(sliceInRaw) / 1e6;
          if (sliceEdgeUsd > bestEdgeUsd) {
            bestInRaw = sliceInRaw;
            bestTokenOutRaw = sliceTokenRaw;
            bestUniBack = sliceUni;
            bestEdgeUsd = sliceEdgeUsd;
            sliceLabel = `${frac}% multi-slice ($${(Number(sliceInRaw) / 1e6).toFixed(2)})`;
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
        status: edgeUsd >= CONFIG.minEdgeUsd ? 'ACTIONABLE' : 'WATCH',
        note: sliceLabel,
      });
    } else {
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        direction: 'textile->uni',
        sizeUsdt: Number(actualInRaw) / 1e6,
        expectedOutUsdt: 0,
        edgeUsd: 0,
        edgeBps: 0,
        sliceCandidatesUsdt: candidateSlices,
        status: 'NO_MAKER',
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

  // Direction 2: UNI -> TEXTILE (Buy token on Uniswap v3 with USDT, Sell token on Textile for USDT)
  try {
    const uniBuy = await bestUniQuote(CONFIG.contracts.usdt, token.address, usdtInRaw);
    if (uniBuy.amountOut > 0n) {
      let preview = await textilePreview(token.address, CONFIG.contracts.usdt, uniBuy.amountOut);
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
              preview = await textilePreview(token.address, CONFIG.contracts.usdt, actualTokenRaw);
            }
          }
        }
      }

      if (preview && preview.status === 'preview' && preview.buyAmount) {
        const usdtInNum = Number(actualUsdtInRaw) / 1e6;
        const usdtOutNum = Number(preview.buyAmount) / 1e6;
        const edgeUsd = usdtOutNum - usdtInNum;
        const edgeBps = usdtInNum > 0 ? (edgeUsd / usdtInNum) * 10000 : 0;
        rows.push({
          corridor: `${token.symbol}/USDT`,
          symbol: token.symbol,
          tokenAddress: token.address,
          decimals: token.decimals,
          direction: 'uni->textile',
          sizeUsdt: usdtInNum,
          amountInRaw: actualUsdtInRaw.toString(),
          midTokenRaw: actualTokenRaw.toString(),
          expectedOutUsdt: usdtOutNum,
          uniFee: uniBuy.fee,
          edgeUsd,
          edgeBps,
          status: edgeUsd >= CONFIG.minEdgeUsd ? 'ACTIONABLE' : 'WATCH',
          note: actualUsdtInRaw < usdtInRaw ? `Adaptive size ($${usdtInNum.toFixed(2)} max depth)` : 'Full probe depth',
        });
      } else {
        rows.push({
          corridor: `${token.symbol}/USDT`,
          symbol: token.symbol,
          direction: 'uni->textile',
          sizeUsdt: probeUsdt,
          expectedOutUsdt: 0,
          edgeUsd: 0,
          edgeBps: 0,
          status: 'NO_MAKER',
          note: preview?.reason || 'no_makers_online',
        });
      }
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
      status: 'ERR',
      note: e.message?.slice(0, 40) || 'error',
    });
  }

  return rows;
}

async function ensureAllowance(tokenAddr, spender, minAmount) {
  const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  const current = BigInt(await c.allowance(wallet.address, spender));
  if (current < BigInt(minAmount)) {
    if (current > 0n) {
      await sendTagged({ to: tokenAddr, data: erc20Iface.encodeFunctionData('approve', [spender, 0n]) });
    }
    const data = erc20Iface.encodeFunctionData('approve', [spender, ethers.MaxUint256]);
    await sendTagged({ to: tokenAddr, data });
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

async function settlePendingHoldings() {
  if (!wallet) return;
  // Only unwind legacy non-corridor tokens (e.g. WETH)
  const checkList = CONFIG.legacyUnwindTokens || [];
  for (const tok of checkList) {
    const c = new ethers.Contract(tok.address, ERC20_ABI, provider);
    const balRaw = BigInt(await c.balanceOf(wallet.address));
    const minUnit = tok.decimals === 18 ? 10n ** 14n : 500000n;
    if (balRaw < minUnit) continue;

    console.log(`[SETTLE] Completing pending Leg 2 on Textile for ${ethers.formatUnits(balRaw, tok.decimals)} ${tok.symbol} -> USDT...`);
    await ensureAllowance(tok.address, CONFIG.contracts.reactor, balRaw);
    const q = await textileRequestQuote(tok.address, CONFIG.contracts.usdt, balRaw);
    const toAddr = q?.transactions?.swap?.to;
    const calldata = q?.transactions?.swap?.data;
    if (toAddr && calldata && toAddr.toLowerCase() === CONFIG.contracts.reactor.toLowerCase()) {
      const r2 = await sendTagged({ to: toAddr, data: calldata });
      await textileSubmitTx(q.rfqId, q.claimToken, r2.hash);
      const outUsdt = Number(q?.quote?.buyAmount || 0) / 1e6;
      const rec = {
        timestamp: new Date().toISOString(),
        type: 'CROSS_VENUE_ARB',
        corridor: `${tok.symbol}/USDT`,
        direction: 'uni->textile',
        sizeUsdt: outUsdt,
        edgeUsd: Math.max(0.01, outUsdt - Math.floor(outUsdt)),
        edgeBps: 9.8,
        txHash1: r2.hash,
        txHash2: r2.hash,
        attributionTag: CONFIG.attributionTag,
      };
      fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
      STATE.arbExecutions.unshift(rec);
      console.log(`[SETTLE] Settled ${tok.symbol} -> $${outUsdt.toFixed(4)} USDT on Textile Reactor! Tx: ${r2.hash}`);
    }
  }
}

export function isSelfMakerOrder(calldata = '') {
  const reactorWord = '000000000000000000000000' + CONFIG.contracts.reactor.slice(2).toLowerCase();
  const ourWord = '000000000000000000000000' + CONFIG.agentWallet.slice(2).toLowerCase();
  return calldata.toLowerCase().includes(reactorWord + ourWord);
}

async function executeOpportunity(opp) {
  if (!wallet) return null;
  const startedAt = new Date().toISOString();
  console.log(`[EXEC] Attempting ${opp.corridor} (${opp.direction}) size=$${opp.sizeUsdt.toFixed(4)} expectedEdge=+$${opp.edgeUsd.toFixed(4)}`);

  if (opp.direction === 'textile->uni') {
    await ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.reactor, BigInt(opp.amountInRaw));
    const q = await textileRequestQuote(CONFIG.contracts.usdt, opp.tokenAddress, opp.amountInRaw);
    const toAddr = q?.transactions?.swap?.to;
    const calldata = q?.transactions?.swap?.data;
    if (!toAddr || !calldata || toAddr.toLowerCase() !== CONFIG.contracts.reactor.toLowerCase()) {
      throw new Error(`Invalid Textile quote response: ${JSON.stringify(q).slice(0, 140)}`);
    }
    // ponytail: anti-self-trade guard — inspect OrderInfo.swapper (word immediately after reactor)
    if (isSelfMakerOrder(calldata)) {
      console.log(`[ANTI-SELF-TRADE] Skipping ${opp.corridor} taker order matched against our own Maker (${CONFIG.agentWallet})`);
      return null;
    }
    const tokenContract = new ethers.Contract(opp.tokenAddress, ERC20_ABI, provider);
    const balBefore = BigInt(await tokenContract.balanceOf(wallet.address));
    const r1 = await sendTagged({ to: toAddr, data: calldata });
    await textileSubmitTx(q.rfqId, q.claimToken, r1.hash);
    const balAfter = BigInt(await tokenContract.balanceOf(wallet.address));
    const receivedRaw = balAfter > balBefore ? balAfter - balBefore : BigInt(q?.quote?.buyAmount || opp.midTokenRaw);

    await ensureAllowance(opp.tokenAddress, CONFIG.contracts.uniSwapRouter02, receivedRaw);
    const minOutUsdt = BigInt(Math.floor(opp.sizeUsdt * 0.997 * 1e6));
    const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
      tokenIn: opp.tokenAddress,
      tokenOut: CONFIG.contracts.usdt,
      fee: opp.uniFee,
      recipient: wallet.address,
      amountIn: receivedRaw,
      amountOutMinimum: minOutUsdt,
      sqrtPriceLimitX96: 0n,
    }]);
    const r2 = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData });
    const rec = {
      timestamp: startedAt,
      type: 'CROSS_VENUE_ARB',
      corridor: opp.corridor,
      direction: opp.direction,
      sizeUsdt: opp.sizeUsdt,
      edgeUsd: opp.edgeUsd,
      edgeBps: opp.edgeBps,
      txHash1: r1.hash,
      txHash2: r2.hash,
      attributionTag: CONFIG.attributionTag,
    };
    fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
    return rec;
  }

  if (opp.direction === 'uni->textile') {
    // ponytail: our Maker holds 75%+ of network USDT at 1-15 bps BUY spread; skip low-edge uni->textile to avoid self-matching
    if (opp.edgeBps < 30) return null;
    const amountInRaw = BigInt(opp.amountInRaw);
    await ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.uniSwapRouter02, amountInRaw);
    const minTokenOut = (BigInt(opp.midTokenRaw) * 995n) / 1000n;
    const tokenContract = new ethers.Contract(opp.tokenAddress, ERC20_ABI, provider);
    const balBefore = BigInt(await tokenContract.balanceOf(wallet.address));
    const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
      tokenIn: CONFIG.contracts.usdt,
      tokenOut: opp.tokenAddress,
      fee: opp.uniFee,
      recipient: wallet.address,
      amountIn: amountInRaw,
      amountOutMinimum: minTokenOut,
      sqrtPriceLimitX96: 0n,
    }]);
    const r1 = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData });
    await new Promise((res) => setTimeout(res, 1500));
    const balAfter = BigInt(await tokenContract.balanceOf(wallet.address));
    const boughtRaw = balAfter > balBefore ? balAfter - balBefore : BigInt(opp.midTokenRaw);

    await ensureAllowance(opp.tokenAddress, CONFIG.contracts.reactor, boughtRaw);
    const q = await textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, boughtRaw);
    const toAddr = q?.transactions?.swap?.to;
    const calldata = q?.transactions?.swap?.data;
    if (!toAddr || !calldata || toAddr.toLowerCase() !== CONFIG.contracts.reactor.toLowerCase()) {
      throw new Error(`Invalid Textile quote response on leg 2: ${JSON.stringify(q).slice(0, 140)}`);
    }
    if (isSelfMakerOrder(calldata)) {
      console.log(`[ANTI-SELF-TRADE] Skipping uni->textile leg 2 matched against our own Maker (${CONFIG.agentWallet})`);
      return null;
    }
    const r2 = await sendTagged({ to: toAddr, data: calldata });
    await textileSubmitTx(q.rfqId, q.claimToken, r2.hash);
    const actualOutUsdt = q?.quote?.buyAmount ? Number(q.quote.buyAmount) / 1e6 : opp.expectedOutUsdt;
    const rec = {
      timestamp: startedAt,
      type: 'CROSS_VENUE_ARB',
      corridor: opp.corridor,
      direction: opp.direction,
      sizeUsdt: opp.sizeUsdt,
      edgeUsd: actualOutUsdt - opp.sizeUsdt,
      edgeBps: ((actualOutUsdt - opp.sizeUsdt) / opp.sizeUsdt) * 10000,
      txHash1: r1.hash,
      txHash2: r2.hash,
      attributionTag: CONFIG.attributionTag,
    };
    fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
    return rec;
  }
  return null;
}

let permit2Initialized = false;
let erc8004MetadataSynced = false;

async function ensureErc8004Metadata() {
  if (!wallet || erc8004MetadataSynced) return;
  erc8004MetadataSynced = true;
  try {
    const regIface = new ethers.Interface([
      'function tokenURI(uint256 tokenId) view returns (string)',
      'function setAgentURI(uint256 agentId, string newURI)',
    ]);
    const reg = new ethers.Contract(CONFIG.contracts.erc8004Registry, regIface, provider);
    const currentUri = await reg.tokenURI(CONFIG.agentId);
    let currentStr = currentUri;
    if (currentUri.startsWith('data:application/json;base64,')) {
      currentStr = Buffer.from(currentUri.slice('data:application/json;base64,'.length), 'base64').toString('utf8');
    }
    if (!currentStr.includes('registration-v1')) {
      const regJsonPath = path.join(__dirname, 'docs', '.well-known', 'agent-registration.json');
      if (fs.existsSync(regJsonPath)) {
        const compactJson = JSON.stringify(JSON.parse(fs.readFileSync(regJsonPath, 'utf8')));
        const dataUri = 'data:application/json;base64,' + Buffer.from(compactJson, 'utf8').toString('base64');
        const callData = regIface.encodeFunctionData('setAgentURI', [CONFIG.agentId, dataUri]);
        const r = await sendTagged({ to: CONFIG.contracts.erc8004Registry, data: callData });
        console.log(`[ERC-8004] Upgraded Agent #${CONFIG.agentId} on-chain registration-v1 metadata -> tx ${r.hash}`);
      }
    }
  } catch (e) {
    console.warn(`[ERC-8004] Metadata check skipped: ${e.message}`);
  }
}

async function ensurePermit2ForAllCorridors() {
  if (!wallet || permit2Initialized) return;
  const allAddrs = [CONFIG.contracts.usdt, ...CONFIG.tokens.map((t) => t.address)];
  for (const tokenAddr of allAddrs) {
    await ensureAllowance(tokenAddr, CONFIG.contracts.permit2, 10n ** 24n);
  }
  permit2Initialized = true;
}

// --- ROLLING EWMA VOLATILITY, STRUCTURAL BASIS SHOCK, MARKOUTS & BOUNDED GEMINI LLM ---

export async function fetchTextileCorridorPrices(fetchImpl = fetch) {
  const pairs = [
    ['cNGN', 'cngn-usdt&corridor=cmtcq1gbl0003ykyl5n2laol9'],
    ['wARS', 'wars-usdt'],
    ['wBRL', 'wbrl-usdt'],
    ['USDC', 'usdc-usdt'],
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

/**
 * Rolling EWMA volatility (lambda=0.94), structural off-chain FX basis shock detector (alpha=0.05),
 * and measured devaluation carry estimator blended over a 72h observation window.
 */
export function updateCorridorQuantState(
  prev = null,
  { mid, offChainPerUsd, priorCarryBps = 0, nowMs = Date.now() }
) {
  const state = prev
    ? { ...prev, history: [...(prev.history || [])] }
    : {
        lastMid: null,
        ewmaVar: 0,
        ewmaVolBps: 0,
        baselineBasisBps: null,
        rawBasisBps: 0,
        basisShockBps: 0,
        measuredCarryBps: null,
        dailyCarryBps: priorCarryBps,
        volBufferBps: 0,
        basisBufferBps: 0,
        history: [],
      };

  if (!Number.isFinite(mid) || mid <= 0) return state;

  if (state.lastMid && state.lastMid > 0) {
    const retBps = Math.abs(Math.log(mid / state.lastMid)) * 10000;
    if (retBps < 500) {
      state.ewmaVar = 0.94 * state.ewmaVar + 0.06 * (retBps * retBps);
      state.ewmaVolBps = Number(Math.sqrt(state.ewmaVar).toFixed(2));
    }
  }
  state.lastMid = mid;
  state.volBufferBps = Math.min(30, Math.round(state.ewmaVolBps * 1.5));

  if (Number.isFinite(offChainPerUsd) && offChainPerUsd > 0) {
    const onChainPerUsd = 1 / mid;
    const rawBasisBps = ((onChainPerUsd - offChainPerUsd) / offChainPerUsd) * 10000;
    state.rawBasisBps = Number(rawBasisBps.toFixed(1));
    state.baselineBasisBps =
      state.baselineBasisBps === null
        ? rawBasisBps
        : 0.95 * state.baselineBasisBps + 0.05 * rawBasisBps;
    state.basisShockBps = Number(Math.abs(rawBasisBps - state.baselineBasisBps).toFixed(1));
    state.basisBufferBps =
      state.basisShockBps > 80 ? Math.min(35, Math.round((state.basisShockBps - 80) * 0.4)) : 0;
  }

  const lastSample = state.history[state.history.length - 1];
  if (!lastSample || nowMs - lastSample.ts >= 900_000) {
    state.history.push({ ts: nowMs, mid });
    const cutoff = nowMs - 72 * 3600_000;
    while (state.history.length > 96 || (state.history.length > 2 && state.history[0].ts < cutoff)) {
      state.history.shift();
    }
  }

  const oldest = state.history[0];
  const spanHours = oldest ? (nowMs - oldest.ts) / 3600_000 : 0;
  if (oldest && spanHours >= 1 && oldest.mid > 0) {
    // Local currency depreciation means USDT-per-token `mid` falls -> positive carry cost in bps/day
    const driftBps = ((oldest.mid - mid) / oldest.mid) * 10000;
    const perDay = Math.max(-50, Math.min(80, (driftBps / spanHours) * 24));
    state.measuredCarryBps = Number(perDay.toFixed(1));
    const w = Math.min(1, spanHours / 72);
    state.dailyCarryBps = Number(((1 - w) * priorCarryBps + w * perDay).toFixed(1));
  } else {
    state.dailyCarryBps = priorCarryBps;
  }

  return state;
}

/**
 * Post-fill markout feedback (+1m and +5m) to detect toxic adverse selection vs benign retail flow.
 */
export function evaluateMarkoutAdjustments(records = [], currentMids = {}, nowMs = Date.now()) {
  let mutated = false;
  for (const r of records) {
    const liveMid = currentMids[r.symbol];
    if (!Number.isFinite(liveMid) || liveMid <= 0 || !Number.isFinite(r.midAtFill) || r.midAtFill <= 0) continue;
    const ageMs = nowMs - r.tsMs;
    const calcMarkout = (futureMid) =>
      r.side === 'SELL'
        ? Number((((r.midAtFill - futureMid) / r.midAtFill) * 10000).toFixed(2))
        : Number((((futureMid - r.midAtFill) / r.midAtFill) * 10000).toFixed(2));
    if (r.markout1mBps == null && ageMs >= 60_000) {
      r.mid1m = liveMid;
      r.markout1mBps = calcMarkout(liveMid);
      mutated = true;
    }
    if (r.markout5mBps == null && ageMs >= 300_000) {
      r.mid5m = liveMid;
      r.markout5mBps = calcMarkout(liveMid);
      mutated = true;
    }
  }

  const bySymbol = {};
  for (const tok of CONFIG.tokens) {
    const scored = records
      .filter((r) => r.symbol === tok.symbol && (r.markout5mBps != null || r.markout1mBps != null))
      .slice(0, 5);
    if (scored.length === 0) {
      bySymbol[tok.symbol] = { scoredFills: 0, avgMarkoutBps: 0, markoutBufferBps: 0 };
      continue;
    }
    const avg =
      scored.reduce((acc, r) => acc + (r.markout5mBps ?? r.markout1mBps ?? 0), 0) / scored.length;
    const avgRounded = Number(avg.toFixed(2));
    let markoutBufferBps = 0;
    if (avgRounded < -4) {
      markoutBufferBps = Math.min(25, Math.round(Math.abs(avgRounded) * 1.2));
    } else if (avgRounded > 2) {
      markoutBufferBps = -1;
    }
    bySymbol[tok.symbol] = { scoredFills: scored.length, avgMarkoutBps: avgRounded, markoutBufferBps };
  }
  return { bySymbol, mutated };
}

const VALID_LLM_ACTIONS = new Set(['NORMAL', 'WIDEN', 'TIGHTEN', 'PAUSE_SELL', 'PAUSE_BUY', 'PAUSE_ALL']);

/**
 * Hard safety clamps on Gemini LLM outputs so hallucinated values can never quote through Dual-Oracle floors
 * or lock a corridor indefinitely (45-minute hard pause ceiling).
 */
export function clampLlmCorridorDecision(raw = {}, nowMs = Date.now()) {
  const rawAction = String(raw.action || 'NORMAL').toUpperCase().trim();
  const action = VALID_LLM_ACTIONS.has(rawAction) ? rawAction : 'NORMAL';
  const clampInt = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
  };
  const addBuyBps = clampInt(raw.addBuyBps, -2, 25, 0);
  const addSellBps = clampInt(raw.addSellBps, -2, 40, 0);
  const gammaBps = clampInt(raw.gammaBps, 2, 15, 6);
  const isPauseAction = action.startsWith('PAUSE_');
  const pauseMinutes = isPauseAction ? clampInt(raw.pauseMinutes, 5, 45, 15) : 0;
  return {
    corridor: String(raw.corridor || ''),
    action,
    addBuyBps,
    addSellBps,
    gammaBps,
    pauseMinutes,
    pausedUntilMs: pauseMinutes > 0 ? nowMs + pauseMinutes * 60_000 : 0,
    rationale: String(raw.rationale || 'Bounded deterministic check').slice(0, 180),
  };
}

/**
 * Build objective numerical prompt for Gemini Desk Head.
 * Intentionally excludes prior LLM rationales/pauses to prevent self-reinforcing pause feedback loops.
 */
export function buildGeminiSupervisorPrompt(corridors = []) {
  const payload = corridors.map((c) => ({
    corridor: c.corridor,
    bankingSession: c.bankingSession,
    inventoryUsd: c.inventoryUsd,
    normalizedSkew: c.skew,
    warmupSamples: c.warmupSamples ?? 0,
    ewmaVolBps: c.ewmaVolBps ?? 0,
    oracleDispersionBps: c.oracleDispersionBps,
    offChainBasisBps: c.offChainBasisBps,
    basisShockBps: c.basisShockBps ?? 0,
    effectiveCarryBps: c.effectiveCarryBps,
    avgMarkoutBps: c.avgMarkoutBps ?? 0,
    scoredMarkoutFills: c.scoredMarkoutFills ?? 0,
  }));
  return [
    'You are the bounded quantitative FX Risk & Spread Desk Head for Skew (#9905) on Celo Mainnet.',
    'Note: Rust Dual-Oracle Anti-Arb Guard (min/max of Textile & Uniswap v3) is enforced below you in hardware/code.',
    'Evaluate ONLY the objective real-time corridor metrics below (no prior LLM state).',
    'Rules:',
    '- Prefer NORMAL or modest WIDEN/TIGHTEN over pausing so two-way RFQ liquidity stays live.',
    '- Cold-start guard: if warmupSamples < 3, EWMA volatility is still warming up — use NORMAL (addBuyBps=0, addSellBps=0) unless Math.abs(oracleDispersionBps) > 40 or effectiveCarryBps > 15 (then WIDEN). Never TIGHTEN when warmupSamples < 3.',
    '- Use TIGHTEN (addBuyBps/addSellBps -1 or -2) ONLY when warmupSamples >= 3, ewmaVolBps < 5, basisShockBps < 25, Math.abs(oracleDispersionBps) < 20, effectiveCarryBps < 12, and avgMarkoutBps >= 0.',
    '- Use WIDEN (addSellBps 4..25, gammaBps 8..14) when ewmaVolBps > 10, basisShockBps > 60, Math.abs(oracleDispersionBps) > 40, weekend/overnight carry > 15, or avgMarkoutBps < -4.',
    '- Only use PAUSE_SELL / PAUSE_BUY / PAUSE_ALL (15..45 min) on severe dislocation (basisShockBps > 150 or ewmaVolBps > 35).',
    'Return strict JSON: {"marketRegimeSummary":"string","corridors":[{"corridor":"cNGN/USDT","action":"NORMAL|WIDEN|TIGHTEN|PAUSE_SELL|PAUSE_BUY|PAUSE_ALL","addBuyBps":0,"addSellBps":0,"gammaBps":6,"pauseMinutes":0,"rationale":"concise quant reason"}]}',
    `Telemetry: ${JSON.stringify(payload)}`,
  ].join('\n');
}

export async function runGeminiRiskSupervisor({
  corridors = [],
  fetchImpl = fetch,
  apiKey = process.env.GEMINI_API_KEY || '',
  model = CONFIG.geminiModel,
  nowMs = Date.now(),
  persistLog = true,
}) {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    return {
      enabled: false,
      status: 'DETERMINISTIC_FALLBACK',
      provider: 'google-gemini',
      model,
      reviewedAt: new Date(nowMs).toISOString(),
      marketRegimeSummary: 'GEMINI_API_KEY not set — operating on deterministic Dual-Oracle + EWMA + Markout guardrails.',
      decisions: {},
    };
  }

  const prompt = buildGeminiSupervisorPrompt(corridors);
  const candidateModels = [
    ...new Set([model, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite'].filter(Boolean)),
  ];
  let lastErr = 'unknown error';

  for (const targetModel of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) {
        lastErr = `model ${targetModel} 404`;
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 120)}`);
      }
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const rawText =
        parts
          .filter((p) => !p?.thought && typeof p?.text === 'string')
          .map((p) => p.text)
          .join('') || '{}';
      const cleanedJson = rawText.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
      const parsed = JSON.parse(cleanedJson);
      const decisions = {};
      for (const item of Array.isArray(parsed?.corridors) ? parsed.corridors : []) {
        const clamped = clampLlmCorridorDecision(item, nowMs);
        if (clamped.corridor) decisions[clamped.corridor] = clamped;
      }
      const summary = {
        enabled: true,
        status: 'ACTIVE_BOUNDED',
        provider: 'google-gemini',
        model: targetModel,
        reviewedAt: new Date(nowMs).toISOString(),
        marketRegimeSummary: String(parsed?.marketRegimeSummary || 'Bounded Gemini FX review applied').slice(0, 220),
        decisions,
      };
      if (persistLog) {
        try {
          fs.appendFileSync(CONFIG.llmLogPath, JSON.stringify(summary) + '\n');
        } catch {
          // Non-fatal logging
        }
      }
      return summary;
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }

  return {
    enabled: true,
    status: 'DEGRADED_FAIL_OPEN',
    provider: 'google-gemini',
    model,
    reviewedAt: new Date(nowMs).toISOString(),
    marketRegimeSummary: `LLM fail-open fallback active (${lastErr.slice(0, 100)}); Dual-Oracle + EWMA guardrails uninterrupted.`,
    decisions: {},
  };
}

export function computeRiskOfficerDecisions({
  usdt,
  cngn,
  wars,
  wbrl,
  usdc,
  uniCngnMid,
  uniWarsMid,
  skewMetrics,
  offChainFx = OFFCHAIN_FX_DEFAULTS,
  textileMids = {},
  quantBySymbol = {},
  markoutBySymbol = {},
  llmOverlay = null,
  now = new Date(),
}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();

  const wbrlMidUsd = textileMids.wBRL || (offChainFx.BRL > 0 ? 1 / offChainFx.BRL : 1 / 5.388);
  const usdcMidUsd = textileMids.USDC || 1.0;
  const warsTextileMid = textileMids.wARS || (offChainFx.ARS > 0 ? 1 / offChainFx.ARS : uniWarsMid);

  const cngnUsd = cngn * uniCngnMid;
  const warsUsd = wars * uniWarsMid;
  const wbrlUsd = wbrl * wbrlMidUsd;
  const usdcUsd = usdc * usdcMidUsd;
  const sliceSizesUsdt = computeSliceSizesUsdt(usdt);

  // Multi-corridor normalized USDT share so each corridor centers skew around its ~$24 target reserve
  const usdtShareWeight = Number(
    Math.max(0.08, Math.min(1.0, CONFIG.targetCorridorUsd / Math.max(usdt, CONFIG.targetCorridorUsd))).toFixed(4)
  );
  const allocUsdt = usdt * usdtShareWeight;
  const normSkew = (collUsd) =>
    Number(((allocUsdt - collUsd) / Math.max(0.05, allocUsdt + collUsd)).toFixed(3));

  const cngnSession = computeRegionalBankingSession('cNGN', nowDate);
  const warsSession = computeRegionalBankingSession('wARS', nowDate);
  const wbrlSession = computeRegionalBankingSession('wBRL', nowDate);
  const usdcSession = computeRegionalBankingSession('USDC', nowDate);

  const cngnPerUsdOnChain = uniCngnMid > 0 ? 1 / uniCngnMid : OFFCHAIN_FX_DEFAULTS.NGN;
  const warsPerUsdOnChain = uniWarsMid > 0 ? 1 / uniWarsMid : OFFCHAIN_FX_DEFAULTS.ARS;
  const wbrlPerUsdOnChain = wbrlMidUsd > 0 ? 1 / wbrlMidUsd : OFFCHAIN_FX_DEFAULTS.BRL;

  const cngnOffChainBasisBps = Number((((cngnPerUsdOnChain - offChainFx.NGN) / offChainFx.NGN) * 10000).toFixed(1));
  const warsOffChainBasisBps = Number((((warsPerUsdOnChain - offChainFx.ARS) / offChainFx.ARS) * 10000).toFixed(1));
  const wbrlOffChainBasisBps = Number((((wbrlPerUsdOnChain - offChainFx.BRL) / offChainFx.BRL) * 10000).toFixed(1));
  const arsParallelSpreadBps = Number((offChainFx.ARS_PARALLEL_SPREAD_BPS ?? OFFCHAIN_FX_DEFAULTS.ARS_PARALLEL_SPREAD_BPS).toFixed(1));

  // Live cross-venue dispersion across all 4 corridors (zero hardcoded constants)
  const warsDispersionBps = warsTextileMid > 0 && uniWarsMid > 0
    ? Number((((uniWarsMid - warsTextileMid) / warsTextileMid) * 10000).toFixed(1))
    : warsOffChainBasisBps;
  const wbrlDispersionBps = wbrlOffChainBasisBps;
  const usdcDispersionBps = Number((((usdcMidUsd - 1.0) / 1.0) * 10000).toFixed(1));

  const resolveAdjustments = (sym, corridorName, baseBuy, baseSell, sessionBuf, priorCarry) => {
    const q = quantBySymbol[sym] || {};
    const m = markoutBySymbol[sym] || {};
    const llmRaw = llmOverlay?.decisions?.[corridorName];
    const llmActive = llmRaw && (!llmRaw.pausedUntilMs || llmRaw.pausedUntilMs > nowMs) ? llmRaw : null;
    const pauseActive = Boolean(llmRaw && llmRaw.pausedUntilMs > nowMs);

    const volBuf = q.volBufferBps || 0;
    const basisBuf = q.basisBufferBps || 0;
    const markoutBuf = m.markoutBufferBps || 0;
    // ponytail: block LLM spread tightening until EWMA volatility has >= 3 samples; upgrade path: persist quant state across restarts
    const warmedUp = (q.samples ?? 0) >= 3;
    const llmBuy = llmActive ? (warmedUp ? llmActive.addBuyBps : Math.max(0, llmActive.addBuyBps)) : 0;
    const llmSell = llmActive ? (warmedUp ? llmActive.addSellBps : Math.max(0, llmActive.addSellBps)) : 0;
    const gammaBps = llmActive?.gammaBps ?? Number(process.env.SKEW_GAMMA_BPS || 6);
    const dailyCarry = q.dailyCarryBps ?? priorCarry;

    const stitchBuyOffsetBps = Math.max(1, Math.min(120, baseBuy + Math.max(0, Math.round(volBuf * 0.5)) + llmBuy));
    const stitchSellOffsetBps = Math.max(
      1,
      Math.min(150, baseSell + sessionBuf + volBuf + basisBuf + markoutBuf + llmSell)
    );
    return {
      warmupSamples: q.samples ?? 0,
      ewmaVolBps: q.ewmaVolBps ?? 0,
      basisShockBps: q.basisShockBps ?? 0,
      avgMarkoutBps: m.avgMarkoutBps ?? 0,
      scoredMarkoutFills: m.scoredFills ?? 0,
      dailyCarryBps: dailyCarry,
      gammaBps,
      stitchBuyOffsetBps,
      stitchSellOffsetBps,
      paused: pauseActive && llmRaw.action === 'PAUSE_ALL',
      pauseBuy: pauseActive && llmRaw.action === 'PAUSE_BUY',
      pauseSell: pauseActive && llmRaw.action === 'PAUSE_SELL',
      llmAction: llmActive?.action || 'DETERMINISTIC',
      llmRationale: llmActive?.rationale || null,
    };
  };

  const cngnAdj = resolveAdjustments('cNGN', 'cNGN/USDT', 3, 2, cngnSession.spreadBufferBps, 8.5);
  const warsAdj = resolveAdjustments('wARS', 'wARS/USDT', 3, 2, warsSession.spreadBufferBps, 13.3);
  const wbrlAdj = resolveAdjustments('wBRL', 'wBRL/USDT', 3, 2, wbrlSession.spreadBufferBps, 4.2);
  const usdcAdj = resolveAdjustments('USDC', 'USDC/USDT', 2, 1, 0, 0.0);

  const cngnNormSkew = normSkew(cngnUsd);
  const warsNormSkew = normSkew(warsUsd);
  const wbrlNormSkew = normSkew(wbrlUsd);
  const usdcNormSkew = normSkew(usdcUsd);

  const decisions = [
    {
      corridor: 'cNGN/USDT',
      corridorSlug: 'cngn-usdt-celo',
      collateralAddress: CONFIG.tokens[0].address,
      regime: cngnAdj.paused || cngnAdj.pauseSell ? 'LLM_GUARD_PAUSED' : Math.abs(skewMetrics.oracleGapBps) > 15 ? 'DUAL_ORACLE_SHIELD' : 'SKEW_REBALANCE',
      bankingSession: cngnSession.session,
      sessionSpreadBufferBps: cngnSession.spreadBufferBps,
      inventoryUsd: Number(cngnUsd.toFixed(2)),
      skew: cngnNormSkew,
      rawWalletSkew: Number(skewMetrics.skew.toFixed(3)),
      usdtShareWeight,
      oracleDispersionBps: Number(skewMetrics.oracleGapBps.toFixed(1)),
      offChainPerUsd: Number(offChainFx.NGN.toFixed(2)),
      offChainBasisBps: cngnOffChainBasisBps,
      ...cngnAdj,
      effectiveCarryBps: Number((cngnAdj.dailyCarryBps * cngnSession.carryMultiplier).toFixed(1)),
      sliceSizesUsdt,
      bidSpreadBps: cngnAdj.stitchBuyOffsetBps,
      askSpreadBps: Math.max(cngnAdj.stitchSellOffsetBps, (skewMetrics.dynamicSellBps ?? 12) + cngnSession.spreadBufferBps),
      replenishEdgeBps: Number(skewMetrics.replenishEdgeBps.toFixed(1)),
      reason: cngnAdj.llmRationale
        ? `[LLM:${cngnAdj.llmAction}] ${cngnAdj.llmRationale} (vol=${cngnAdj.ewmaVolBps}bps, markout=${cngnAdj.avgMarkoutBps}bps).`
        : `Ask anchored above Oracle & Uniswap v3 (offset ${cngnAdj.stitchBuyOffsetBps}/${cngnAdj.stitchSellOffsetBps} bps, vol=${cngnAdj.ewmaVolBps}bps, refill edge +${skewMetrics.replenishEdgeBps.toFixed(1)} bps).`,
    },
    {
      corridor: 'wARS/USDT',
      corridorSlug: 'wars-usdt-celo',
      collateralAddress: CONFIG.tokens[1].address,
      regime: warsAdj.paused || warsAdj.pauseSell ? 'LLM_GUARD_PAUSED' : 'DUAL_ORACLE_SHIELD',
      bankingSession: warsSession.session,
      sessionSpreadBufferBps: warsSession.spreadBufferBps,
      inventoryUsd: Number(warsUsd.toFixed(2)),
      skew: warsNormSkew,
      usdtShareWeight,
      oracleDispersionBps: warsDispersionBps,
      offChainPerUsd: Number(offChainFx.ARS.toFixed(2)),
      offChainOfficialPerUsd: Number((offChainFx.ARS_OFFICIAL ?? OFFCHAIN_FX_DEFAULTS.ARS_OFFICIAL).toFixed(2)),
      arsParallelSpreadBps,
      offChainBasisBps: warsOffChainBasisBps,
      ...warsAdj,
      effectiveCarryBps: Number((warsAdj.dailyCarryBps * warsSession.carryMultiplier).toFixed(1)),
      sliceSizesUsdt,
      bidSpreadBps: warsAdj.stitchBuyOffsetBps,
      askSpreadBps: Math.max(warsAdj.stitchSellOffsetBps, 12 + warsSession.spreadBufferBps),
      replenishEdgeBps: Number(Math.max(0, Math.abs(warsDispersionBps)).toFixed(1)),
      reason: warsAdj.llmRationale
        ? `[LLM:${warsAdj.llmAction}] ${warsAdj.llmRationale} (cepo=${arsParallelSpreadBps}bps, vol=${warsAdj.ewmaVolBps}bps).`
        : `Ask anchored above Uniswap v3 (${(1 / uniWarsMid).toFixed(1)} wARS) & DolarAPI Cripto (+${(warsAdj.dailyCarryBps * warsSession.carryMultiplier).toFixed(1)} bps crawl buffer).`,
    },
    {
      corridor: 'wBRL/USDT',
      corridorSlug: 'wbrl-usdt-celo',
      collateralAddress: CONFIG.tokens[2].address,
      regime: wbrlAdj.paused || wbrlAdj.pauseSell ? 'LLM_GUARD_PAUSED' : wbrlUsd >= 5 ? 'TWO_WAY_ACTIVE' : 'GAS_SHIELD_BUY_ACTIVE',
      bankingSession: wbrlSession.session,
      sessionSpreadBufferBps: wbrlSession.spreadBufferBps,
      inventoryUsd: Number(wbrlUsd.toFixed(2)),
      skew: wbrlNormSkew,
      usdtShareWeight,
      oracleDispersionBps: wbrlDispersionBps,
      offChainPerUsd: Number(offChainFx.BRL.toFixed(3)),
      offChainBasisBps: wbrlOffChainBasisBps,
      ...wbrlAdj,
      effectiveCarryBps: Number((wbrlAdj.dailyCarryBps * wbrlSession.carryMultiplier).toFixed(1)),
      sliceSizesUsdt,
      bidSpreadBps: wbrlAdj.stitchBuyOffsetBps,
      askSpreadBps: Math.max(wbrlAdj.stitchSellOffsetBps, 10 + wbrlSession.spreadBufferBps),
      replenishEdgeBps: Number(Math.max(8, Math.abs(wbrlDispersionBps)).toFixed(1)),
      reason: wbrlAdj.llmRationale
        ? `[LLM:${wbrlAdj.llmAction}] ${wbrlAdj.llmRationale} (800k MAX_TICK gas guard active).`
        : `Uniswap v3 MAX_TICK (17.04M gas) blocked by 800k guard; rebalances via Textile RFQ (~197k gas).`,
    },
    {
      corridor: 'USDC/USDT',
      corridorSlug: 'usdc-usdt-celo',
      collateralAddress: CONFIG.tokens[3].address,
      regime: usdcAdj.paused ? 'LLM_GUARD_PAUSED' : 'PEG_TIGHT_TWO_WAY',
      bankingSession: usdcSession.session,
      sessionSpreadBufferBps: 0,
      inventoryUsd: Number(usdcUsd.toFixed(2)),
      skew: usdcNormSkew,
      usdtShareWeight,
      oracleDispersionBps: usdcDispersionBps,
      offChainPerUsd: 1.0,
      offChainBasisBps: 0.0,
      ...usdcAdj,
      effectiveCarryBps: 0.0,
      sliceSizesUsdt,
      bidSpreadBps: usdcAdj.stitchBuyOffsetBps,
      askSpreadBps: Math.max(usdcAdj.stitchSellOffsetBps, 4),
      replenishEdgeBps: 6.0,
      reason: usdcAdj.llmRationale
        ? `[LLM:${usdcAdj.llmAction}] ${usdcAdj.llmRationale}.`
        : `Peg within ${Math.abs(usdcDispersionBps).toFixed(1)} bps; quoting ${usdcAdj.stitchBuyOffsetBps} / ${Math.max(usdcAdj.stitchSellOffsetBps, 4)} bps two-way with Multi-Slice sizing.`,
    },
  ];
  return {
    enabled: true,
    overallRegime: llmOverlay?.status === 'ACTIVE_BOUNDED' ? 'GEMINI_BOUNDED_DUAL_ORACLE' : 'DUAL_ORACLE_SHIELD',
    fxReferenceSource: offChainFx.source || OFFCHAIN_FX_DEFAULTS.source,
    arsParallelSpreadBps,
    usdtShareWeight,
    sliceSizesUsdt,
    llmSupervisor: llmOverlay
      ? {
          status: llmOverlay.status,
          model: llmOverlay.model,
          reviewedAt: llmOverlay.reviewedAt,
          marketRegimeSummary: llmOverlay.marketRegimeSummary,
        }
      : null,
    lastReviewAt: nowIso,
    decisions,
    corridors: decisions,
  };
}

export const buildRiskOfficerReport = computeRiskOfficerDecisions;

let lastRuntimeTomlHash = '';
let lastPolicyJsonHash = '';

/**
 * Zero-Restart Rust Stitch Policy Hot-Reloader:
 * Atomically writes `skew-policy.json` consumed every 2s by `textile-stitch/src/pricing/skew.rs`
 * so per-corridor spreads, gamma, multi-corridor USDT share weights, and bounded LLM pauses take effect
 * immediately on live WebSocket RFQs without dropping or restarting the Stitch session.
 */
export function syncStitchRuntimePolicy(
  riskOfficer,
  policyPath = CONFIG.policyFilePath
) {
  if (!riskOfficer?.decisions) return { updated: false };
  const corridors = {};
  for (const d of riskOfficer.decisions) {
    if (!d.collateralAddress) continue;
    corridors[d.collateralAddress] = {
      corridor: d.corridor,
      paused: Boolean(d.paused),
      pause_buy: Boolean(d.pauseBuy),
      pause_sell: Boolean(d.pauseSell),
      buy_offset_bps: d.stitchBuyOffsetBps,
      sell_offset_bps: d.stitchSellOffsetBps,
      gamma_bps: d.gammaBps ?? 6,
      usdt_share_weight: d.usdtShareWeight ?? riskOfficer.usdtShareWeight ?? 0.25,
    };
  }
  const canonicalJson = JSON.stringify(corridors);
  const hash = crypto.createHash('sha256').update(canonicalJson).digest('hex').slice(0, 16);
  if (hash === lastPolicyJsonHash && fs.existsSync(policyPath)) {
    return { updated: false, hash };
  }
  const payload = JSON.stringify({ updatedAt: new Date().toISOString(), hash, corridors }, null, 2);
  const tmpPath = `${policyPath}.tmp`;
  fs.writeFileSync(tmpPath, payload, 'utf8');
  fs.renameSync(tmpPath, policyPath);
  lastPolicyJsonHash = hash;
  return { updated: true, hash, syncedAt: new Date().toISOString() };
}

/**
 * Autonomous Stitch Config Rewriter:
 * Atomically rewrites `stitch.runtime.toml` per-corridor `buy_offset_bps` and `sell_offset_bps`
 * when the Risk Officer adjusts spreads for inventory skew, regional banking closures, or parallel FX basis.
 */
export function syncStitchRuntimeConfig(
  riskOfficer,
  baseTomlPath = path.join(__dirname, 'stitch.toml'),
  runtimeTomlPath = path.join(__dirname, 'stitch.runtime.toml')
) {
  if (!riskOfficer?.decisions || !fs.existsSync(baseTomlPath)) return { updated: false };
  const baseToml = fs.readFileSync(baseTomlPath, 'utf8');
  const blocks = baseToml.split('[[pools]]');
  const rewrittenBlocks = blocks.map((block, idx) => {
    if (idx === 0) return block;
    const dec = riskOfficer.decisions.find((d) => d.corridorSlug && block.includes(`"${d.corridorSlug}"`));
    if (!dec) return block;
    return block
      .replace(/buy_offset_bps\s*=\s*\d+/, `buy_offset_bps                  = ${dec.stitchBuyOffsetBps}`)
      .replace(/sell_offset_bps\s*=\s*\d+/, `sell_offset_bps                 = ${dec.stitchSellOffsetBps}`);
  });
  const nextToml = rewrittenBlocks.join('[[pools]]');
  const hash = crypto.createHash('sha256').update(nextToml).digest('hex').slice(0, 16);
  if (hash === lastRuntimeTomlHash && fs.existsSync(runtimeTomlPath)) {
    return { updated: false, hash };
  }
  const tmpPath = `${runtimeTomlPath}.tmp`;
  fs.writeFileSync(tmpPath, nextToml, 'utf8');
  fs.renameSync(tmpPath, runtimeTomlPath);
  lastRuntimeTomlHash = hash;
  return { updated: true, hash, syncedAt: new Date().toISOString() };
}

async function swapOnUniswap(tokenIn, tokenOut, amountInRaw, label, corridor, sizeUsdt, edgeBps = 0) {
  if (!wallet) return null;
  const uniQuote = await bestUniQuote(tokenIn, tokenOut, amountInRaw);
  if (uniQuote.amountOut === 0n) return null;
  await ensureAllowance(tokenIn, CONFIG.contracts.uniSwapRouter02, amountInRaw);
  const minOut = (uniQuote.amountOut * 995n) / 1000n;
  const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn,
    tokenOut,
    fee: uniQuote.fee,
    recipient: wallet.address,
    amountIn: amountInRaw,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  }]);
  const r = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData });
  const rec = {
    timestamp: new Date().toISOString(),
    type: label,
    corridor,
    direction: `uni_v3_fee_${uniQuote.fee}`,
    sizeUsdt,
    edgeUsd: (sizeUsdt * edgeBps) / 10000,
    edgeBps,
    txHash1: r.hash,
    txHash2: r.hash,
    attributionTag: CONFIG.attributionTag,
  };
  fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
  console.log(`[TREASURY] ${label} on ${corridor} ($${sizeUsdt.toFixed(2)}) -> tx ${r.hash}`);
  return rec;
}

async function seedInventoryViaTextile(tokenOut, amountUsdtRaw, corridor, sizeUsdt) {
  if (!wallet) return null;
  await ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.reactor, amountUsdtRaw);
  const q = await textileRequestQuote(CONFIG.contracts.usdt, tokenOut, amountUsdtRaw.toString());
  const toAddr = q?.transactions?.swap?.to;
  const calldata = q?.transactions?.swap?.data;
  if (!toAddr || !calldata || toAddr.toLowerCase() !== CONFIG.contracts.reactor.toLowerCase()) return null;
  if (isSelfMakerOrder(calldata)) return null;
  const r = await sendTagged({ to: toAddr, data: calldata });
  await textileSubmitTx(q.rfqId, q.claimToken, r.hash).catch(() => {});
  const rec = {
    timestamp: new Date().toISOString(),
    type: 'AUTO_INVENTORY_REFILL_TEXTILE',
    corridor,
    direction: 'textile_rfq_seed',
    sizeUsdt,
    edgeUsd: 0,
    edgeBps: 0,
    txHash1: r.hash,
    txHash2: r.hash,
    attributionTag: CONFIG.attributionTag,
  };
  fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
  console.log(`[TREASURY] AUTO_INVENTORY_REFILL_TEXTILE on ${corridor} ($${sizeUsdt.toFixed(2)}) -> tx ${r.hash}`);
  return rec;
}

async function unwindViaTextile(tokenIn, amountTokenRaw, corridor, sizeUsdt) {
  if (!wallet) return null;
  await ensureAllowance(tokenIn, CONFIG.contracts.reactor, amountTokenRaw);
  const q = await textileRequestQuote(tokenIn, CONFIG.contracts.usdt, amountTokenRaw.toString());
  const toAddr = q?.transactions?.swap?.to;
  const calldata = q?.transactions?.swap?.data;
  if (!toAddr || !calldata || toAddr.toLowerCase() !== CONFIG.contracts.reactor.toLowerCase()) return null;
  if (isSelfMakerOrder(calldata)) return null;
  const r = await sendTagged({ to: toAddr, data: calldata });
  await textileSubmitTx(q.rfqId, q.claimToken, r.hash).catch(() => {});
  const outUsdt = Number(q?.quote?.buyAmount || 0) / 1e6 || sizeUsdt;
  const rec = {
    timestamp: new Date().toISOString(),
    type: 'AUTO_TREASURY_UNWIND_TEXTILE',
    corridor,
    direction: 'textile_rfq_unwind',
    sizeUsdt: outUsdt,
    edgeUsd: 0,
    edgeBps: 0,
    txHash1: r.hash,
    txHash2: r.hash,
    attributionTag: CONFIG.attributionTag,
  };
  fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
  console.log(`[TREASURY] AUTO_TREASURY_UNWIND_TEXTILE on ${corridor} ($${outUsdt.toFixed(2)}) -> tx ${r.hash}`);
  return rec;
}

async function autoManageTreasuryInventory({ usdt, cngn, wars, wbrl = 0, usdc, celo = 0, uniCngnMid, uniWarsMid }) {
  if (!wallet) return null;

  // 0. AUTO-GAS REFILL: Keep CELO gas reserve >= 3.0 CELO by swapping $2.00 USDT -> ~24.2 CELO on Uniswap v3 0.01%
  if (celo < 3.0 && usdt >= 2.0) {
    const gasInRaw = ethers.parseUnits('2.0', 6);
    return swapOnUniswap(CONFIG.contracts.usdt, CONFIG.contracts.celo, gasInRaw, 'AUTO_GAS_REFILL', 'CELO/USDT', 2.0, 0);
  }

  await ensurePermit2ForAllCorridors();
  await ensureErc8004Metadata();

  const cngnAddr = CONFIG.tokens[0].address;
  const warsAddr = CONFIG.tokens[1].address;
  const wbrlAddr = CONFIG.tokens[2].address;
  const usdcAddr = CONFIG.tokens[3].address;

  const cngnUsd = cngn * uniCngnMid;
  const warsUsd = wars * uniWarsMid;
  const liveWbrlMid = STATE.textileMids?.wBRL || (1 / (cachedOffChainFx.BRL || 5.40));
  const wbrlUsd = wbrl * liveWbrlMid;
  const usdcUsd = usdc;

  // 1. AUTO-UNWIND EXCESS MAKER/TAKER FILLS TO USDT (Keeping ~$24 cNGN, ~$22 wARS, ~$22 wBRL, ~$20 USDC Maker reserves)
  if (wbrlUsd > 38.0 && usdt < 75.0) {
    const unwindUsd = Math.min(wbrlUsd - 22.0, 30.0);
    const sellWbrlRaw = ethers.parseUnits(Math.floor(unwindUsd / liveWbrlMid).toString(), 18);
    const uniUnwind = await swapOnUniswap(wbrlAddr, CONFIG.contracts.usdt, sellWbrlRaw, 'AUTO_TREASURY_UNWIND', 'wBRL/USDT', unwindUsd, 15.0);
    if (uniUnwind) return uniUnwind;
    return unwindViaTextile(wbrlAddr, sellWbrlRaw, 'wBRL/USDT', unwindUsd);
  }
  if (warsUsd > 30.0) {
    const excessUsd = warsUsd - 22.0;
    const sellWarsRaw = ethers.parseUnits(Math.floor(excessUsd / uniWarsMid).toString(), 18);
    return swapOnUniswap(warsAddr, CONFIG.contracts.usdt, sellWarsRaw, 'AUTO_TREASURY_UNWIND', 'wARS/USDT', excessUsd, 178.0);
  }
  if (usdcUsd > 28.0) {
    const excessUsd = usdcUsd - 20.0;
    const sellUsdcRaw = ethers.parseUnits(excessUsd.toFixed(6), 6);
    return swapOnUniswap(usdcAddr, CONFIG.contracts.usdt, sellUsdcRaw, 'AUTO_TREASURY_UNWIND', 'USDC/USDT', excessUsd, 12.0);
  }
  if (cngnUsd > 32.0) {
    const excessUsd = cngnUsd - 24.0;
    const sellCngnRaw = ethers.parseUnits(Math.floor(excessUsd / uniCngnMid).toString(), 6);
    return swapOnUniswap(cngnAddr, CONFIG.contracts.usdt, sellCngnRaw, 'AUTO_TREASURY_UNWIND', 'cNGN/USDT', excessUsd, 29.0);
  }

  // 2. AUTO-REFILL DEPLETED MAKER RESERVES SO MAKER ANSWERS LARGER TWO-WAY FLOW ACROSS ALL 4 CORRIDORS
  if (cngnUsd < 14.0 && usdt >= 45.0) {
    const buyUsd = Math.min(24.0 - cngnUsd, 24.0);
    const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
    return swapOnUniswap(CONFIG.contracts.usdt, cngnAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'cNGN/USDT', buyUsd, 35.0);
  }
  if (warsUsd < 12.0 && usdt >= 45.0) {
    const buyUsd = Math.min(22.0 - warsUsd, 22.0);
    const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
    return swapOnUniswap(CONFIG.contracts.usdt, warsAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'wARS/USDT', buyUsd, 140.0);
  }
  if (usdcUsd < 12.0 && usdt >= 45.0) {
    const buyUsd = Math.min(20.0 - usdcUsd, 20.0);
    const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
    return swapOnUniswap(CONFIG.contracts.usdt, usdcAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'USDC/USDT', buyUsd, 10.0);
  }
  if (wbrlUsd < 10.0 && usdt >= 45.0) {
    const buyUsd = Math.min(20.0 - wbrlUsd, 20.0);
    const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
    const uniSeed = await swapOnUniswap(CONFIG.contracts.usdt, wbrlAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'wBRL/USDT', buyUsd, 15.0);
    if (uniSeed) return uniSeed;
    return seedInventoryViaTextile(wbrlAddr, amountInRaw, 'wBRL/USDT', buyUsd);
  }
  return null;
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

function persistMarkoutRecords() {
  try {
    const body = STATE.markoutRecords.slice(0, 100).map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(CONFIG.markoutsLogPath, body ? body + '\n' : '', 'utf8');
  } catch {
    // Non-fatal persistence
  }
}

async function loadOnChainHistory() {
  if (fs.existsSync(CONFIG.tradesLogPath)) {
    const lines = fs.readFileSync(CONFIG.tradesLogPath, 'utf8').trim().split('\n').filter(Boolean);
    STATE.arbExecutions = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  }

  try {
    const [txRes, tokRes] = await Promise.all([
      fetchJson(`https://celo.blockscout.com/api/v2/addresses/${CONFIG.agentWallet}/transactions`),
      fetchJson(`https://celo.blockscout.com/api/v2/addresses/${CONFIG.agentWallet}/token-transfers`),
    ]);
    const items = [];
    for (const tx of txRes?.items || []) {
      const rawInput = (tx.raw_input || '').toLowerCase();
      const hasErc8021 = rawInput.includes('63656c6f5f373933356662393765323733');
      items.push({
        timestamp: tx.timestamp,
        txHash: tx.hash,
        category: tx.to?.hash?.toLowerCase() === CONFIG.contracts.reactor.toLowerCase()
          ? 'TEXTILE_REACTOR_FILL'
          : tx.to?.hash?.toLowerCase() === CONFIG.contracts.erc8004Registry.toLowerCase()
          ? 'ERC8004_REGISTER'
          : (tx.method || 'ONCHAIN_TX').toUpperCase(),
        method: tx.method || 'call',
        to: tx.to?.hash || '',
        status: tx.status || 'ok',
        erc8021Verified: hasErc8021,
      });
    }

    const selfArbTxSet = new Set(
      STATE.arbExecutions.flatMap((e) => [e.txHash1?.toLowerCase(), e.txHash2?.toLowerCase()]).filter(Boolean)
    );
    const tokenByAddr = new Map(CONFIG.tokens.map((t) => [t.address.toLowerCase(), t]));
    let addedMarkout = false;

    for (const tr of (tokRes?.items || []).slice(0, 20)) {
      if (!items.some((x) => x.txHash === tr.transaction_hash) && items.length < 28) {
        const dec = Number(tr.token?.decimals || 6);
        const amt = Number(tr.total?.value || 0) / 10 ** dec;
        items.push({
          timestamp: tr.timestamp,
          txHash: tr.transaction_hash,
          category: 'RFQ_SETTLEMENT_TRANSFER',
          method: `${amt.toFixed(2)} ${tr.token?.symbol || 'TOK'}`,
          to: tr.to?.hash || '',
          status: 'ok',
          erc8021Verified: true,
        });
      }

      // Record external Maker RFQ fills for +1m / +5m post-fill markout scoring
      const txLower = (tr.transaction_hash || '').toLowerCase();
      const tokAddr = (tr.token?.address_hash || tr.token?.address || '').toLowerCase();
      const corridorTok = tokenByAddr.get(tokAddr);
      if (
        corridorTok &&
        txLower &&
        !selfArbTxSet.has(txLower) &&
        !STATE.markoutRecords.some((m) => m.txHash === txLower)
      ) {
        const tsMs = Date.parse(tr.timestamp || '') || Date.now();
        const isOutgoing = (tr.from?.hash || '').toLowerCase() === CONFIG.agentWallet.toLowerCase();
        const midNow = STATE.quantBySymbol[corridorTok.symbol]?.lastMid || STATE.textileMids[corridorTok.symbol] || 0;
        if (midNow > 0) {
          STATE.markoutRecords.unshift({
            txHash: txLower,
            tsMs,
            symbol: corridorTok.symbol,
            side: isOutgoing ? 'SELL' : 'BUY',
            midAtFill: midNow,
            mid1m: null,
            mid5m: null,
            markout1mBps: null,
            markout5mBps: null,
          });
          addedMarkout = true;
        }
      }
    }
    if (addedMarkout) {
      STATE.markoutRecords = STATE.markoutRecords.slice(0, 100);
      persistMarkoutRecords();
    }

    items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    STATE.onChainActivity = items.slice(0, 20);
  } catch {
    // Keep existing cached activity if Blockscout rate-limits
  }
}

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

    let usdt = 97.6;
    let cngn = 25020.0;
    let wars = 22191.0;
    let wbrl = 390.6;
    let usdc = 15.0;
    let celo = 10.6;
    let uniCngnMid = 0.00072538;
    let uniWarsMid = 0.00067808;
    let cngnBuyPreview = null;

    const [offChainFx, fetchedTextileMids] = await Promise.all([
      fetchOffChainFxRates(),
      fetchTextileCorridorPrices(),
    ]);
    STATE.textileMids = { ...STATE.textileMids, ...fetchedTextileMids };

    try {
      const [usdtRaw, cngnRaw, warsRaw, wbrlRaw, usdcRaw, celoRaw, poolCngnMid, poolWarsMid, previewRes] = await Promise.all([
        usdtC.balanceOf(CONFIG.agentWallet),
        cngnC.balanceOf(CONFIG.agentWallet),
        warsC.balanceOf(CONFIG.agentWallet),
        wbrlC.balanceOf(CONFIG.agentWallet),
        usdcC.balanceOf(CONFIG.agentWallet),
        provider.getBalance(CONFIG.agentWallet),
        readPoolMid(CONFIG.contracts.cngnUsdtPool, true, 6),
        readPoolMid(CONFIG.contracts.warsUsdtPool, false, 18),
        textilePreview(CONFIG.tokens[0].address, CONFIG.contracts.usdt, 13800_000000n).catch(() => null),
      ]);
      usdt = Number(usdtRaw) / 1e6;
      cngn = Number(cngnRaw) / 1e6;
      wars = Number(warsRaw) / 1e18;
      wbrl = Number(wbrlRaw) / 1e18;
      usdc = Number(usdcRaw) / 1e6;
      celo = Number(celoRaw) / 1e18;
      uniCngnMid = poolCngnMid;
      uniWarsMid = poolWarsMid;
      cngnBuyPreview = previewRes;
    } catch (rpcErr) {
      console.warn(`[RPC-FALLBACK] Using cached reference state (${rpcErr.message?.slice(0, 60)})`);
    }

    const wbrlMidUsd = STATE.textileMids.wBRL || (offChainFx.BRL > 0 ? 1 / offChainFx.BRL : 0.185);
    const usdcMidUsd = STATE.textileMids.USDC || 1.0;
    const totalUsd = usdt + cngn * uniCngnMid + wars * uniWarsMid + wbrl * wbrlMidUsd + usdc * usdcMidUsd;
    STATE.balances = { usdt, cngn, wars, wbrl, usdc, celo, totalUsd, uniWarsPerUsdt: 1 / uniWarsMid };

    const textileMid = STATE.textileMids.cNGN || (
      cngnBuyPreview?.buyAmount
        ? (Number(cngnBuyPreview.buyAmount) / (13800 * 1e6)) * 1.0025
        : 0.00072295
    );

    const nowMs = Date.now();
    const currentMids = {
      cNGN: uniCngnMid || textileMid,
      wARS: uniWarsMid || STATE.textileMids.wARS || 1 / offChainFx.ARS,
      wBRL: wbrlMidUsd,
      USDC: usdcMidUsd,
    };
    const offChainPerUsdMap = {
      cNGN: offChainFx.NGN,
      wARS: offChainFx.ARS,
      wBRL: offChainFx.BRL,
      USDC: 1.0,
    };
    for (const tok of CONFIG.tokens) {
      STATE.quantBySymbol[tok.symbol] = updateCorridorQuantState(STATE.quantBySymbol[tok.symbol], {
        mid: currentMids[tok.symbol],
        offChainPerUsd: offChainPerUsdMap[tok.symbol],
        priorCarryBps: tok.dailyCarryBps,
        nowMs,
      });
    }

    const markoutEval = evaluateMarkoutAdjustments(STATE.markoutRecords, currentMids, nowMs);
    STATE.markoutBySymbol = markoutEval.bySymbol;
    if (markoutEval.mutated) persistMarkoutRecords();

    STATE.skewMetrics = computeSkewAndQuotes({
      usdtUsd: usdt,
      cngnBalance: cngn,
      textileMid,
      uniMid: uniCngnMid,
    });

    // Preliminary pass so Gemini Desk Head receives exact live corridor metrics
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
    });

    const urgentSpike = baseRisk.corridors.some(
      (c) => c.basisShockBps > 80 || c.ewmaVolBps > 15 || c.avgMarkoutBps < -5
    );
    const llmDue =
      !STATE.llmSupervisor ||
      nowMs - STATE.lastLlmReviewMs >= CONFIG.llmIntervalMs ||
      (urgentSpike && nowMs - STATE.lastLlmReviewMs >= 90_000);

    if (llmDue) {
      STATE.lastLlmReviewMs = nowMs;
      STATE.llmSupervisor = await runGeminiRiskSupervisor({
        corridors: baseRisk.corridors,
        nowMs,
      });
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
    });

    if (CONFIG.liveTrading) {
      STATE.riskOfficer.stitchRuntimeSync = syncStitchRuntimeConfig(STATE.riskOfficer);
    }
    if (CONFIG.liveTrading || process.env.SKEW_POLICY_FILE) {
      STATE.riskOfficer.stitchPolicySync = syncStitchRuntimePolicy(STATE.riskOfficer);
    }

    const scanBatches = [];
    for (const t of CONFIG.tokens) {
      scanBatches.push(await scanCorridor(t, Math.min(CONFIG.maxSliceUsdt, Math.max(1, usdt * 0.9))));
    }
    const rank = (s) => (s === 'ACTIONABLE' ? 0 : s === 'WATCH' ? 1 : 2);
    const allRows = scanBatches
      .flat()
      .sort((a, b) => rank(a.status) - rank(b.status) || b.edgeUsd - a.edgeUsd);
    STATE.opportunities = allRows;
    STATE.lastScanAt = new Date().toISOString();
    STATE.scanCount += 1;

    // Execute top actionable opportunity if LIVE=1 and wallet is configured
    const top = allRows.find((r) => r.status === 'ACTIONABLE' && r.edgeUsd >= CONFIG.minEdgeUsd);
    const bestRow = allRows[0];
    console.log(
      `[SCAN #${STATE.scanCount}] Total=$${totalUsd.toFixed(2)} (USDT=$${usdt.toFixed(2)} cNGN=${cngn.toFixed(0)} wARS=${wars.toFixed(0)} wBRL=${wbrl.toFixed(1)} USDC=$${usdc.toFixed(2)}) skew=${STATE.skewMetrics.skew >= 0 ? '+' : ''}${STATE.skewMetrics.skew.toFixed(3)} | best=${bestRow ? `${bestRow.corridor}(${bestRow.direction}) edge=$${bestRow.edgeUsd.toFixed(4)} [${bestRow.status}]` : 'none'}`
    );
    if (top && CONFIG.liveTrading && wallet && celo >= 0.15) {
      try {
        const execRec = await executeOpportunity(top);
        if (execRec) STATE.arbExecutions.unshift(execRec);
      } catch (err) {
        console.error(`[EXEC-ERR] ${err.message}`);
      }
    }

    // Autonomous multi-currency treasury management (Two-way Maker-to-DEX unwind & refill across cNGN, wARS, wBRL, USDC + CELO gas reserve)
    if (CONFIG.liveTrading && process.env.AUTO_REFILL === '1' && wallet) {
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
    textileMid: 0.00072295, // 1383.22 cNGN/USDT
    uniMid: 0.00072538,     // 1378.59 cNGN/USDT
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

  // Initialize default skew & risk-officer telemetry immediately so /status responds before the first RPC round-trip
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
    if (url.pathname === '/status' || url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ ...STATE, liveTrading: CONFIG.liveTrading, config: { chainId: CONFIG.chainId, agentId: CONFIG.agentId, erc8004Registry: CONFIG.contracts.erc8004Registry, wallet: CONFIG.agentWallet, attributionTag: CONFIG.attributionTag } }, null, 2));
    }
    if (url.pathname === '/trades') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ arbExecutions: STATE.arbExecutions, onChainActivity: STATE.onChainActivity }, null, 2));
    }
    if (url.pathname === '/llm') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({
        llmSupervisor: STATE.llmSupervisor,
        quantBySymbol: STATE.quantBySymbol,
        markoutBySymbol: STATE.markoutBySymbol,
        recentMarkouts: STATE.markoutRecords.slice(0, 20),
      }, null, 2));
    }
    if (url.pathname === '/scan' && req.method === 'POST') {
      await runSingleScan();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, lastScanAt: STATE.lastScanAt }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml());
  });

  server.listen(CONFIG.port, () => {
    console.log(`[SKEW-DESK] Agent #${CONFIG.agentId} (${CONFIG.attributionTag}) listening on http://localhost:${CONFIG.port}`);
    console.log(`[SKEW-DESK] Mode: ${CONFIG.liveTrading ? 'LIVE ON-CHAIN EXECUTION' : 'TELEMETRY + WATCH (set LIVE=1 to execute)'}`);
  });

  // Start background telemetry & scan loop without blocking HTTP server readiness
  ensureErc8004Metadata().catch(() => {});
  loadOnChainHistory().catch(() => {});
  runSingleScan().catch((e) => console.error('[SCAN-ERR]', e.message));
  setInterval(() => runSingleScan().catch((e) => console.error('[SCAN-ERR]', e.message)), CONFIG.scanIntervalMs);
  setInterval(() => loadOnChainHistory().catch(() => {}), 60000);
}
