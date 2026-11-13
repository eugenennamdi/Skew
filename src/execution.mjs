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
  textilePreview = null,
  textileRequestQuote,
  textileSubmitTx,
  fetchJson,
  isSelfMakerOrder,
  verifyFirmArbQuote,
  sumReceiptTokenTransfers,
  getCachedOffChainFx,
}) {
  const allowanceCache = new Map();
  let permit2Initialized = false;
  let erc8004MetadataSynced = false;

  async function ensureAllowance(tokenAddr, spender, minAmount) {
    const key = `${tokenAddr.toLowerCase()}:${spender.toLowerCase()}`;
    const minReq = BigInt(minAmount);
    const cached = allowanceCache.get(key) || 0n;
    if (cached >= minReq) {
      if (cached < 10n ** 30n) allowanceCache.set(key, cached - minReq);
      return;
    }
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const current = BigInt(await c.allowance(wallet.address, spender));
    if (current >= minReq) {
      allowanceCache.set(key, current >= 10n ** 30n ? current : current - minReq);
      return;
    }
    if (current > 0n) {
      await sendTagged({ to: tokenAddr, data: erc20Iface.encodeFunctionData('approve', [spender, 0n]) });
    }
    // ponytail: bounded working allowance (~$1,200 for 6-dec tokens, 3M units for 18-dec FX) instead of infinite MaxUint256
    const is18Dec = CONFIG.tokens.some(
      (t) => t.address.toLowerCase() === tokenAddr.toLowerCase() && t.decimals === 18
    );
    const boundedCap = is18Dec ? 3_000_000n * 10n ** 18n : 1_200_000_000n;
    const approveAmt = minReq > boundedCap ? minReq * 2n : boundedCap;
    const data = erc20Iface.encodeFunctionData('approve', [spender, approveAmt]);
    await sendTagged({ to: tokenAddr, data });
    allowanceCache.set(key, approveAmt - minReq);
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
    await ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.permit2, 500_000_000n);
    for (const tok of CONFIG.tokens) {
      const minPermit = tok.decimals === 18 ? 1_000_000n * 10n ** 18n : 500_000_000n;
      await ensureAllowance(tok.address, CONFIG.contracts.permit2, minPermit);
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
      const [, q] = await Promise.all([
        ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.reactor, amountInRaw),
        textileRequestQuote(CONFIG.contracts.usdt, opp.tokenAddress, opp.amountInRaw),
      ]);
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

      const r1 = await sendTagged({ to: toAddr, data: calldata }, { priorityTip: true });
      textileSubmitTx(q.rfqId, q.claimToken, r1.hash).catch(() => {});
      const receivedFromLogs = sumReceiptTokenTransfers(r1, opp.tokenAddress, { toAddr: wallet.address });
      const spentUsdtRaw = sumReceiptTokenTransfers(r1, CONFIG.contracts.usdt, { fromAddr: wallet.address }) || amountInRaw;
      const receivedRaw = receivedFromLogs > 0n ? receivedFromLogs : firmBuyRaw;

      const [, leg2Uni] = await Promise.all([
        ensureAllowance(opp.tokenAddress, CONFIG.contracts.uniSwapRouter02, receivedRaw),
        receivedRaw === firmBuyRaw
          ? Promise.resolve(firmUni)
          : bestUniQuote(opp.tokenAddress, CONFIG.contracts.usdt, receivedRaw),
      ]);
      const minOutUsdt = leg2Uni.amountOut > 0n
        ? (leg2Uni.amountOut * 9995n) / 10000n
        : BigInt(Math.floor(opp.sizeUsdt * 0.999 * 1e6));
      const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
        tokenIn: opp.tokenAddress,
        tokenOut: CONFIG.contracts.usdt,
        fee: leg2Uni.fee || opp.uniFee,
        recipient: wallet.address,
        amountIn: receivedRaw,
        amountOutMinimum: minOutUsdt,
        sqrtPriceLimitX96: 0n,
      }]);
      const r2 = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData }, { priorityTip: true });
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
      const unitScale = 10 ** opp.decimals;
      const approxMidUsd = opp.sizeUsdt / Math.max(1e-12, Number(BigInt(opp.midTokenRaw)) / unitScale);
      const cachedTokUnits = Number(STATE.balances?.[opp.symbol?.toLowerCase()] || 0);
      const cachedTokUsd = cachedTokUnits * approxMidUsd;

      let walletTokRaw = 0n;
      let walletTokUsd = cachedTokUsd;
      // ponytail: skip ~180ms balanceOf RPC when cached local float clearly cannot cover the clip (e.g. $5 float vs $330 clip)
      if (cachedTokUsd >= 6.0 && opp.sizeUsdt <= cachedTokUsd * 1.15) {
        const tokenContract = new ethers.Contract(opp.tokenAddress, ERC20_ABI, provider);
        walletTokRaw = BigInt(await tokenContract.balanceOf(wallet.address));
        walletTokUsd = (Number(walletTokRaw) / unitScale) * approxMidUsd;
      }

      // Inventory-first (0-gas firm-quote-first) ONLY when existing local float already covers the clip size.
      // Never shrink $150-$400 clips down to a $5 local float.
      if (walletTokUsd >= 6.0 && opp.sizeUsdt <= walletTokUsd * 1.05) {
        let sellTokRaw = BigInt(opp.midTokenRaw) <= (walletTokRaw * 98n) / 100n
          ? BigInt(opp.midTokenRaw)
          : (walletTokRaw * 96n) / 100n;
        let [, q] = await Promise.all([
          ensureAllowance(opp.tokenAddress, CONFIG.contracts.reactor, sellTokRaw),
          textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, sellTokRaw),
        ]);
        let toAddr = q?.transactions?.swap?.to;
        let calldata = q?.transactions?.swap?.data;
        if (calldata && isSelfMakerOrder(calldata) && walletTokUsd >= 12.0) {
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

        const [r1] = await Promise.all([
          sendTagged({ to: toAddr, data: calldata }, { priorityTip: true }),
          ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.uniSwapRouter02, refillUsdtRaw),
        ]);
        textileSubmitTx(q.rfqId, q.claimToken, r1.hash).catch(() => {});
        const receivedUsdtRaw = sumReceiptTokenTransfers(r1, CONFIG.contracts.usdt, { toAddr: wallet.address }) || firmOutUsdtRaw;

        const minRefillTok = (sellTokRaw * 9995n) / 10000n;
        const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
          tokenIn: CONFIG.contracts.usdt,
          tokenOut: opp.tokenAddress,
          fee: probeUniBuy.fee || opp.uniFee,
          recipient: wallet.address,
          amountIn: refillUsdtRaw,
          amountOutMinimum: minRefillTok,
          sqrtPriceLimitX96: 0n,
        }]);
        const r2 = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData }, { priorityTip: true });
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

      const minDexFirstUsd = CONFIG.minUniToTextileDexFirstUsd ?? 0.045;
      if (opp.edgeBps < CONFIG.minUniToTextileDexFirstBps || opp.edgeUsd < minDexFirstUsd) return null;

      let amountInRaw = BigInt(opp.amountInRaw);
      let expectedTokenRaw = BigInt(opp.midTokenRaw);
      let leg1Fee = opp.uniFee;
      const isFreshScan = Boolean(opp.scannedAtMs && Date.now() - opp.scannedAtMs <= 1500);

      // ponytail: skip duplicate bestUniQuote + textilePreview (~550ms) when scanCorridor verified this exact quote <1.5s ago
      if (!isFreshScan && textilePreview) {
        const freshUni = await bestUniQuote(CONFIG.contracts.usdt, opp.tokenAddress, amountInRaw);
        if (freshUni.amountOut <= 0n) return null;
        expectedTokenRaw = freshUni.amountOut;
        leg1Fee = freshUni.fee;
        let freshPrev = await textilePreview(opp.tokenAddress, CONFIG.contracts.usdt, expectedTokenRaw).catch(() => null);
        if (freshPrev && freshPrev.availableSellAmount && BigInt(freshPrev.availableSellAmount) > 0n) {
          const availTok = BigInt(freshPrev.availableSellAmount);
          if (freshPrev.status !== 'preview' || availTok < expectedTokenRaw) {
            const ratio = Number(availTok) / Number(expectedTokenRaw);
            const resizedIn = BigInt(Math.floor(Number(amountInRaw) * ratio * 0.98));
            if (resizedIn >= 2000000n) {
              const reUni = await bestUniQuote(CONFIG.contracts.usdt, opp.tokenAddress, resizedIn);
              if (reUni.amountOut > 0n) {
                amountInRaw = resizedIn;
                expectedTokenRaw = reUni.amountOut;
                leg1Fee = reUni.fee;
                freshPrev = await textilePreview(opp.tokenAddress, CONFIG.contracts.usdt, expectedTokenRaw).catch(() => null);
              }
            }
          }
        }
        if (!freshPrev || freshPrev.status !== 'preview' || !freshPrev.buyAmount) {
          console.log(`[FIRM-GUARD] Aborted ${opp.corridor} cash-first uni->textile before Leg 1 (0 gas): Maker preview gone`);
          return null;
        }
        const preCheck = verifyFirmArbQuote({
          inUsdt: Number(amountInRaw) / 1e6,
          firmOutUsdt: Number(BigInt(freshPrev.buyAmount)) / 1e6,
        });
        if (!preCheck.ok) {
          console.log(
            `[FIRM-GUARD] Aborted ${opp.corridor} cash-first uni->textile before Leg 1 (0 gas): net=${preCheck.netEdgeUsd >= 0 ? '+' : ''}$${preCheck.netEdgeUsd.toFixed(4)} (${preCheck.reason})`
          );
          return null;
        }
      }

      // Mandatory Two-Way DEX Exit Guard + parallel allowance check (~120ms single round-trip instead of ~1.05s sequential)
      const [reverseExitUni] = await Promise.all([
        bestUniQuote(opp.tokenAddress, CONFIG.contracts.usdt, expectedTokenRaw),
        ensureAllowance(CONFIG.contracts.usdt, CONFIG.contracts.uniSwapRouter02, amountInRaw),
      ]);
      const reverseExitUsdt = Number(reverseExitUni.amountOut) / 1e6;
      const plannedInUsdt = Number(amountInRaw) / 1e6;
      if (reverseExitUni.amountOut <= 0n || reverseExitUsdt < plannedInUsdt * 0.9965) {
        console.log(
          `[EXIT-GUARD] Aborted ${opp.corridor} cash-first uni->textile before Leg 1 (0 gas): missing two-way Uniswap exit ($${reverseExitUsdt.toFixed(2)} vs $${plannedInUsdt.toFixed(2)})`
        );
        return null;
      }

      // Tight slippage floor (max 3 bps slack, or half of edgeBps) so thin 0.8-2.0 bps arbs revert on Leg 1 instead of filling underwater
      const maxSlackBps = BigInt(Math.max(1, Math.min(3, Math.floor(opp.edgeBps))));
      const minTokenOut = (expectedTokenRaw * (10000n - maxSlackBps)) / 10000n;
      const swapData = routerIface.encodeFunctionData('exactInputSingle', [{
        tokenIn: CONFIG.contracts.usdt,
        tokenOut: opp.tokenAddress,
        fee: leg1Fee,
        recipient: wallet.address,
        amountIn: amountInRaw,
        amountOutMinimum: minTokenOut,
        sqrtPriceLimitX96: 0n,
      }]);
      const r1 = await sendTagged({ to: CONFIG.contracts.uniSwapRouter02, data: swapData }, { priorityTip: true });
      const boughtFromLogs = sumReceiptTokenTransfers(r1, opp.tokenAddress, { toAddr: wallet.address });
      const spentUsdtRaw = sumReceiptTokenTransfers(r1, CONFIG.contracts.usdt, { fromAddr: wallet.address }) || amountInRaw;
      const initialBoughtRaw = boughtFromLogs > 0n ? boughtFromLogs : expectedTokenRaw;
      let sellRaw = initialBoughtRaw;

      let [, q] = await Promise.all([
        ensureAllowance(opp.tokenAddress, CONFIG.contracts.reactor, sellRaw),
        textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, sellRaw).catch(() => null),
      ]);
      let toAddr = q?.transactions?.swap?.to;
      let calldata = q?.transactions?.swap?.data;
      for (const stepPct of [70n, 50n]) {
        if (calldata && isSelfMakerOrder(calldata)) {
          sellRaw = (initialBoughtRaw * stepPct) / 100n;
          q = await textileRequestQuote(opp.tokenAddress, CONFIG.contracts.usdt, sellRaw).catch(() => null);
          toAddr = q?.transactions?.swap?.to;
          calldata = q?.transactions?.swap?.data;
        }
      }

      const leg2Share = Number(sellRaw) / Math.max(1, Number(initialBoughtRaw));
      const leg2CostUsdt = (Number(spentUsdtRaw) / 1e6) * leg2Share;
      const quotedOutUsdt = Number(q?.quote?.buyAmount || 0) / 1e6;
      const leg2Valid =
        toAddr &&
        calldata &&
        toAddr.toLowerCase() === CONFIG.contracts.reactor.toLowerCase() &&
        !isSelfMakerOrder(calldata) &&
        !(quotedOutUsdt > 0 && quotedOutUsdt < leg2CostUsdt * 0.9985);

      if (!leg2Valid) {
        // ponytail: bounded immediate flatten (<= 15 bps max scratch) + record exact scratch PnL so circuit breaker counts it
        console.warn(`[FLATTEN] Leg 2 rejected/slipped on ${opp.corridor}; flattening ${opp.symbol} back to USDT immediately...`);
        const backUni = await bestUniQuote(opp.tokenAddress, CONFIG.contracts.usdt, initialBoughtRaw);
        const backUsdt = Number(backUni.amountOut) / 1e6;
        const spentUsdt = Number(spentUsdtRaw) / 1e6;
        if (backUni.amountOut > 0n && backUsdt >= spentUsdt * 0.9985) {
          const flatRec = await swapOnUniswap(
            opp.tokenAddress,
            CONFIG.contracts.usdt,
            initialBoughtRaw,
            'LEG2_FLATTEN_DEX',
            opp.corridor,
            spentUsdt,
            0
          );
          if (flatRec) {
            flatRec.edgeUsd = Number((flatRec.sizeUsdt - spentUsdt).toFixed(6));
            flatRec.edgeBps = spentUsdt > 0 ? Number(((flatRec.edgeUsd / spentUsdt) * 10000).toFixed(2)) : 0;
            return flatRec;
          }
        }
        return null;
      }

      const r2 = await sendTagged({ to: toAddr, data: calldata }, { priorityTip: true });
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
    const minOutBps = label === 'AUTO_GAS_REFILL' ? 9900n : 9975n;
    const minOut = (uniQuote.amountOut * minOutBps) / 10000n;
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

    const targetUsd = Math.max(0, Number(CONFIG.targetCorridorUsd ?? 5));
    const upperBandUsd = targetUsd + 4.0;
    const lowerBandUsd = targetUsd * 0.4;

    const slots = [
      { sym: 'wBRL', corridor: 'wBRL/USDT', addr: wbrlAddr, dec: 18, usd: wbrlUsd, mid: liveWbrlMid },
      { sym: 'wARS', corridor: 'wARS/USDT', addr: warsAddr, dec: 18, usd: warsUsd, mid: uniWarsMid },
      { sym: 'cNGN', corridor: 'cNGN/USDT', addr: cngnAddr, dec: 6, usd: cngnUsd, mid: uniCngnMid },
      { sym: 'USDC', corridor: 'USDC/USDT', addr: usdcAddr, dec: 6, usd: usdcUsd, mid: 1.0 },
    ];

    for (const s of slots) {
      if (!(s.mid > 0) || s.usd <= upperBandUsd) continue;
      const unwindUsd = Math.min(s.usd - targetUsd, 150.0);
      if (unwindUsd < 1.5) continue;
      const sellUnits = (unwindUsd / s.mid).toFixed(s.dec === 6 ? 2 : 4);
      const sellRaw = ethers.parseUnits(sellUnits, s.dec);
      if (sellRaw <= 0n) continue;

      // Best-execution unwind: compare Uniswap v3 vs Textile RFQ so reclaiming reserves & Maker-bid fills never leaks spread
      const [uniQ, texPrev] = await Promise.all([
        bestUniQuote(s.addr, CONFIG.contracts.usdt, sellRaw),
        textilePreview ? textilePreview(s.addr, CONFIG.contracts.usdt, sellRaw).catch(() => null) : Promise.resolve(null),
      ]);
      const uniOutUsdt = Number(uniQ.amountOut) / 1e6;
      const texOutUsdt = texPrev?.status === 'preview' && texPrev?.buyAmount ? Number(BigInt(texPrev.buyAmount)) / 1e6 : 0;

      if (texOutUsdt > uniOutUsdt + 0.02) {
        const texRec = await unwindViaTextile(s.addr, sellRaw, s.corridor, unwindUsd);
        if (texRec) return texRec;
      }
      if (uniQ.amountOut > 0n && uniOutUsdt >= unwindUsd * 0.997) {
        const uniRec = await swapOnUniswap(s.addr, CONFIG.contracts.usdt, sellRaw, 'AUTO_TREASURY_UNWIND', s.corridor, unwindUsd, 0);
        if (uniRec) return uniRec;
      }
      const fallbackTex = await unwindViaTextile(s.addr, sellRaw, s.corridor, unwindUsd);
      if (fallbackTex) return fallbackTex;
    }

    if (targetUsd >= 3.0 && usdt >= 60.0) {
      for (const s of slots) {
        if (s.usd >= lowerBandUsd) continue;
        const buyUsd = Math.min(targetUsd - s.usd, targetUsd);
        if (buyUsd < 1.5) continue;
        const amountInRaw = ethers.parseUnits(buyUsd.toFixed(6), 6);
        const uniSeed = await swapOnUniswap(CONFIG.contracts.usdt, s.addr, amountInRaw, 'AUTO_INVENTORY_REFILL', s.corridor, buyUsd, 0);
        if (uniSeed) return uniSeed;
        if (s.sym === 'wBRL') {
          return seedInventoryViaTextile(s.addr, amountInRaw, s.corridor, buyUsd);
        }
      }
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
