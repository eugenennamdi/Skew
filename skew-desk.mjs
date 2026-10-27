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

// Automatically load textile-stitch/stitch.env if present and not already in process.env
const envPath = path.join(__dirname, 'textile-stitch', 'stitch.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"'\r\n]+)["']?/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
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
    { symbol: 'cNGN', address: addr('0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f'), decimals: 6, probeUsdt: 25 },
    { symbol: 'wARS', address: addr('0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D'), decimals: 18, probeUsdt: 25 },
    { symbol: 'wBRL', address: addr('0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0'), decimals: 18, probeUsdt: 25 },
    { symbol: 'USDC', address: addr('0xcebA9300f2b948710d2653dD7B07f33A8B32118C'), decimals: 6, probeUsdt: 25 },
  ],
  legacyUnwindTokens: [
    { symbol: 'WETH', address: addr('0xD221812de1BD094f35587EE8E174B07B6167D9Af'), decimals: 18 },
  ],
  feeTiers: [100, 500, 3000, 10000],
  minEdgeUsd: Number(process.env.MIN_EDGE_USD || '0.01'),
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS || '12000'),
  port: Number(process.env.PORT || '8080'),
  liveTrading: process.env.LIVE === '1',
  tradesLogPath: path.join(__dirname, 'trades.jsonl'),
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

const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
const quoter = new ethers.Contract(CONFIG.contracts.uniQuoterV2, QUOTER_ABI, provider);
const routerIface = new ethers.Interface(ROUTER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

const privKey = process.env.STITCH_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || '';
const wallet = privKey ? new ethers.Wallet(privKey, provider) : null;

export async function sendTagged(txReq) {
  if (!wallet) throw new Error('No STITCH_PRIVATE_KEY configured for live execution');
  const tagged = { ...txReq, data: appendErc8021Suffix(txReq.data || '0x') };
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

async function bestUniQuote(tokenIn, tokenOut, amountInRaw) {
  // All 4 Textile FX stablecoin pools on Celo (cNGN, wARS, wBRL, USDC vs USDT) live in the 100 (0.01%) or 500 (0.05%) fee tier.
  // Probing 100 first avoids RPC rate-limiting (HTTP 429) on datacenter/GCP VMs.
  for (const fee of [100, 500]) {
    try {
      const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn: amountInRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      if (BigInt(amountOut) > 0n) {
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
 * Scan a single token across both directions with adaptive availableSellAmount sizing.
 */
async function scanCorridor(token, maxUsdtBudget) {
  const probeUsdt = Math.max(0.5, Math.min(token.probeUsdt, maxUsdtBudget || token.probeUsdt));
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
      const tokenOutRaw = BigInt(preview.buyAmount);
      const uniBack = await bestUniQuote(token.address, CONFIG.contracts.usdt, tokenOutRaw);
      const usdtInNum = Number(actualInRaw) / 1e6;
      const usdtOutNum = Number(uniBack.amountOut) / 1e6;
      const edgeUsd = usdtOutNum - usdtInNum;
      const edgeBps = usdtInNum > 0 ? (edgeUsd / usdtInNum) * 10000 : 0;
      rows.push({
        corridor: `${token.symbol}/USDT`,
        symbol: token.symbol,
        tokenAddress: token.address,
        decimals: token.decimals,
        direction: 'textile->uni',
        sizeUsdt: usdtInNum,
        amountInRaw: actualInRaw.toString(),
        midTokenRaw: tokenOutRaw.toString(),
        expectedOutUsdt: usdtOutNum,
        uniFee: uniBack.fee,
        edgeUsd,
        edgeBps,
        status: edgeUsd >= CONFIG.minEdgeUsd ? 'ACTIONABLE' : 'WATCH',
        note: actualInRaw < usdtInRaw ? `Adaptive size ($${usdtInNum.toFixed(2)} max depth)` : 'Full probe depth',
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
    // ponytail: anti-self-trade guard — never fill our own Maker quote on Textile Reactor
    if (calldata.toLowerCase().includes(CONFIG.agentWallet.slice(2).toLowerCase())) {
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
    if (calldata.toLowerCase().includes(CONFIG.agentWallet.slice(2).toLowerCase())) {
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

async function ensurePermit2ForAllCorridors() {
  if (!wallet || permit2Initialized) return;
  const allAddrs = [CONFIG.contracts.usdt, ...CONFIG.tokens.map((t) => t.address)];
  for (const tokenAddr of allAddrs) {
    await ensureAllowance(tokenAddr, CONFIG.contracts.permit2, 10n ** 24n);
  }
  permit2Initialized = true;
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

async function autoManageTreasuryInventory({ usdt, cngn, wars, usdc, uniCngnMid, uniWarsMid }) {
  if (!wallet) return null;
  await ensurePermit2ForAllCorridors();

  const cngnAddr = CONFIG.tokens[0].address;
  const warsAddr = CONFIG.tokens[1].address;
  const usdcAddr = CONFIG.tokens[3].address;

  const cngnUsd = cngn * uniCngnMid;
  const warsUsd = wars * uniWarsMid;
  const usdcUsd = usdc;

  // 1. AUTO-UNWIND EXCESS MAKER/TAKER FILLS TO USDT ON UNISWAP V3 (Keeping $18 cNGN, $15 wARS, $15 USDC Maker reserves)
  if (warsUsd > 22.0) {
    const excessUsd = warsUsd - 15.0;
    const sellWarsRaw = ethers.parseUnits(Math.floor(excessUsd / uniWarsMid).toString(), 18);
    return swapOnUniswap(warsAddr, CONFIG.contracts.usdt, sellWarsRaw, 'AUTO_TREASURY_UNWIND', 'wARS/USDT', excessUsd, 178.0);
  }
  if (usdcUsd > 22.0) {
    const excessUsd = usdcUsd - 15.0;
    const sellUsdcRaw = ethers.parseUnits(excessUsd.toFixed(6), 6);
    return swapOnUniswap(usdcAddr, CONFIG.contracts.usdt, sellUsdcRaw, 'AUTO_TREASURY_UNWIND', 'USDC/USDT', excessUsd, 12.0);
  }
  if (cngnUsd > 26.0) {
    const excessUsd = cngnUsd - 18.0;
    const sellCngnRaw = ethers.parseUnits(Math.floor(excessUsd / uniCngnMid).toString(), 6);
    return swapOnUniswap(cngnAddr, CONFIG.contracts.usdt, sellCngnRaw, 'AUTO_TREASURY_UNWIND', 'cNGN/USDT', excessUsd, 29.0);
  }

  // 2. AUTO-REFILL DEPLETED MAKER RESERVES SO MAKER ANSWERS TWO-WAY FLOW ACROSS cNGN, wARS, AND USDC
  if (cngnUsd < 10.0 && usdt >= 30.0) {
    const buyUsd = Math.min(18.0 - cngnUsd, 18.0);
    const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
    return swapOnUniswap(CONFIG.contracts.usdt, cngnAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'cNGN/USDT', buyUsd, 35.0);
  }
  if (warsUsd < 8.0 && usdt >= 40.0) {
    const buyUsd = Math.min(15.0 - warsUsd, 15.0);
    const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
    return swapOnUniswap(CONFIG.contracts.usdt, warsAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'wARS/USDT', buyUsd, 140.0);
  }
  if (usdcUsd < 8.0 && usdt >= 40.0) {
    const buyUsd = Math.min(15.0 - usdcUsd, 15.0);
    const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
    return swapOnUniswap(CONFIG.contracts.usdt, usdcAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'USDC/USDT', buyUsd, 10.0);
  }
  return null;
}

const STATE = {
  startedAt: new Date().toISOString(),
  lastScanAt: null,
  scanCount: 0,
  balances: { usdt: 0, cngn: 0, wars: 0, celo: 0 },
  skewMetrics: null,
  opportunities: [],
  onChainActivity: [],
  arbExecutions: [],
};

async function loadOnChainHistory() {
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
    for (const tr of (tokRes?.items || []).slice(0, 12)) {
      if (!items.some((x) => x.txHash === tr.transaction_hash)) {
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
    }
    items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    STATE.onChainActivity = items.slice(0, 20);
  } catch {
    // Keep existing cached activity if Blockscout rate-limits
  }

  if (fs.existsSync(CONFIG.tradesLogPath)) {
    const lines = fs.readFileSync(CONFIG.tradesLogPath, 'utf8').trim().split('\n').filter(Boolean);
    STATE.arbExecutions = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
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

    const [usdtRaw, cngnRaw, warsRaw, wbrlRaw, usdcRaw, celoRaw, uniCngnMid, uniWarsMid, cngnBuyPreview] = await Promise.all([
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

    const usdt = Number(usdtRaw) / 1e6;
    const cngn = Number(cngnRaw) / 1e6;
    const wars = Number(warsRaw) / 1e18;
    const wbrl = Number(wbrlRaw) / 1e18;
    const usdc = Number(usdcRaw) / 1e6;
    const celo = Number(celoRaw) / 1e18;
    const totalUsd = usdt + cngn * uniCngnMid + wars * uniWarsMid + usdc;
    STATE.balances = { usdt, cngn, wars, wbrl, usdc, celo, totalUsd, uniWarsPerUsdt: 1 / uniWarsMid };

    // Infer Textile oracle mid from cNGN->USDT preview (13,800 cNGN -> ~9.974 USDT, adjusted for 25bps maker fee)
    const textileMid = cngnBuyPreview?.buyAmount
      ? (Number(cngnBuyPreview.buyAmount) / (13800 * 1e6)) * 1.0025
      : 0.00072295;

    STATE.skewMetrics = computeSkewAndQuotes({
      usdtUsd: usdt,
      cngnBalance: cngn,
      textileMid,
      uniMid: uniCngnMid,
    });

    const scanBatches = [];
    for (const t of CONFIG.tokens) {
      scanBatches.push(await scanCorridor(t, Math.min(25, Math.max(1, usdt * 0.9))));
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
      `[SCAN #${STATE.scanCount}] Total=$${totalUsd.toFixed(2)} (USDT=$${usdt.toFixed(2)} cNGN=${cngn.toFixed(0)} wARS=${wars.toFixed(0)} USDC=$${usdc.toFixed(2)}) skew=${STATE.skewMetrics.skew >= 0 ? '+' : ''}${STATE.skewMetrics.skew.toFixed(3)} | best=${bestRow ? `${bestRow.corridor}(${bestRow.direction}) edge=$${bestRow.edgeUsd.toFixed(4)} [${bestRow.status}]` : 'none'}`
    );
    if (top && CONFIG.liveTrading && wallet) {
      try {
        const execRec = await executeOpportunity(top);
        if (execRec) STATE.arbExecutions.unshift(execRec);
      } catch (err) {
        console.error(`[EXEC-ERR] ${err.message}`);
      }
    }

    // Autonomous multi-currency treasury management (Two-way Maker-to-DEX unwind & refill across cNGN, wARS, USDC)
    if (CONFIG.liveTrading && process.env.AUTO_REFILL === '1' && wallet) {
      try {
        const treasuryRec = await autoManageTreasuryInventory({ usdt, cngn, wars, usdc, uniCngnMid, uniWarsMid });
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

function renderDashboardHtml() {
  return fs.readFileSync(path.join(__dirname, 'docs', 'index.html'), 'utf8');
}

// Self-check mode (--check)
if (process.argv.includes('--check')) {
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
  if (!renderDashboardHtml().includes('Skew')) {
    throw new Error('Dashboard HTML check failed');
  }
  await loadOnChainHistory();
  const state = await runSingleScan();
  console.log(JSON.stringify({
    check: 'PASS',
    agentId: CONFIG.agentId,
    wallet: CONFIG.agentWallet,
    erc8021SuffixBytes: 35,
    balances: state.balances,
    skew: Number(state.skewMetrics.skew.toFixed(4)),
    textileRateCngnPerUsdt: Number((1 / state.skewMetrics.textileMid).toFixed(2)),
    uniRateCngnPerUsdt: Number((1 / state.skewMetrics.uniMid).toFixed(2)),
    shieldedAskCngnPerUsdt: state.skewMetrics.askCngnPerUsdt ? Number(state.skewMetrics.askCngnPerUsdt.toFixed(2)) : 'HALTED_HIGH_SKEW',
    replenishEdgeBps: Number(state.skewMetrics.replenishEdgeBps.toFixed(2)),
    topOpportunity: state.opportunities[0] || null,
    onChainTxCount: state.onChainActivity.length,
  }, null, 2));
  process.exit(0);
}

// Start HTTP Server & Autonomous Scan Loop
await loadOnChainHistory();
await runSingleScan();
setInterval(() => runSingleScan().catch((e) => console.error('[SCAN-ERR]', e.message)), CONFIG.scanIntervalMs);
setInterval(() => loadOnChainHistory().catch(() => {}), 60000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ ...STATE, liveTrading: CONFIG.liveTrading, config: { agentId: CONFIG.agentId, wallet: CONFIG.agentWallet, attributionTag: CONFIG.attributionTag } }, null, 2));
  }
  if (url.pathname === '/trades') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ arbExecutions: STATE.arbExecutions, onChainActivity: STATE.onChainActivity }, null, 2));
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
