/**
 * Skew v2 — Atomic 2-Leg Cross-Venue Execution, Auto-Treasury Rebalance & Blockscout Markout Ingestion
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

export function createExecutionManager({
  CONFIG,
  STATE,
  wallet,
  provider,
  routerIface,
  erc20Iface,
  sendTagged,
  bestUniQuote,
  textileRequestQuote,
  textileSubmitTx,
  fetchJson,
  isSelfMakerOrder,
  verifyFirmArbQuote,
  sumReceiptTokenTransfers,
  getCachedOffChainFx,
}) {
  const approvedMaxCache = new Set();
  let permit2Initialized = false;
  let erc8004MetadataSynced = false;

  async function ensureAllowance(tokenAddr, spender, minAmount) {
    const key = `${tokenAddr.toLowerCase()}:${spender.toLowerCase()}`;
    if (approvedMaxCache.has(key)) return;
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const current = BigInt(await c.allowance(wallet.address, spender));
    if (current >= 10n ** 30n) {
      approvedMaxCache.add(key);
      return;
    }
    if (current < BigInt(minAmount)) {
      if (current > 0n) {
        await sendTagged({ to: tokenAddr, data: erc20Iface.encodeFunctionData('approve', [spender, 0n]) });
      }
      const data = erc20Iface.encodeFunctionData('approve', [spender, ethers.MaxUint256]);
      await sendTagged({ to: tokenAddr, data });
      approvedMaxCache.add(key);
    }
  }

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
        const regJsonPath = path.join(REPO_ROOT, 'docs', '.well-known', 'agent-registration.json');
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

  async function settlePendingHoldings() {
    if (!wallet) return;
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
    console.log(`[EXEC] Attempting ${opp.corridor} (${opp.direction}) size=$${opp.sizeUsdt.toFixed(4)} previewEdge=+$${opp.edgeUsd.toFixed(4)}`);

    if (opp.direction === 'textile->uni') {
      const amountInRaw = BigInt(opp.amountInRaw);
      await ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.reactor, amountInRaw);
      const q = await textileRequestQuote(CONFIG.contracts.usdt, opp.tokenAddress, opp.amountInRaw);
      const toAddr = q?.transactions?.swap?.to;
      const calldata = q?.transactions?.swap?.data;
      if (!toAddr || !calldata || toAddr.toLowerCase() !== CONFIG.contracts.reactor.toLowerCase()) {
        throw new Error(`Invalid Textile quote response: ${JSON.stringify(q).slice(0, 140)}`);
      }
      if (isSelfMakerOrder(calldata)) {
        console.log(`[ANTI-SELF-TRADE] Skipping ${opp.corridor} taker order matched against our own Maker (${CONFIG.agentWallet})`);
        return null;
      }

      const firmBuyRaw = BigInt(q?.quote?.buyAmount || q?.buyAmount || 0);
      if (firmBuyRaw <= 0n) {
        console.log(`[FIRM-GUARD] Aborted ${opp.corridor} before Leg 1 (0 gas): missing firm buyAmount`);
        return null;
      }
      const firmUni = await bestUniQuote(opp.tokenAddress, CONFIG.contracts.usdt, firmBuyRaw);
      const inUsdt = Number(amountInRaw) / 1e6;
      const firmOutUsdt = Number(firmUni.amountOut) / 1e6;
      const firmCheck = verifyFirmArbQuote({ inUsdt, firmOutUsdt });
      if (!firmCheck.ok) {
        console.log(
          `[FIRM-GUARD] Aborted ${opp.corridor} before Leg 1 (0 gas): preview=+$${opp.edgeUsd.toFixed(4)} -> firmGross=${firmCheck.grossEdgeUsd >= 0 ? '+' : ''}$${firmCheck.grossEdgeUsd.toFixed(4)} (net=${firmCheck.netEdgeUsd >= 0 ? '+' : ''}$${firmCheck.netEdgeUsd.toFixed(4)}, ${firmCheck.netEdgeBps.toFixed(2)} bps, ${firmCheck.reason})`
        );
        return null;
      }

      const r1 = await sendTagged({ to: toAddr, data: calldata });
      textileSubmitTx(q.rfqId, q.claimToken, r1.hash).catch(() => {});
      const receivedFromLogs = sumReceiptTokenTransfers(r1, opp.tokenAddress, { toAddr: wallet.address });
      const spentUsdtRaw = sumReceiptTokenTransfers(r1, CONFIG.contracts.usdt, { fromAddr: wallet.address }) || amountInRaw;
      const receivedRaw = receivedFromLogs > 0n ? receivedFromLogs : firmBuyRaw;

      await ensureAllowance(opp.tokenAddress, CONFIG.contracts.uniSwapRouter02, receivedRaw);
      const leg2Uni = receivedRaw === firmBuyRaw
        ? firmUni
        : await bestUniQuote(opp.tokenAddress, CONFIG.contracts.usdt, receivedRaw);
      const minOutUsdt = leg2Uni.amountOut > 0n
        ? (leg2Uni.amountOut * 998n) / 1000n
        : BigInt(Math.floor(opp.sizeUsdt * 0.998 * 1e6));
      const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
        tokenIn: opp.tokenAddress,
        tokenOut: CONFIG.contracts.usdt,
        fee: leg2Uni.fee || opp.uniFee,
        recipient: wallet.address,
        amountIn: receivedRaw,
        amountOutMinimum: minOutUsdt,
        sqrtPriceLimitX96: 0n,
      }]);
      const r2 = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData });
      const returnedUsdtRaw = sumReceiptTokenTransfers(r2, CONFIG.contracts.usdt, { toAddr: wallet.address });
      const actualInUsdt = Number(spentUsdtRaw) / 1e6;
      const actualOutUsdt = returnedUsdtRaw > 0n ? Number(returnedUsdtRaw) / 1e6 : Number(leg2Uni.amountOut) / 1e6;
      const realizedEdgeUsd = actualOutUsdt - actualInUsdt;
      const realizedEdgeBps = actualInUsdt > 0 ? (realizedEdgeUsd / actualInUsdt) * 10000 : 0;
      console.log(
        `[EXEC-OK] ${opp.corridor} (${opp.direction}) in=$${actualInUsdt.toFixed(4)} -> out=$${actualOutUsdt.toFixed(4)} realizedEdge=${realizedEdgeUsd >= 0 ? '+' : ''}$${realizedEdgeUsd.toFixed(4)} (${realizedEdgeBps.toFixed(2)} bps)`
      );
      const rec = {
        timestamp: startedAt,
        type: 'CROSS_VENUE_ARB',
        corridor: opp.corridor,
        direction: opp.direction,
        sizeUsdt: actualInUsdt,
        edgeUsd: Number(realizedEdgeUsd.toFixed(6)),
        edgeBps: Number(realizedEdgeBps.toFixed(2)),
        txHash1: r1.hash,
        txHash2: r2.hash,
        attributionTag: CONFIG.attributionTag,
      };
      fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
      return rec;
    }

    if (opp.direction === 'uni->textile') {
      const tokenContract = new ethers.Contract(opp.tokenAddress, ERC20_ABI, provider);
      const walletTokRaw = BigInt(await tokenContract.balanceOf(wallet.address));
      const unitScale = 10 ** opp.decimals;
      const approxMidUsd = opp.sizeUsdt / Math.max(1e-12, Number(BigInt(opp.midTokenRaw)) / unitScale);
      const walletTokUsd = (Number(walletTokRaw) / unitScale) * approxMidUsd;

      if (walletTokUsd >= 10.0 && (opp.sizeUsdt <= walletTokUsd * 1.05 || opp.edgeBps < CONFIG.minUniToTextileDexFirstBps)) {
        let sellTokRaw = BigInt(opp.midTokenRaw) <= (walletTokRaw * 98n) / 100n
          ? BigInt(opp.midTokenRaw)
          : (walletTokRaw * 96n) / 100n;
        await ensureAllowance(opp.tokenAddress, CONFIG.contracts.reactor, sellTokRaw);
        let q = await textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, sellTokRaw);
        let toAddr = q?.transactions?.swap?.to;
        let calldata = q?.transactions?.swap?.data;
        if (calldata && isSelfMakerOrder(calldata) && walletTokUsd >= 20.0) {
          sellTokRaw = sellTokRaw / 2n;
          q = await textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, sellTokRaw);
          toAddr = q?.transactions?.swap?.to;
          calldata = q?.transactions?.swap?.data;
        }
        if (!toAddr || !calldata || toAddr.toLowerCase() !== CONFIG.contracts.reactor.toLowerCase()) {
          throw new Error(`Invalid Textile quote response on inventory-first uni->textile: ${JSON.stringify(q).slice(0, 140)}`);
        }
        if (isSelfMakerOrder(calldata)) {
          console.log(`[ANTI-SELF-TRADE] Skipping ${opp.corridor} inventory-first uni->textile matched against our own Maker`);
          return null;
        }
        const firmOutUsdtRaw = BigInt(q?.quote?.buyAmount || q?.buyAmount || 0);
        if (firmOutUsdtRaw <= 0n) return null;

        const probeUniBuy = await bestUniQuote(CONFIG.contracts.usdt, opp.tokenAddress, firmOutUsdtRaw);
        if (probeUniBuy.amountOut <= sellTokRaw) {
          console.log(`[FIRM-GUARD] Aborted ${opp.corridor} inventory-first uni->textile (0 gas): Uniswap refill <= sold tokens`);
          return null;
        }
        const refillUsdtRaw = (firmOutUsdtRaw * sellTokRaw) / probeUniBuy.amountOut + 2000n;
        const firmOutUsdt = Number(firmOutUsdtRaw) / 1e6;
        const refillInUsdt = Number(refillUsdtRaw) / 1e6;
        const firmCheck = verifyFirmArbQuote({ inUsdt: refillInUsdt, firmOutUsdt });
        if (!firmCheck.ok) {
          console.log(
            `[FIRM-GUARD] Aborted ${opp.corridor} inventory-first uni->textile (0 gas): firmGross=${firmCheck.grossEdgeUsd >= 0 ? '+' : ''}$${firmCheck.grossEdgeUsd.toFixed(4)} (${firmCheck.reason})`
          );
          return null;
        }

        const r1 = await sendTagged({ to: toAddr, data: calldata });
        textileSubmitTx(q.rfqId, q.claimToken, r1.hash).catch(() => {});
        const receivedUsdtRaw = sumReceiptTokenTransfers(r1, CONFIG.contracts.usdt, { toAddr: wallet.address }) || firmOutUsdtRaw;

        await ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.uniSwapRouter02, refillUsdtRaw);
        const minRefillTok = (sellTokRaw * 998n) / 1000n;
        const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
          tokenIn: CONFIG.contracts.usdt,
          tokenOut: opp.tokenAddress,
          fee: probeUniBuy.fee || opp.uniFee,
          recipient: wallet.address,
          amountIn: refillUsdtRaw,
          amountOutMinimum: minRefillTok,
          sqrtPriceLimitX96: 0n,
        }]);
        const r2 = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData });
        const spentRefillRaw = sumReceiptTokenTransfers(r2, CONFIG.contracts.usdt, { fromAddr: wallet.address }) || refillUsdtRaw;
        const actualInUsdt = Number(spentRefillRaw) / 1e6;
        const actualOutUsdt = Number(receivedUsdtRaw) / 1e6;
        const realizedEdgeUsd = actualOutUsdt - actualInUsdt;
        const realizedEdgeBps = actualInUsdt > 0 ? (realizedEdgeUsd / actualInUsdt) * 10000 : 0;
        console.log(
          `[EXEC-OK] ${opp.corridor} (uni->textile inv-first) refill=$${actualInUsdt.toFixed(4)} -> firmOut=$${actualOutUsdt.toFixed(4)} realizedEdge=${realizedEdgeUsd >= 0 ? '+' : ''}$${realizedEdgeUsd.toFixed(4)} (${realizedEdgeBps.toFixed(2)} bps)`
        );
        const rec = {
          timestamp: startedAt,
          type: 'CROSS_VENUE_ARB',
          corridor: opp.corridor,
          direction: opp.direction,
          sizeUsdt: actualInUsdt,
          edgeUsd: Number(realizedEdgeUsd.toFixed(6)),
          edgeBps: Number(realizedEdgeBps.toFixed(2)),
          txHash1: r1.hash,
          txHash2: r2.hash,
          attributionTag: CONFIG.attributionTag,
        };
        fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
        return rec;
      }

      if (opp.edgeBps < CONFIG.minUniToTextileDexFirstBps || opp.edgeUsd < 0.045) return null;
      const amountInRaw = BigInt(opp.amountInRaw);
      await ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.uniSwapRouter02, amountInRaw);
      const minTokenOut = (BigInt(opp.midTokenRaw) * 998n) / 1000n;
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
      const boughtFromLogs = sumReceiptTokenTransfers(r1, opp.tokenAddress, { toAddr: wallet.address });
      const spentUsdtRaw = sumReceiptTokenTransfers(r1, CONFIG.contracts.usdt, { fromAddr: wallet.address }) || amountInRaw;
      const initialBoughtRaw = boughtFromLogs > 0n ? boughtFromLogs : BigInt(opp.midTokenRaw);
      let sellRaw = initialBoughtRaw;

      await ensureAllowance(opp.tokenAddress, CONFIG.contracts.reactor, sellRaw);
      let q = await textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, sellRaw);
      let toAddr = q?.transactions?.swap?.to;
      let calldata = q?.transactions?.swap?.data;
      if (calldata && isSelfMakerOrder(calldata)) {
        sellRaw = sellRaw / 2n;
        q = await textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, sellRaw);
        toAddr = q?.transactions?.swap?.to;
        calldata = q?.transactions?.swap?.data;
      }
      if (!toAddr || !calldata || toAddr.toLowerCase() !== CONFIG.contracts.reactor.toLowerCase()) {
        throw new Error(`Invalid Textile quote response on leg 2: ${JSON.stringify(q).slice(0, 140)}`);
      }
      if (isSelfMakerOrder(calldata)) {
        console.log(`[ANTI-SELF-TRADE] Skipping uni->textile leg 2 matched against our own Maker (${CONFIG.agentWallet})`);
        return null;
      }
      const leg2CostUsdt = sellRaw === initialBoughtRaw
        ? Number(spentUsdtRaw) / 1e6
        : (Number(spentUsdtRaw) / 1e6) * 0.5;
      const quotedOutUsdt = Number(q?.quote?.buyAmount || 0) / 1e6;
      if (quotedOutUsdt > 0 && quotedOutUsdt < leg2CostUsdt * 0.9985) {
        console.log(`[FIRM-GUARD] Skipping uni->textile leg 2 underwater quote ($${quotedOutUsdt.toFixed(4)} vs $${leg2CostUsdt.toFixed(4)})`);
        return null;
      }
      const r2 = await sendTagged({ to: toAddr, data: calldata });
      textileSubmitTx(q.rfqId, q.claimToken, r2.hash).catch(() => {});
      const returnedUsdtRaw = sumReceiptTokenTransfers(r2, CONFIG.contracts.usdt, { toAddr: wallet.address });
      const actualInUsdt = leg2CostUsdt;
      const actualOutUsdt = returnedUsdtRaw > 0n
        ? Number(returnedUsdtRaw) / 1e6
        : (quotedOutUsdt || opp.expectedOutUsdt);
      const realizedEdgeUsd = actualOutUsdt - actualInUsdt;
      const realizedEdgeBps = actualInUsdt > 0 ? (realizedEdgeUsd / actualInUsdt) * 10000 : 0;
      console.log(
        `[EXEC-OK] ${opp.corridor} (uni->textile full) in=$${actualInUsdt.toFixed(4)} -> out=$${actualOutUsdt.toFixed(4)} realizedEdge=${realizedEdgeUsd >= 0 ? '+' : ''}$${realizedEdgeUsd.toFixed(4)} (${realizedEdgeBps.toFixed(2)} bps)`
      );
      const rec = {
        timestamp: startedAt,
        type: 'CROSS_VENUE_ARB',
        corridor: opp.corridor,
        direction: opp.direction,
        sizeUsdt: actualInUsdt,
        edgeUsd: Number(realizedEdgeUsd.toFixed(6)),
        edgeBps: Number(realizedEdgeBps.toFixed(2)),
        txHash1: r1.hash,
        txHash2: r2.hash,
        attributionTag: CONFIG.attributionTag,
      };
      fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
      return rec;
    }
    return null;
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
    const returnedUsdtRaw = tokenOut.toLowerCase() === CONFIG.contracts.usdt.toLowerCase()
      ? sumReceiptTokenTransfers(r, CONFIG.contracts.usdt, { toAddr: wallet.address })
      : 0n;
    const effectiveUsdt = returnedUsdtRaw > 0n ? Number(returnedUsdtRaw) / 1e6 : sizeUsdt;
    const rec = {
      timestamp: new Date().toISOString(),
      type: label,
      corridor,
      direction: `uni_v3_fee_${uniQuote.fee}`,
      sizeUsdt: Number(effectiveUsdt.toFixed(6)),
      edgeUsd: Number(((effectiveUsdt * edgeBps) / 10000).toFixed(6)),
      edgeBps,
      txHash1: r.hash,
      txHash2: r.hash,
      attributionTag: CONFIG.attributionTag,
    };
    fs.appendFileSync(CONFIG.tradesLogPath, JSON.stringify(rec) + '\n');
    console.log(`[TREASURY] ${label} on ${corridor} ($${effectiveUsdt.toFixed(2)}) -> tx ${r.hash}`);
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
    const quotedUsdt = Number(q?.quote?.buyAmount || 0) / 1e6;
    if (quotedUsdt > 0 && quotedUsdt < sizeUsdt * 0.996) {
      console.log(`[TREASURY] Skipping ${corridor} Textile unwind: quoted $${quotedUsdt.toFixed(2)} < 99.6% of $${sizeUsdt.toFixed(2)} (leaving for passive Maker SELL)`);
      return null;
    }
    const r = await sendTagged({ to: toAddr, data: calldata });
    await textileSubmitTx(q.rfqId, q.claimToken, r.hash).catch(() => {});
    const outUsdt = quotedUsdt || sizeUsdt;
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
    const offChainFx = getCachedOffChainFx();
    const liveWbrlMid = STATE.textileMids?.wBRL || (1 / (offChainFx.BRL || 5.40));
    const wbrlUsd = wbrl * liveWbrlMid;
    const usdcUsd = usdc;

    if (wbrlUsd > 36.0) {
      const unwindUsd = Math.min(wbrlUsd - 24.0, 30.0);
      const sellWbrlRaw = ethers.parseUnits(Math.floor(unwindUsd / liveWbrlMid).toString(), 18);
      const uniUnwind = await swapOnUniswap(wbrlAddr, CONFIG.contracts.usdt, sellWbrlRaw, 'AUTO_TREASURY_UNWIND', 'wBRL/USDT', unwindUsd, 0);
      if (uniUnwind) return uniUnwind;
      return unwindViaTextile(wbrlAddr, sellWbrlRaw, 'wBRL/USDT', unwindUsd);
    }
    if (warsUsd > 38.0) {
      const excessUsd = warsUsd - 26.0;
      const sellWarsRaw = ethers.parseUnits(Math.floor(excessUsd / uniWarsMid).toString(), 18);
      return swapOnUniswap(warsAddr, CONFIG.contracts.usdt, sellWarsRaw, 'AUTO_TREASURY_UNWIND', 'wARS/USDT', excessUsd, 0);
    }
    if (usdcUsd > 28.0) {
      const excessUsd = usdcUsd - 20.0;
      const sellUsdcRaw = ethers.parseUnits(excessUsd.toFixed(6), 6);
      return swapOnUniswap(usdcAddr, CONFIG.contracts.usdt, sellUsdcRaw, 'AUTO_TREASURY_UNWIND', 'USDC/USDT', excessUsd, 0);
    }
    if (cngnUsd > 38.0) {
      const excessUsd = cngnUsd - 26.0;
      const sellCngnRaw = ethers.parseUnits(Math.floor(excessUsd / uniCngnMid).toString(), 6);
      return swapOnUniswap(cngnAddr, CONFIG.contracts.usdt, sellCngnRaw, 'AUTO_TREASURY_UNWIND', 'cNGN/USDT', excessUsd, 0);
    }

    if (cngnUsd < 17.0 && usdt >= 45.0) {
      const buyUsd = Math.min(26.0 - cngnUsd, 26.0);
      const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
      return swapOnUniswap(CONFIG.contracts.usdt, cngnAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'cNGN/USDT', buyUsd, 0);
    }
    if (warsUsd < 17.0 && usdt >= 45.0) {
      const buyUsd = Math.min(26.0 - warsUsd, 26.0);
      const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
      return swapOnUniswap(CONFIG.contracts.usdt, warsAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'wARS/USDT', buyUsd, 0);
    }
    if (usdcUsd < 12.0 && usdt >= 45.0) {
      const buyUsd = Math.min(20.0 - usdcUsd, 20.0);
      const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
      return swapOnUniswap(CONFIG.contracts.usdt, usdcAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'USDC/USDT', buyUsd, 0);
    }
    if (wbrlUsd < 10.0 && usdt >= 45.0) {
      const buyUsd = Math.min(20.0 - wbrlUsd, 20.0);
      const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
      const uniSeed = await swapOnUniswap(CONFIG.contracts.usdt, wbrlAddr, amountInRaw, 'AUTO_INVENTORY_REFILL', 'wBRL/USDT', buyUsd, 0);
      if (uniSeed) return uniSeed;
      return seedInventoryViaTextile(wbrlAddr, amountInRaw, 'wBRL/USDT', buyUsd);
    }
    return null;
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

  return {
    ensureErc8004Metadata,
    settlePendingHoldings,
    executeOpportunity,
    autoManageTreasuryInventory,
    persistMarkoutRecords,
    loadOnChainHistory,
  };
}
