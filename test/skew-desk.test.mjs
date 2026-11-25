import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  CONFIG,
  PREVIEW_BUDGET,
  MAX_UNI_QUOTE_GAS,
  OFFCHAIN_FX_DEFAULTS,
  appendErc8021Suffix,
  computeSkewAndQuotes,
  computeSliceSizesUsdt,
  computeRegionalBankingSession,
  computeRiskOfficerDecisions,
  updateCorridorQuantState,
  evaluateMarkoutAdjustments,
  clampLlmCorridorDecision,
  buildGeminiSupervisorPrompt,
  runGeminiRiskSupervisor,
  syncStitchRuntimeConfig,
  syncStitchRuntimePolicy,
  isSelfMakerOrder,
  isValidUniQuoteGas,
  estimateLiveArbGasUsd,
  verifyFirmArbQuote,
  sumReceiptTokenTransfers,
  renderDashboardHtml,
  runDryRunVerification,
  validatePrivateKey,
  validateOutboundTx,
  evaluateCircuitBreaker,
  interpolateLadderBuyAmount,
  buildLadderCandidates,
  scanTokenFromLadder,
  scanUniverseFromLadder,
  selectChaseCandidates,
  fetchTextileLadder,
  LADDER_BUDGET,
  computeDynamicPriorityTipGwei,
  getMaxFlashSliceUsdt,
} from '../skew-desk.mjs';
import {
  verifyCommittedOnChainLedger,
  evaluateMakerFillVsFixedBaseline,
} from '../scripts/verify-onchain-pnl.mjs';
import { createExecutionManager } from '../src/execution.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

test('1. Celo Mainnet (42220) configuration & ERC-8004 Agent #9905 identity', () => {
  assert.equal(CONFIG.chainId, 42220);
  assert.equal(CONFIG.agentId, 9905);
  assert.equal(CONFIG.agentWallet, '0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324');
  assert.equal(CONFIG.contracts.erc8004Registry, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
  assert.equal(CONFIG.contracts.reactor, '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3');
  assert.equal(CONFIG.contracts.permit2, '0x000000000022D473030F116dDEE9F6B43aC78BA3');
  const expectUsat = process.env.ENABLE_USAT === '1';
  assert.deepEqual(
    CONFIG.tokens.map((t) => t.symbol),
    expectUsat ? ['cNGN', 'wARS', 'wBRL', 'USDC', 'USAT'] : ['cNGN', 'wARS', 'wBRL', 'USDC']
  );
  assert.deepEqual(
    CONFIG.tokens.map((t) => t.decimals),
    expectUsat ? [6, 18, 18, 6, 6] : [6, 18, 18, 6]
  );
});

test('2. ERC-8021 attribution suffix appends exact 35-byte tag idempotently', () => {
  const selector = '0x095ea7b3';
  const tagged = appendErc8021Suffix(selector);
  assert.ok(tagged.startsWith(selector));
  assert.ok(tagged.endsWith(CONFIG.erc8021SuffixHex));
  assert.equal((tagged.length - 2) / 2, 4 + 35);

  // Calling appendErc8021Suffix twice must be idempotent
  assert.equal(appendErc8021Suffix(tagged), tagged);

  // Decode the 17-byte ASCII attribution code (`celo_7935fb97e273`)
  const asciiHex = CONFIG.erc8021SuffixHex.slice(0, 34);
  assert.equal(Buffer.from(asciiHex, 'hex').toString('utf8'), 'celo_7935fb97e273');
});

test('3. Avellaneda-Stoikov inventory skew symmetry at 50/50 balance', () => {
  const balanced = computeSkewAndQuotes({
    usdtUsd: 100,
    cngnBalance: 100 / 0.000725,
    textileMid: 0.000725,
    uniMid: 0.000725,
    baseBuyBps: 25,
    baseSellBps: 35,
    gammaBps: 30,
  });
  assert.ok(Math.abs(balanced.skew) < 1e-6);
  assert.equal(balanced.dynamicBuyBps, 25);
  assert.equal(balanced.dynamicSellBps, 35);
});

test('4. Dual-Oracle Comparison Shield anchors SELL to max(P_textile, P_uni) and BUY to min(P_textile, P_uni)', () => {
  const shielded = computeSkewAndQuotes({
    usdtUsd: 150,
    cngnBalance: 25000,
    textileMid: 0.00072295, // 1383.22 cNGN/USDT
    uniMid: 0.00072538,     // 1378.59 cNGN/USDT (cNGN is more expensive on DEX)
  });
  assert.equal(shielded.effectiveSellMid, 0.00072538);
  assert.equal(shielded.effectiveBuyMid, 0.00072295);
  assert.ok(shielded.replenishEdgeBps > 30, 'Shielded ask must lock in positive DEX replenishment edge');
});

test('5. Inventory exhaustion guard halts SELL when local reserve is depleted (skew >= +0.85, local < $1)', () => {
  const depletedCngn = computeSkewAndQuotes({
    usdtUsd: 190,
    cngnBalance: 100, // ~$0.07
    textileMid: 0.000723,
    uniMid: 0.000725,
  });
  assert.ok(depletedCngn.skew >= 0.85);
  assert.equal(depletedCngn.dynamicSellBps, null);
  assert.equal(depletedCngn.sellHaltedBySkew, true);
  assert.equal(depletedCngn.dynamicBuyBps, 6);
});

test('6. Inventory exhaustion guard halts BUY when USDT is depleted (skew <= -0.85, USDT < $1)', () => {
  const depletedUsdt = computeSkewAndQuotes({
    usdtUsd: 0.25,
    cngnBalance: 260000, // ~$188
    textileMid: 0.000723,
    uniMid: 0.000725,
  });
  assert.ok(depletedUsdt.skew <= -0.85);
  assert.equal(depletedUsdt.dynamicBuyBps, null);
  assert.ok(depletedUsdt.dynamicSellBps >= 6);
});

test('7. MAX_TICK gas-griefing filter rejects 17.04M gas wBRL/USDT pool and accepts healthy pools', () => {
  assert.equal(MAX_UNI_QUOTE_GAS, 800000n);
  assert.equal(isValidUniQuoteGas(53890000000000000000n, 145000n), true);
  assert.equal(isValidUniQuoteGas(53890000000000000000n, 800000n), true);
  assert.equal(isValidUniQuoteGas(53890000000000000000n, 17039337n), false);
  assert.equal(isValidUniQuoteGas(0n, 120000n), false);
});

test('8. Anti-self-trade calldata filter detects our own Maker address in real LimitOrderReactor fill calldata', () => {
  // Real ABI-encoded LimitOrderReactor.execute((bytes order, bytes sig)) calldata from Celo Mainnet tx
  // 0xa7998f8818477463df200fc1001fd849ff0a41a21b208df29b8e119b489b3700 (OrderInfo.reactor + OrderInfo.swapper = Skew 0xe5036100...7324)
  const realSkewMakerFillCalldata =
    '0x3f62192e' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000240' +
    '0000000000000000000000000000000000000000000000000000000000000200' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '000000000000000000000000a9aa0a64769cbed4d3b1ceb4df01cde915c235b3' +
    '000000000000000000000000e5036100b4a32b83d5e1997d403ce64a4c7f7324' +
    '0000000000000000000000000000000000000000000000000000000000018a91' +
    '00000000000000000000000000000000000000000000000000000000690f94ec' +
    '63656c6f5f373933356662393765323733110080218021802180218021802180218021';

  // Real ABI-encoded LimitOrderReactor.execute((bytes order, bytes sig)) calldata from Celo Mainnet tx
  // 0xd0855bf83154261c63c9939e14164501aa9c3f1d74a15bc8f92a35cf215a4a1b (OrderInfo.reactor + OrderInfo.swapper = External Maker 0x25a5c1ae...ab52)
  const realExternalMakerFillCalldata =
    '0x3f62192e' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000240' +
    '0000000000000000000000000000000000000000000000000000000000000200' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '000000000000000000000000a9aa0a64769cbed4d3b1ceb4df01cde915c235b3' +
    '00000000000000000000000025a5c1ae6a47e5c57941a69b54ce6fc52e7cab52' +
    '0000000000000000000000000000000000000000000000000000000000004f12' +
    '00000000000000000000000000000000000000000000000000000000690f9520' +
    '63656c6f5f373933356662393765323733110080218021802180218021802180218021';

  assert.equal(isSelfMakerOrder(realSkewMakerFillCalldata), true);
  assert.equal(isSelfMakerOrder(realExternalMakerFillCalldata), false);
});

test('9. Multi-slice trade sizing computes 100%, 75%, 50%, 35%, 20% of 92% liquid USDT budget and enforces $400 cap', () => {
  const slices = computeSliceSizesUsdt(140.0, 150.0);
  assert.deepEqual(slices, [128.8, 96.6, 64.4, 45.08, 25.76, 25]);

  const capped = computeSliceSizesUsdt(500.0, 400.0);
  assert.deepEqual(capped, [400, 300, 200, 140, 80, 25]);
});

test('10. Private key format validation rejects malformed keys and allows empty read-only mode', () => {
  assert.equal(validatePrivateKey(''), null);
  assert.equal(validatePrivateKey('   '), null);
  const sampleKey = '0x' + '11'.repeat(32);
  assert.equal(validatePrivateKey(sampleKey), sampleKey);
  assert.throws(() => validatePrivateKey('not-a-private-key'), /Invalid STITCH_PRIVATE_KEY format/);
  assert.throws(() => validatePrivateKey('0x1234'), /Invalid STITCH_PRIVATE_KEY format/);
});

test('11. Autonomous Risk Officer includes 3-source FX basis and emerging-market daily carry', () => {
  const skewMetrics = computeSkewAndQuotes({
    usdtUsd: 140.3,
    cngnBalance: 24885,
    textileMid: 0.00072295,
    uniMid: 0.00072538,
  });
  const risk = computeRiskOfficerDecisions({
    usdt: 140.3,
    cngn: 24885,
    wars: 24741,
    wbrl: 80.5,
    usdc: 14.98,
    uniCngnMid: 0.00072538,
    uniWarsMid: 0.00060455,
    skewMetrics,
  });
  assert.equal(risk.enabled, true);
  assert.equal(risk.corridors.length, 4);
  assert.deepEqual(
    risk.corridors.map((c) => c.dailyCarryBps),
    [8.5, 13.3, 4.2, 0.0]
  );
  assert.equal(risk.corridors[0].offChainPerUsd, OFFCHAIN_FX_DEFAULTS.NGN);
  assert.equal(risk.corridors[1].offChainPerUsd, OFFCHAIN_FX_DEFAULTS.ARS);
});

test('12. Dry-run sandbox verification passes offline', () => {
  const dry = runDryRunVerification();
  assert.equal(dry.check, 'PASS');
  assert.equal(dry.mode, 'DRY_RUN_SANDBOX');
  assert.equal(dry.chainId, 42220);
  assert.equal(dry.agentId, 9905);
  assert.equal(dry.erc8021SuffixBytes, 35);
});

test('13. ERC-8004 registration-v1 JSON metadata conforms to EIP-8004 specification', () => {
  const regJsonPath = path.join(repoRoot, 'docs', '.well-known', 'agent-registration.json');
  const regJson = JSON.parse(fs.readFileSync(regJsonPath, 'utf8'));
  assert.equal(regJson.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  assert.ok(Array.isArray(regJson.registrations) && regJson.registrations.length > 0);
  assert.equal(regJson.registrations[0].agentId, 9905);
});

test('14. stitch.toml matches Celo Mainnet (42220), Agent #9905, and all 4 Textile FX corridors', () => {
  const toml = fs.readFileSync(path.join(repoRoot, 'stitch.toml'), 'utf8');
  assert.match(toml, /agent_id\s*=\s*9905/);
  assert.match(toml, /chain_id\s*=\s*42220/);
  for (const tok of CONFIG.tokens.filter((t) => t.symbol !== 'USAT')) {
    assert.ok(
      toml.toLowerCase().includes(tok.address.toLowerCase()),
      `stitch.toml must include ${tok.symbol} (${tok.address})`
    );
  }
});

test('15. Dashboard HTML & documentation include MiniPay detection, CIP-64 feeCurrency, mobile responsive layout, and Livestream rubric telemetry', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('ERC-8004'));
  assert.ok(html.includes('isMiniPay'));
  assert.ok(html.includes('FEE_CURRENCY_USDT'));
  assert.ok(html.includes('computeRegionalBankingSession'));
  assert.ok(html.includes('Parallel FX &amp; Carry'));
  assert.ok(html.includes('dolarapi.com'));
  assert.ok(html.includes('@media (max-width: 720px)'));
  assert.ok(fs.existsSync(path.join(repoRoot, 'docs', 'STRATEGY.md')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'reports', 'EVIDENCE.md')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(repoRoot, '.env.example')));
});

test('16. Cross-document snapshot metrics and LaTeX formulas are 100% consistent across README, EVIDENCE, and STRATEGY', () => {
  const docsToCheck = ['README.md', 'reports/EVIDENCE.md', 'docs/STRATEGY.md'];
  const snapshotMetrics = [
    '#82,263,550',
    '3,911',
    '9,996',
    '179',
    '6,527.97',
    '1,794',
    '193,344.64',
    '207,057.11',
    '414,114.22',
    '1,061.8x',
    '195.00',
    '296.43',
    '290.58',
    '95.58',
    '49.02%',
    '101.43',
    '52.02%',
    '5.85',
  ];
  for (const relPath of docsToCheck) {
    const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    assert.ok(!content.includes('\\;'), `${relPath} must not contain broken LaTeX \\; spacing escapes`);
    for (const metric of snapshotMetrics) {
      assert.ok(content.includes(metric), `${relPath} must include synchronized snapshot metric ${metric}`);
    }
  }
});

test('17. Regional central-bank session clock adjusts spreads and carry for weekday open, overnight, and 72h weekend closures', () => {
  // Wednesday 14:00 UTC: Lagos (07-15), Buenos Aires (13-18), Sao Paulo (12-20) all OPEN
  const wedOpen = new Date('2026-10-28T14:00:00Z');
  assert.equal(computeRegionalBankingSession('cNGN', wedOpen).session, 'CBN_LAGOS_OPEN');
  assert.equal(computeRegionalBankingSession('cNGN', wedOpen).spreadBufferBps, 0);
  assert.equal(computeRegionalBankingSession('wARS', wedOpen).session, 'BCRA_BUE_OPEN');
  assert.equal(computeRegionalBankingSession('wBRL', wedOpen).session, 'BCB_SAO_OPEN');
  assert.equal(computeRegionalBankingSession('USDC', wedOpen).session, 'GLOBAL_USD_24_7');

  // Wednesday 22:00 UTC: Overnight banking closure
  const wedNight = new Date('2026-10-28T22:00:00Z');
  assert.equal(computeRegionalBankingSession('cNGN', wedNight).session, 'CBN_LAGOS_OVERNIGHT');
  assert.equal(computeRegionalBankingSession('cNGN', wedNight).spreadBufferBps, 2);
  assert.equal(computeRegionalBankingSession('wARS', wedNight).session, 'BCRA_BUE_OVERNIGHT');
  assert.equal(computeRegionalBankingSession('wARS', wedNight).spreadBufferBps, 3);

  // Sunday 15:00 UTC: 72-hour weekend banking closure
  const sunWeekend = new Date('2026-11-01T15:00:00Z');
  const cngnWknd = computeRegionalBankingSession('cNGN', sunWeekend);
  const warsWknd = computeRegionalBankingSession('wARS', sunWeekend);
  const wbrlWknd = computeRegionalBankingSession('wBRL', sunWeekend);
  assert.equal(cngnWknd.session, 'CBN_LAGOS_WEEKEND_CLOSED');
  assert.equal(cngnWknd.spreadBufferBps, 5);
  assert.equal(cngnWknd.carryMultiplier, 3.0);
  assert.equal(warsWknd.session, 'BCRA_BUE_WEEKEND_CLOSED');
  assert.equal(warsWknd.spreadBufferBps, 6);
  assert.equal(wbrlWknd.session, 'BCB_SAO_WEEKEND_CLOSED');
  assert.equal(wbrlWknd.spreadBufferBps, 4);
});

test('18. Autonomous stitch.runtime.toml config rewriter atomically updates corridor offsets by banking regime', () => {
  const skewMetrics = computeSkewAndQuotes({
    usdtUsd: 164.7,
    cngnBalance: 24855,
    textileMid: 0.00072295,
    uniMid: 0.00072538,
  });
  const weekendRisk = computeRiskOfficerDecisions({
    usdt: 164.7,
    cngn: 24855,
    wars: 24728,
    wbrl: 80.5,
    usdc: 14.98,
    uniCngnMid: 0.00072538,
    uniWarsMid: 0.00060455,
    skewMetrics,
    now: new Date('2026-11-01T15:00:00Z'), // Sunday weekend regime
  });

  const tmpRuntimePath = path.join(os.tmpdir(), `stitch.runtime.${Date.now()}.toml`);
  try {
    const syncRes = syncStitchRuntimeConfig(weekendRisk, path.join(repoRoot, 'stitch.toml'), tmpRuntimePath);
    assert.equal(syncRes.updated, true);
    const written = fs.readFileSync(tmpRuntimePath, 'utf8');
    // Sunday weekend closure adds +5 bps to cNGN (3 + 5 = 8) and +6 bps to wARS (3 + 6 = 9)
    assert.match(written, /sell_offset_bps\s*=\s*8/);
    assert.match(written, /sell_offset_bps\s*=\s*9/);
  } finally {
    if (fs.existsSync(tmpRuntimePath)) fs.unlinkSync(tmpRuntimePath);
  }
});

test('19. Rolling EWMA volatility (lambda=0.94), structural FX basis shock detector, and 72h carry blend', () => {
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  // Steady structural +300 bps cNGN premium does NOT trigger basis shock buffer
  let st = updateCorridorQuantState(null, { mid: 1 / 1423.0, offChainPerUsd: 1381.5, priorCarryBps: 8.5, nowMs: t0 });
  assert.equal(st.basisBufferBps, 0);
  assert.equal(st.dailyCarryBps, 8.5);

  // Sudden +200 bps devaluation tick triggers EWMA volatility buffer + structural basis shock buffer + measured carry blend
  st = updateCorridorQuantState(st, {
    mid: 1 / 1452.0,
    offChainPerUsd: 1381.5,
    priorCarryBps: 8.5,
    nowMs: t0 + 24 * 3600_000,
  });
  assert.ok(st.ewmaVolBps > 40);
  assert.ok(st.volBufferBps > 0);
  assert.ok(st.basisShockBps > 80);
  assert.ok(st.basisBufferBps > 0);
  assert.ok(st.dailyCarryBps > 8.5, 'Depreciation over 24h increases blended daily carry above prior');
});

test('20. Post-fill +1m/+5m markout loop widens spread on toxic adverse selection and tightens on benign flow', () => {
  const nowMs = Date.now();
  const toxicRecords = [
    { txHash: '0xaaa', tsMs: nowMs - 360_000, symbol: 'cNGN', side: 'SELL', midAtFill: 0.000720, mid1m: null, mid5m: null, markout1mBps: null, markout5mBps: null },
  ];
  // Price rose +100 bps against our SELL fill -> negative markout -> positive markoutBufferBps
  const toxicEval = evaluateMarkoutAdjustments(toxicRecords, { cNGN: 0.0007272, wARS: 0.0006, wBRL: 0.18, USDC: 1.0 }, nowMs);
  assert.ok(toxicRecords[0].markout5mBps < -90);
  assert.ok(toxicEval.bySymbol.cNGN.markoutBufferBps >= 15);

  const benignRecords = [
    { txHash: '0xbbb', tsMs: nowMs - 360_000, symbol: 'USDC', side: 'SELL', midAtFill: 1.0008, mid1m: null, mid5m: null, markout1mBps: null, markout5mBps: null },
  ];
  const benignEval = evaluateMarkoutAdjustments(benignRecords, { cNGN: 0.000725, wARS: 0.0006, wBRL: 0.18, USDC: 1.0000 }, nowMs);
  assert.ok(benignRecords[0].markout5mBps > 5);
  assert.equal(benignEval.bySymbol.USDC.markoutBufferBps, -1);
});

test('21. Bounded Gemini LLM Desk Head clamps wild outputs, prevents feedback loops, and fails open on HTTP errors', async () => {
  const clamped = clampLlmCorridorDecision({
    corridor: 'wARS/USDT',
    action: 'PAUSE_SELL',
    addBuyBps: 999,
    addSellBps: 999,
    gammaBps: -50,
    pauseMinutes: 9999,
    rationale: 'Extreme BCRA weekend volatility',
  }, 1000);
  assert.equal(clamped.addBuyBps, 25);
  assert.equal(clamped.addSellBps, 40);
  assert.equal(clamped.gammaBps, 2);
  assert.equal(clamped.pauseMinutes, 45);
  assert.equal(clamped.pausedUntilMs, 1000 + 45 * 60_000);

  const prompt = buildGeminiSupervisorPrompt([{ corridor: 'cNGN/USDT', bankingSession: 'CBN_LAGOS_OPEN', inventoryUsd: 24, skew: 0.02, ewmaVolBps: 3.1, oracleDispersionBps: 12, offChainBasisBps: 210, basisShockBps: 8, effectiveCarryBps: 8.5, avgMarkoutBps: 1.4, scoredMarkoutFills: 3, llmRationale: 'DO_NOT_ECHO_PAST_REASON' }]);
  assert.ok(!prompt.includes('DO_NOT_ECHO_PAST_REASON'), 'Prompt must never feed prior LLM rationale back into itself');

  const okRes = await runGeminiRiskSupervisor({
    corridors: [{ corridor: 'cNGN/USDT', bankingSession: 'CBN_LAGOS_OPEN', inventoryUsd: 24, skew: 0, oracleDispersionBps: 10, offChainBasisBps: 100, effectiveCarryBps: 8.5 }],
    apiKey: 'test-gemini-key',
    persistLog: false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                marketRegimeSummary: 'Calm CBN Lagos session; tightening cNGN slightly',
                corridors: [{ corridor: 'cNGN/USDT', action: 'WIDEN', addBuyBps: 2, addSellBps: 6, gammaBps: 9, pauseMinutes: 0, rationale: 'Mild dispersion buffer' }],
              }),
            }],
          },
        }],
      }),
    }),
  });
  assert.equal(okRes.status, 'ACTIVE_BOUNDED');
  assert.equal(okRes.decisions['cNGN/USDT'].addSellBps, 6);
  assert.equal(okRes.decisions['cNGN/USDT'].gammaBps, 9);

  // Simulated 500 outage must fail open without throwing
  const degradedRes = await runGeminiRiskSupervisor({
    corridors: [],
    apiKey: 'test-gemini-key',
    persistLog: false,
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'Service Unavailable' }),
  });
  assert.equal(degradedRes.status, 'DEGRADED_FAIL_OPEN');
  assert.deepEqual(degradedRes.decisions, {});
});

test('22. Zero-restart skew-policy.json hot-reloader writes checksummed per-corridor policy & multi-corridor share weights', () => {
  const skewMetrics = computeSkewAndQuotes({
    usdtUsd: 160,
    cngnBalance: 33000,
    textileMid: 0.000723,
    uniMid: 0.000725,
  });
  const risk = computeRiskOfficerDecisions({
    usdt: 160,
    cngn: 33000,
    wars: 36000,
    wbrl: 120,
    usdc: 20,
    uniCngnMid: 0.000725,
    uniWarsMid: 0.000605,
    skewMetrics,
    llmOverlay: {
      status: 'ACTIVE_BOUNDED',
      model: 'gemini-3.8-flash',
      reviewedAt: new Date().toISOString(),
      marketRegimeSummary: 'Weekend protection',
      decisions: {
        'wARS/USDT': clampLlmCorridorDecision({ corridor: 'wARS/USDT', action: 'PAUSE_SELL', addSellBps: 12, gammaBps: 10, pauseMinutes: 20, rationale: 'BCRA weekend shock' }),
      },
    },
  });
  const tmpPolicyPath = path.join(os.tmpdir(), `skew-policy.${Date.now()}.json`);
  try {
    const res = syncStitchRuntimePolicy(risk, tmpPolicyPath);
    assert.equal(res.updated, true);
    const parsed = JSON.parse(fs.readFileSync(tmpPolicyPath, 'utf8'));
    const warsEntry = parsed.corridors[CONFIG.tokens[1].address];
    assert.equal(warsEntry.pause_sell, true);
    assert.equal(warsEntry.gamma_bps, 10);
    assert.equal(warsEntry.usdt_share_weight, 0.15);
    assert.ok(Math.abs(risk.corridors[0].skew) < 0.15, 'Normalized cNGN skew ($24 vs $24 allocated) centers near 0.0');
  } finally {
    if (fs.existsSync(tmpPolicyPath)) fs.unlinkSync(tmpPolicyPath);
  }
});

test('23. Pre-flight firm-quote guard rejects bait-and-slip & sub-gas trades and receipt parser extracts exact realized USDT', () => {
  // 1. Historical preview-to-firm bait-and-slip ($132.9032 in -> $132.7805 firm out) must abort with 0 gas
  const slipped = verifyFirmArbQuote({ inUsdt: 132.9032, firmOutUsdt: 132.7805 });
  assert.equal(slipped.ok, false);
  assert.equal(slipped.reason, 'firm_quote_underwater');

  // 2. Sub-gas scratch trade ($136.3100 in -> $136.3150 firm out, +$0.005 gross < $0.006 gas) must abort
  const scratch = verifyFirmArbQuote({ inUsdt: 136.31, firmOutUsdt: 136.315 });
  assert.equal(scratch.ok, false);
  assert.equal(scratch.reason, 'below_min_net_usd');

  // 3. Single-maker $35 top-of-book slice at +10 bps ($35.00 -> $35.035, net +$0.029 / +8.29 bps) passes
  const topSlice = verifyFirmArbQuote({ inUsdt: 35.0, firmOutUsdt: 35.035 });
  assert.equal(topSlice.ok, true);
  assert.ok(topSlice.netEdgeUsd >= 0.028);

  // 4. Full $135 slice at +25 bps ($135.00 -> $135.3375, net +$0.3315) passes
  const fullSlice = verifyFirmArbQuote({ inUsdt: 135.0, firmOutUsdt: 135.3375 });
  assert.equal(fullSlice.ok, true);
  assert.ok(fullSlice.netEdgeBps > 24);

  // 5. Receipt Transfer log parser extracts exact wallet inflows/outflows immune to RPC lag & external fills
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ourTopic = '0x' + CONFIG.agentWallet.slice(2).toLowerCase().padStart(64, '0');
  const poolTopic = '0x' + CONFIG.contracts.cngnUsdtPool.slice(2).toLowerCase().padStart(64, '0');
  const mockReceipt = {
    logs: [
      {
        address: CONFIG.contracts.usdt,
        topics: [transferTopic, poolTopic, ourTopic],
        data: '0x' + (135337500n).toString(16).padStart(64, '0'),
      },
      {
        address: CONFIG.contracts.usdt,
        topics: [transferTopic, poolTopic, '0x' + '99'.repeat(20).padStart(64, '0')],
        data: '0x' + (999999999n).toString(16).padStart(64, '0'),
      },
    ],
  };
  const receivedUsdtRaw = sumReceiptTokenTransfers(mockReceipt, CONFIG.contracts.usdt, { toAddr: CONFIG.agentWallet });
  assert.equal(receivedUsdtRaw, 135337500n);
});

test('24. Calm-market clamp blocks routine overnight LLM over-widening while preserving real stress protection', () => {
  const skewMetrics = computeSkewAndQuotes({
    usdtUsd: 160,
    cngnBalance: 35000,
    textileMid: 0.000723,
    uniMid: 0.000725,
  });

  // 1. Weekday overnight (Wednesday 23:00 UTC) + aggressive LLM WIDEN (+10/+15 bps) in calm market (ewmaVol=2.1, shock=9):
  //    cNGN & wARS stay competitive at top-of-book (buy=3, sell=3 + 1 overnight + 1 clamped LLM = 5 bps)
  const calmOvernight = computeRiskOfficerDecisions({
    usdt: 160,
    cngn: 35000,
    wars: 42000,
    wbrl: 130,
    usdc: 20,
    uniCngnMid: 0.000725,
    uniWarsMid: 0.000605,
    skewMetrics,
    now: new Date('2026-11-04T23:00:00Z'), // Wednesday overnight
    quantBySymbol: {
      cNGN: { samples: 5, ewmaVolBps: 2.1, basisShockBps: 9, volBufferBps: 0, basisBufferBps: 0, dailyCarryBps: 8.5 },
      wARS: { samples: 5, ewmaVolBps: 3.4, basisShockBps: 14, volBufferBps: 0, basisBufferBps: 0, dailyCarryBps: 13.3 },
    },
    llmOverlay: {
      status: 'ACTIVE_BOUNDED',
      model: 'gemini-3.8-flash',
      reviewedAt: '2026-11-04T23:00:00Z',
      decisions: {
        'cNGN/USDT': clampLlmCorridorDecision({ corridor: 'cNGN/USDT', action: 'WIDEN', addBuyBps: 10, addSellBps: 15, gammaBps: 6, rationale: 'Overnight carry' }),
        'wARS/USDT': clampLlmCorridorDecision({ corridor: 'wARS/USDT', action: 'WIDEN', addBuyBps: 12, addSellBps: 18, gammaBps: 6, rationale: 'Overnight carry' }),
      },
    },
  });
  const calmCngn = calmOvernight.corridors.find((c) => c.corridor === 'cNGN/USDT');
  const calmWars = calmOvernight.corridors.find((c) => c.corridor === 'wARS/USDT');
  assert.equal(calmCngn.stitchBuyOffsetBps, 3);
  assert.equal(calmCngn.stitchSellOffsetBps, 5);
  assert.equal(calmWars.stitchBuyOffsetBps, 3);
  assert.equal(calmWars.stitchSellOffsetBps, 5);

  // 2. Genuine volatility shock (ewmaVol=24 bps > 12 bps) unlocks full LLM + EWMA widening
  const stressed = computeRiskOfficerDecisions({
    usdt: 160,
    cngn: 35000,
    wars: 42000,
    wbrl: 130,
    usdc: 20,
    uniCngnMid: 0.000725,
    uniWarsMid: 0.000605,
    skewMetrics,
    now: new Date('2026-11-04T23:00:00Z'),
    quantBySymbol: {
      wARS: { samples: 5, ewmaVolBps: 24.0, basisShockBps: 95, volBufferBps: 18, basisBufferBps: 8, dailyCarryBps: 18.0 },
    },
    llmOverlay: {
      status: 'ACTIVE_BOUNDED',
      model: 'gemini-3.8-flash',
      reviewedAt: '2026-11-04T23:00:00Z',
      decisions: {
        'wARS/USDT': clampLlmCorridorDecision({ corridor: 'wARS/USDT', action: 'WIDEN', addBuyBps: 10, addSellBps: 18, gammaBps: 9, rationale: 'BCRA volatility shock' }),
      },
    },
  });
  const stressedWars = stressed.corridors.find((c) => c.corridor === 'wARS/USDT');
  assert.ok(stressedWars.stitchSellOffsetBps >= 45, `Expected full stress protection >= 45 bps, got ${stressedWars.stitchSellOffsetBps}`);
});

test('25. GitHub Pages .nojekyll, ERC-8004 agent-registration.json, and honest live RPC dashboard PnL are intact', () => {
  assert.ok(fs.existsSync(path.join(repoRoot, 'docs', '.nojekyll')), 'docs/.nojekyll must exist so GitHub Pages serves .well-known/agent-registration.json');
  const reg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs', '.well-known', 'agent-registration.json'), 'utf8'));
  assert.equal(reg.registrations?.[0]?.agentId, 9905);
  assert.equal(reg.attribution?.erc8021, 'celo_7935fb97e273');

  const html = fs.readFileSync(path.join(repoRoot, 'docs', 'index.html'), 'utf8');
  assert.ok(!html.includes('extraArbs * 0.045') && !html.includes('Math.max(liveNavPnlUsdt'), 'docs/index.html must never synthetically extrapolate PnL per nonce');
  assert.ok(html.includes('BASE_NONCE = 3911'), 'docs/index.html must anchor to verified Block #82,263,550 checkpoint');
  assert.ok(html.includes('/llm'), 'docs/index.html must poll /llm telemetry when connected to localhost or ?api=');
});

test('26. Committed on-chain P&L ledger reconciles Realized vs. Mark-to-Market, 179 independent Maker fills, RFQ funnel, and Fixed-Spread baselines', () => {
  const ledger = verifyCommittedOnChainLedger();
  assert.equal(ledger.pnlDecomposition.totalRealizedPnlUsdt, 95.97);
  assert.equal(ledger.pnlDecomposition.realizedMakerFillsPnlUsdt, 4.85);
  assert.equal(ledger.pnlDecomposition.realizedTakerArbPnlUsdt, 91.12);
  assert.equal(ledger.pnlDecomposition.unrealizedInventoryMtmUsdt, -0.39);
  assert.equal(ledger.pnlDecomposition.markToMarketLiquidNavUsdt, 290.58);
  assert.equal(ledger.independentMakerActivity.independentMakerFillsCount, 179);
  assert.equal(ledger.independentMakerActivity.selfTradesIncludedInMakerCount, 0);
  assert.equal(ledger.rfqQuoteFunnel.quotesAnswered, 1412);
  assert.equal(ledger.rfqQuoteFunnel.quotesFilled, 179);
  assert.equal(ledger.rfqQuoteFunnel.competitivePriceSharePct, 68.41);

  const singleFillEval = evaluateMakerFillVsFixedBaseline({
    usdNotional: 50.0,
    oracleLagBps: 31.8,
    skewSpreadBps: 9.8,
  });
  assert.ok(singleFillEval.skewRealizedPnlUsd > 0);
  assert.ok(singleFillEval.fixed5RealizedPnlUsd < 0);
});

test('27. Root stitch.toml and textile-stitch/stitch.toml are 100% synced and skew-policy.json bridges ewma_vol_bps, markout_toxicity_bps, and session_horizon_hours', () => {
  const rootToml = fs.readFileSync(path.join(repoRoot, 'stitch.toml'), 'utf8');
  const rustToml = fs.readFileSync(path.join(repoRoot, 'textile-stitch', 'stitch.toml'), 'utf8');
  assert.equal(rootToml, rustToml, 'stitch.toml and textile-stitch/stitch.toml must be identical');
  assert.match(rootToml, /book_enabled\s*=\s*true/);
  assert.match(rootToml, /twap_window_secs\s*=\s*120/);
  assert.match(rootToml, /lean_enabled\s*=\s*true/);

  const skewMetrics = computeSkewAndQuotes({ usdtUsd: 160, cngnBalance: 35000, textileMid: 0.000723, uniMid: 0.000725 });
  const risk = computeRiskOfficerDecisions({
    usdt: 160,
    cngn: 35000,
    wars: 42000,
    wbrl: 130,
    usdc: 20,
    uniCngnMid: 0.000725,
    uniWarsMid: 0.000605,
    skewMetrics,
    now: new Date('2026-11-01T15:00:00Z'), // Weekend 72h horizon
    quantBySymbol: { cNGN: { samples: 6, ewmaVolBps: 14.2, basisShockBps: 25, volBufferBps: 8, basisBufferBps: 0, dailyCarryBps: 8.5 } },
    markoutBySymbol: { cNGN: { scoredFills: 4, avgMarkoutBps: -6.5, markoutBufferBps: 8 } },
  });
  const tmpPolicyPath = path.join(os.tmpdir(), `skew-policy.bridge.${Date.now()}.json`);
  try {
    syncStitchRuntimePolicy(risk, tmpPolicyPath);
    const parsed = JSON.parse(fs.readFileSync(tmpPolicyPath, 'utf8'));
    const cngnEntry = parsed.corridors[CONFIG.tokens[0].address];
    assert.equal(cngnEntry.ewma_vol_bps, 14.2);
    assert.equal(cngnEntry.markout_toxicity_bps, 6.5);
    assert.equal(cngnEntry.session_horizon_hours, 72.0);
    assert.equal(cngnEntry.lean_floor_bps, 1.0);
  } finally {
    if (fs.existsSync(tmpPolicyPath)) fs.unlinkSync(tmpPolicyPath);
  }
});

test('28. Post-hackathon Phase 1 profit-max engine uncaps slices to $400, accepts 0.55 bps Textile-first edges, and enforces 2.5 bps positive-EV floor on cash-first uni->textile', () => {
  assert.equal(CONFIG.maxSliceUsdt, 400);
  assert.equal(CONFIG.targetCorridorUsd, 5);
  assert.equal(CONFIG.minEdgeUsd, 0.012);
  assert.equal(CONFIG.minEdgeBps, 0.55);
  assert.equal(CONFIG.minUniToTextileDexFirstBps, 2.5);
  assert.equal(CONFIG.minUniToTextileDexFirstUsd, 0.045);
  assert.equal(CONFIG.chaseIntervalMs, 1000);

  // $340 clip at +0.60 bps (+$0.0204 gross, +$0.0174 net after $0.003 gas) passes firm-quote verification
  const thinLargeClip = verifyFirmArbQuote({ inUsdt: 340.0, firmOutUsdt: 340.0204 });
  assert.equal(thinLargeClip.ok, true);
  assert.ok(thinLargeClip.netEdgeUsd >= 0.017);
  assert.ok(thinLargeClip.netEdgeBps >= 0.5);

  // Compact $5 float mode widens Maker baseBuy to 8 bps (5 bps USDC) so Rust 0.05 weight clamp never collapses Maker bid to 1 bps
  const skewMetrics = computeSkewAndQuotes({ usdtUsd: 355, cngnBalance: 6900, textileMid: 0.000723, uniMid: 0.000725 });
  const compactRisk = computeRiskOfficerDecisions({
    usdt: 355,
    cngn: 6900, // ~$5
    wars: 7300, // ~$5
    wbrl: 27,   // ~$5
    usdc: 5,    // ~$5
    uniCngnMid: 0.000725,
    uniWarsMid: 0.000685,
    skewMetrics,
    now: new Date('2026-11-04T14:00:00Z'), // Weekday open
    targetCorridorUsd: 5,
    maxSliceUsdt: 400,
  });
  const cngnCompact = compactRisk.corridors.find((c) => c.corridor === 'cNGN/USDT');
  const usdcCompact = compactRisk.corridors.find((c) => c.corridor === 'USDC/USDT');
  assert.equal(cngnCompact.stitchBuyOffsetBps, 8);
  assert.equal(usdcCompact.stitchBuyOffsetBps, 5);
  assert.equal(compactRisk.sliceSizesUsdt[0], 326.6);
});

test('29. Security & Capital-Protection Hardening: Outbound Transaction Firewall, Circuit Breaker Kill Switch, Loopback Bind, and SHA-256 Pin', () => {
  const routerIface = new ethers.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  ]);
  const erc20Iface = new ethers.Interface([
    'function approve(address,uint256) returns (bool)',
    'function transfer(address,uint256) returns (bool)',
  ]);
  const attacker = '0x1111111111111111111111111111111111111111';

  // 1. Valid Reactor execute & executeBatch, valid Router swap to our wallet, valid bounded approve to Reactor pass
  assert.equal(validateOutboundTx({ to: CONFIG.contracts.reactor, data: '0x3f62192e0000' }, CONFIG.agentWallet), true);
  assert.equal(validateOutboundTx({ to: CONFIG.contracts.reactor, data: '0x0d7a16c30000' }, CONFIG.agentWallet), true);
  const validSwapData = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn: CONFIG.contracts.usdt,
    tokenOut: CONFIG.tokens[0].address,
    fee: 100,
    recipient: CONFIG.agentWallet,
    amountIn: 100_000000n,
    amountOutMinimum: 99_900000n,
    sqrtPriceLimitX96: 0n,
  }]);
  assert.equal(validateOutboundTx({ to: CONFIG.contracts.uniSwapRouter02, data: validSwapData }, CONFIG.agentWallet), true);
  const validApprove = erc20Iface.encodeFunctionData('approve', [CONFIG.contracts.reactor, 1_200_000_000n]);
  assert.equal(validateOutboundTx({ to: CONFIG.contracts.usdt, data: validApprove }, CONFIG.agentWallet), true);

  // 2. Malicious txs are blocked before wallet.sendTransaction is ever reached
  assert.throws(
    () => validateOutboundTx({ to: CONFIG.contracts.reactor, data: '0x3f62192e0000', value: 1n }, CONFIG.agentWallet),
    /non-zero native CELO value prohibited/
  );
  assert.throws(
    () => validateOutboundTx({ to: attacker, data: '0x3f62192e0000' }, CONFIG.agentWallet),
    /not in contract allowlist/
  );
  const drainTransfer = erc20Iface.encodeFunctionData('transfer', [attacker, 350_000000n]);
  assert.throws(
    () => validateOutboundTx({ to: CONFIG.contracts.usdt, data: drainTransfer }, CONFIG.agentWallet),
    /only ERC-20 approve\(\) permitted/
  );
  const rogueSpenderApprove = erc20Iface.encodeFunctionData('approve', [attacker, 350_000000n]);
  assert.throws(
    () => validateOutboundTx({ to: CONFIG.contracts.usdt, data: rogueSpenderApprove }, CONFIG.agentWallet),
    /unauthorized ERC-20 approve spender/
  );
  const hijackedRecipientSwap = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn: CONFIG.contracts.usdt,
    tokenOut: CONFIG.tokens[0].address,
    fee: 100,
    recipient: attacker,
    amountIn: 100_000000n,
    amountOutMinimum: 99_900000n,
    sqrtPriceLimitX96: 0n,
  }]);
  assert.throws(
    () => validateOutboundTx({ to: CONFIG.contracts.uniSwapRouter02, data: hijackedRecipientSwap }, CONFIG.agentWallet),
    /recipient mismatch/
  );
  const unvettedTokenSwap = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn: CONFIG.contracts.usdt,
    tokenOut: attacker,
    fee: 100,
    recipient: CONFIG.agentWallet,
    amountIn: 100_000000n,
    amountOutMinimum: 99_900000n,
    sqrtPriceLimitX96: 0n,
  }]);
  assert.throws(
    () => validateOutboundTx({ to: CONFIG.contracts.uniSwapRouter02, data: unvettedTokenSwap }, CONFIG.agentWallet),
    /unvetted token/
  );
  // Bounded $2.00 AUTO_GAS_REFILL (USDT -> CELO <= $5) passes firewall, while oversized ($50) or reverse (CELO -> USDT) are blocked
  const validGasRefillSwap = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn: CONFIG.contracts.usdt,
    tokenOut: CONFIG.contracts.celo,
    fee: 100,
    recipient: CONFIG.agentWallet,
    amountIn: 2_000000n,
    amountOutMinimum: 30n * 10n ** 18n,
    sqrtPriceLimitX96: 0n,
  }]);
  assert.equal(validateOutboundTx({ to: CONFIG.contracts.uniSwapRouter02, data: validGasRefillSwap }, CONFIG.agentWallet), true);
  const oversizedGasRefill = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn: CONFIG.contracts.usdt,
    tokenOut: CONFIG.contracts.celo,
    fee: 100,
    recipient: CONFIG.agentWallet,
    amountIn: 50_000000n,
    amountOutMinimum: 1n,
    sqrtPriceLimitX96: 0n,
  }]);
  assert.throws(
    () => validateOutboundTx({ to: CONFIG.contracts.uniSwapRouter02, data: oversizedGasRefill }, CONFIG.agentWallet),
    /unvetted token/
  );
  const reverseCeloSell = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn: CONFIG.contracts.celo,
    tokenOut: CONFIG.contracts.usdt,
    fee: 100,
    recipient: CONFIG.agentWallet,
    amountIn: 10n * 10n ** 18n,
    amountOutMinimum: 1n,
    sqrtPriceLimitX96: 0n,
  }]);
  assert.throws(
    () => validateOutboundTx({ to: CONFIG.contracts.uniSwapRouter02, data: reverseCeloSell }, CONFIG.agentWallet),
    /unvetted token/
  );

  // 3. Circuit breaker trips on 2 consecutive losses, single >= $0.35 loss, or >= $1.00 24h loss
  const nowMs = Date.now();
  const ts = new Date(nowMs - 60_000).toISOString();
  assert.equal(evaluateCircuitBreaker([{ type: 'CROSS_VENUE_ARB', edgeUsd: 0.045, timestamp: ts }], nowMs).tripped, false);
  assert.equal(
    evaluateCircuitBreaker(
      [
        { type: 'LEG2_FLATTEN_DEX', edgeUsd: -0.04, timestamp: ts },
        { type: 'CROSS_VENUE_ARB', edgeUsd: -0.03, timestamp: ts },
      ],
      nowMs
    ).reason,
    'consecutive_losses'
  );
  // Pre-restart historical entries before sessionStartMs never dead-lock a freshly booted session
  assert.equal(
    evaluateCircuitBreaker(
      [
        { type: 'LEG2_FLATTEN_DEX', edgeUsd: -0.04, timestamp: ts },
        { type: 'CROSS_VENUE_ARB', edgeUsd: -0.03, timestamp: ts },
        { type: 'CROSS_VENUE_ARB', edgeUsd: 5.99, timestamp: ts },
      ],
      nowMs,
      CONFIG,
      nowMs - 5_000
    ).tripped,
    false
  );
  // Consecutive-loss pause auto-resumes after 15-minute cooldown
  const oldLossTs = new Date(nowMs - 20 * 60_000).toISOString();
  assert.equal(
    evaluateCircuitBreaker(
      [
        { type: 'LEG2_FLATTEN_DEX', edgeUsd: -0.04, timestamp: oldLossTs },
        { type: 'CROSS_VENUE_ARB', edgeUsd: -0.03, timestamp: oldLossTs },
      ],
      nowMs
    ).tripped,
    false
  );
  assert.equal(
    evaluateCircuitBreaker([{ type: 'CROSS_VENUE_ARB', edgeUsd: -0.40, timestamp: ts }], nowMs).reason,
    'max_single_trade_loss'
  );
  assert.equal(
    evaluateCircuitBreaker(
      [
        { type: 'CROSS_VENUE_ARB', edgeUsd: 0.02, timestamp: ts },
        { type: 'LEG2_FLATTEN_DEX', edgeUsd: -0.34, timestamp: ts },
        { type: 'CROSS_VENUE_ARB', edgeUsd: 0.02, timestamp: ts },
        { type: 'LEG2_FLATTEN_DEX', edgeUsd: -0.34, timestamp: ts },
        { type: 'CROSS_VENUE_ARB', edgeUsd: 0.02, timestamp: ts },
        { type: 'LEG2_FLATTEN_DEX', edgeUsd: -0.39, timestamp: ts },
      ],
      nowMs
    ).reason,
    'max_daily_loss'
  );

  // 4. Loopback server default, rate-aware preview budget, EIP-1559 priority tip, & SHA-256 binary pin in run-vm.sh
  assert.equal(CONFIG.bindHost, '127.0.0.1');
  assert.equal(CONFIG.priorityTipGwei, 20);
  assert.equal(PREVIEW_BUDGET.limit, 60);
  assert.equal(PREVIEW_BUDGET.reserveForChase, 10);
  const runVmSh = fs.readFileSync(path.join(repoRoot, 'run-vm.sh'), 'utf8');
  assert.equal(CONFIG.contracts.flashPools.USAT, '0x070D575a713EaF5025462D0865Fb0Dac4B14bC38');
  assert.equal(CONFIG.contracts.flashPools.CELO, '0x6cde5f5a192fBf3fD84df983aa6DC30dbd9f8Fac');
  assert.equal(CONFIG.contracts.flashPools.VGBP, '0x8C7545d227140fabB2709eA41E1A927F4e65b946');
  assert.equal(CONFIG.contracts.flashPools.WETH, '0xF55791AfBB35aD42984f18D6Fe3e1fF73D81900c');
  assert.equal(CONFIG.contracts.flashPools.COPM, '0x4495F525C4ECaCF9713a51eC3e8d1e81d7dFf870');
  assert.match(runVmSh, /EXPECTED_STITCH_SHA256="caa5f515672f0b06b48a584cb857862dbf3138e143757675fc097f81f486338d"/);
  assert.match(runVmSh, /ENABLE_USAT="\$\{ENABLE_USAT:-1\}"/);
  assert.match(runVmSh, /MIN_EDGE_USD="\$\{MIN_EDGE_USD:-0\.015\}"/);
  assert.match(runVmSh, /MIN_EDGE_BPS="\$\{MIN_EDGE_BPS:-0\.80\}"/);
  assert.match(runVmSh, /MIN_FLASH_EDGE_BPS="\$\{MIN_FLASH_EDGE_BPS:-0\.05\}"/);
  assert.match(runVmSh, /MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS="\$\{MIN_UNI_TO_TEXTILE_DEX_FIRST_BPS:-4\.5\}"/);
  assert.match(runVmSh, /MIN_UNI_TO_TEXTILE_DEX_FIRST_USD="\$\{MIN_UNI_TO_TEXTILE_DEX_FIRST_USD:-0\.08\}"/);
  assert.match(runVmSh, /MAX_FLASH_SLICE_USDT="\$\{MAX_FLASH_SLICE_USDT:-12000\}"/);
  assert.match(runVmSh, /MAX_USD_FLASH_SLICE_USDT="\$\{MAX_USD_FLASH_SLICE_USDT:-35000\}"/);
  assert.match(runVmSh, /PRIORITY_TIP_GWEI="\$\{PRIORITY_TIP_GWEI:-85\}"/);
  assert.match(runVmSh, /CHASE_INTERVAL_MS="\$\{CHASE_INTERVAL_MS:-650\}"/);
  assert.match(runVmSh, /SCAN_INTERVAL_MS="\$\{SCAN_INTERVAL_MS:-1050\}"/);
  assert.match(runVmSh, /skew-desk\.log.*-mmin -4/);
  assert.match(runVmSh, /skew-auto-watchdog/);
  assert.match(runVmSh, /sha256sum -c/);
});

test('30. Leg-2 RPC propagation retry recovers from 1-block insufficient_funds lag and writes exact flatten PnL to disk', async () => {
  const tmpLog = path.join(os.tmpdir(), `skew-trades.retry.${Date.now()}.jsonl`);
  const routerIface = new ethers.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  ]);
  const erc20Iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const mockProvider = {
    call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [10n ** 36n]),
  };
  const externalCalldata =
    '0x3f62192e' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000240' +
    '0000000000000000000000000000000000000000000000000000000000000200' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '000000000000000000000000a9aa0a64769cbed4d3b1ceb4df01cde915c235b3' +
    '00000000000000000000000025a5c1ae6a47e5c57941a69b54ce6fc52e7cab52';

  let quoteCalls = 0;
  let txCounter = 0;
  try {
    const exec = createExecutionManager({
      CONFIG: { ...CONFIG, tradesLogPath: tmpLog },
      STATE: { balances: { cngn: 7000 } },
      wallet: { address: CONFIG.agentWallet },
      provider: mockProvider,
      routerIface,
      erc20Iface,
      sendTagged: async () => ({ hash: `0x${String(++txCounter).padStart(64, 'a')}`, logs: [] }),
      bestUniQuote: async () => ({ amountOut: 330_718200n, fee: 100 }),
      textileRequestQuote: async () => {
        if (++quoteCalls === 1) return { error: 'insufficient_funds' }; // simulates 1-block RPC lag at t=0ms
        return {
          rfqId: 'rfq-1',
          claimToken: 'claim-1',
          quote: { buyAmount: '330820000' },
          transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
        };
      },
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({}),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers: (_r, tok, f) => {
        if (tok === CONFIG.tokens[0].address && f.toAddr) return 465_257_266600n;
        if (tok === CONFIG.contracts.usdt && f.fromAddr) return 330_720000n;
        if (tok === CONFIG.contracts.usdt && f.toAddr) return 330_820000n;
        return 0n;
      },
      getCachedOffChainFx: () => ({}),
      leg2RetryDelaysMs: [1, 1],
    });

    // Override allowance check cleanly via pre-warmed mock contract call
    const opp = {
      corridor: 'cNGN/USDT',
      symbol: 'cNGN',
      tokenAddress: CONFIG.tokens[0].address,
      decimals: 6,
      direction: 'uni->textile',
      sizeUsdt: 330.72,
      amountInRaw: '330720000',
      midTokenRaw: '465257266600',
      expectedOutUsdt: 330.82,
      uniFee: 100,
      edgeUsd: 0.10,
      edgeBps: 3.02,
      scannedAtMs: Date.now(),
    };
    const res = await exec.executeOpportunity(opp);
    assert.equal(res.type, 'CROSS_VENUE_ARB');
    assert.ok(res.edgeUsd >= 0.099);

    // Now simulate permanent Maker disappearance -> verify exact scratch PnL written to disk in trades.jsonl
    const execFlat = createExecutionManager({
      CONFIG: { ...CONFIG, tradesLogPath: tmpLog },
      STATE: { balances: { cngn: 7000 } },
      wallet: { address: CONFIG.agentWallet },
      provider: mockProvider,
      routerIface,
      erc20Iface,
      sendTagged: async () => ({ hash: '0x' + 'b'.repeat(64), logs: [] }),
      bestUniQuote: async () => ({ amountOut: 330_718200n, fee: 100 }),
      textileRequestQuote: async () => ({ error: 'no_makers_online' }),
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({}),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers: (_r, tok, f) => {
        if (tok === CONFIG.tokens[0].address && f.toAddr) return 465_257_266600n;
        if (tok === CONFIG.contracts.usdt && f.fromAddr) return 330_720000n;
        if (tok === CONFIG.contracts.usdt && f.toAddr) return 330_718200n;
        return 0n;
      },
      getCachedOffChainFx: () => ({}),
      leg2RetryDelaysMs: [1, 1],
    });
    const flatRes = await execFlat.executeOpportunity({ ...opp, scannedAtMs: Date.now() });
    assert.equal(flatRes.type, 'LEG2_FLATTEN_DEX');
    assert.equal(flatRes.edgeUsd, -0.0018);
    const lines = fs.readFileSync(tmpLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[1].type, 'LEG2_FLATTEN_DEX');
    assert.equal(lines[1].edgeUsd, -0.0018);
  } finally {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  }
});

test('31. Leg-2 Maker bait-and-slip shield rejects -14.51 bps quote, flattens on 1-bps DEX, quarantines corridor 30m, and auto-resumes positive 24h book after 60m', async () => {
  const tmpLog = path.join(os.tmpdir(), `skew-trades.bait.${Date.now()}.jsonl`);
  const routerIface = new ethers.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  ]);
  const erc20Iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const mockProvider = {
    call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [10n ** 36n]),
  };
  const externalCalldata =
    '0x3f62192e' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000240' +
    '0000000000000000000000000000000000000000000000000000000000000200' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '000000000000000000000000a9aa0a64769cbed4d3b1ceb4df01cde915c235b3' +
    '00000000000000000000000025a5c1ae6a47e5c57941a69b54ce6fc52e7cab52';

  let sentTxs = [];
  try {
    const warsToken = CONFIG.tokens.find((t) => t.symbol === 'wARS');
    const cngnToken = CONFIG.tokens.find((t) => t.symbol === 'cNGN');
    const exec = createExecutionManager({
      CONFIG: { ...CONFIG, tradesLogPath: tmpLog },
      STATE: { balances: { wars: 8338, cngn: 7048 } },
      wallet: { address: CONFIG.agentWallet },
      provider: mockProvider,
      routerIface,
      erc20Iface,
      sendTagged: async (tx) => {
        sentTxs.push(tx);
        return { hash: `0x${String(sentTxs.length).padStart(64, 'c')}`, logs: [] };
      },
      bestUniQuote: async (tokIn) => {
        if (tokIn === warsToken.address) return { amountOut: 333_633200n, fee: 100 }; // -2.0 bps ($333.6332) DEX exit
        return { amountOut: 330_820000n, fee: 100 };
      },
      textileRequestQuote: async (sellTok) => {
        if (sellTok === warsToken.address) {
          // Exact reproduction of 11:47Z wARS Maker bait-and-slip: $333.7000 -> $333.2158 (-14.51 bps = -$0.4842)
          return {
            rfqId: 'rfq-bait',
            claimToken: 'claim-bait',
            quote: { buyAmount: '333215800' },
            transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
          };
        }
        return {
          rfqId: 'rfq-cngn',
          claimToken: 'claim-cngn',
          quote: { buyAmount: '330850000' },
          transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
        };
      },
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({}),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers: (_r, tok, f) => {
        if (tok === warsToken.address && f.toAddr) return 556_635n * 10n ** 18n;
        if (tok === cngnToken.address && f.toAddr) return 465_000_000000n;
        if (tok === CONFIG.contracts.usdt && f.fromAddr) return sentTxs.length <= 2 ? 333_700000n : 330_720000n;
        if (tok === CONFIG.contracts.usdt && f.toAddr) return sentTxs.length <= 2 ? 333_633200n : 330_850000n;
        return 0n;
      },
      getCachedOffChainFx: () => ({}),
      leg2RetryDelaysMs: [1, 1],
    });

    const warsOpp = {
      corridor: 'wARS/USDT',
      symbol: 'wARS',
      tokenAddress: warsToken.address,
      decimals: 18,
      direction: 'uni->textile',
      sizeUsdt: 333.70,
      amountInRaw: '333700000',
      midTokenRaw: String(556_635n * 10n ** 18n),
      expectedOutUsdt: 333.79,
      uniFee: 100,
      edgeUsd: 0.09,
      edgeBps: 2.70,
      scannedAtMs: Date.now(),
    };

    // 1. Rejects -$0.4842 Reactor quote (never signs Reactor tx!) and flattens on 1-bps Uniswap pool for -$0.0668
    const res1 = await exec.executeOpportunity(warsOpp);
    assert.equal(res1.type, 'LEG2_FLATTEN_DEX');
    assert.equal(res1.edgeUsd, -0.0668);
    assert.equal(sentTxs.some((tx) => tx.to.toLowerCase() === CONFIG.contracts.reactor.toLowerCase()), false);

    // 2. Quarantines wARS/USDT cash-first uni->textile for 30 minutes (0 gas), while cNGN/USDT still executes normally
    const txCountBeforeRetry = sentTxs.length;
    const resBlocked = await exec.executeOpportunity({ ...warsOpp, scannedAtMs: Date.now() });
    assert.equal(resBlocked, null);
    assert.equal(sentTxs.length, txCountBeforeRetry);

    const cngnRes = await exec.executeOpportunity({
      corridor: 'cNGN/USDT',
      symbol: 'cNGN',
      tokenAddress: cngnToken.address,
      decimals: 6,
      direction: 'uni->textile',
      sizeUsdt: 330.72,
      amountInRaw: '330720000',
      midTokenRaw: '465000000000',
      expectedOutUsdt: 330.85,
      uniFee: 100,
      edgeUsd: 0.13,
      edgeBps: 3.93,
      scannedAtMs: Date.now(),
    });
    assert.equal(cngnRes.type, 'CROSS_VENUE_ARB');
    assert.ok(cngnRes.edgeUsd > 0.12);

    // 3. Circuit breaker: 60m cooldown when 24h net PnL > 0, permanent lock when 24h net PnL <= 0
    const nowMs = Date.now();
    const tenMinAgo = new Date(nowMs - 10 * 60_000).toISOString();
    const sixtyFiveMinAgo = new Date(nowMs - 65 * 60_000).toISOString();
    const earlierToday = new Date(nowMs - 4 * 3600_000).toISOString();

    assert.equal(
      evaluateCircuitBreaker(
        [
          { type: 'CROSS_VENUE_ARB', edgeUsd: -0.4842, timestamp: tenMinAgo },
          { type: 'CROSS_VENUE_ARB', edgeUsd: 3.95, timestamp: earlierToday },
        ],
        nowMs
      ).reason,
      'max_single_trade_loss'
    );
    assert.equal(
      evaluateCircuitBreaker(
        [
          { type: 'CROSS_VENUE_ARB', edgeUsd: -0.4842, timestamp: sixtyFiveMinAgo },
          { type: 'CROSS_VENUE_ARB', edgeUsd: 3.95, timestamp: earlierToday },
        ],
        nowMs
      ).tripped,
      false
    );
    assert.equal(
      evaluateCircuitBreaker(
        [{ type: 'CROSS_VENUE_ARB', edgeUsd: -0.4842, timestamp: sixtyFiveMinAgo }],
        nowMs
      ).reason,
      'max_single_trade_loss'
    );
  } finally {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  }
});

test('32. textile->uni Leg-2 >5bps DEX slip catches revert, flattens 100% in 1 swap with disk PnL, quarantines 5m, and scales live gas floor', async () => {
  const tmpLog = path.join(os.tmpdir(), `skew-trades.t2u.${Date.now()}.jsonl`);
  const routerIface = new ethers.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  ]);
  const erc20Iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const mockProvider = {
    call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [10n ** 36n]),
  };
  const externalCalldata =
    '0x3f62192e' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000240' +
    '0000000000000000000000000000000000000000000000000000000000000200' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '000000000000000000000000a9aa0a64769cbed4d3b1ceb4df01cde915c235b3' +
    '00000000000000000000000025a5c1ae6a47e5c57941a69b54ce6fc52e7cab52';

  // 1. Live gas cost scaling: offline = $0.003, 260 gwei = ~$0.0058, 1500 gwei = ~$0.0316 (blocks thin $0.02 gross edge)
  assert.equal(estimateLiveArbGasUsd(null), CONFIG.estimatedArbGasUsd);
  assert.ok(estimateLiveArbGasUsd(260_000_000_000n, 0.065) > 0.005);
  const highGas = estimateLiveArbGasUsd(1_500_000_000_000n, 0.065);
  assert.ok(highGas > 0.03);
  assert.equal(verifyFirmArbQuote({ inUsdt: 100, firmOutUsdt: 100.02, estimatedGasUsd: highGas }).ok, false);

  // 2. Exact reproduction of blk=83021268 orphaned textile->uni Leg 2:
  //    Pre-Leg-1 quote = $346.35 (+4.3 bps), then external bot moves pool -8 bps to $345.92 during Leg 1!
  //    First Router call (minOutUsdt = 99.95% of $346.35 = $346.1768) throws CALL_EXCEPTION -> caught & flattened 100% in 1 tx!
  let uniQuoteCalls = 0;
  let routerCalls = 0;
  const sentTxs = [];
  try {
    const cngnToken = CONFIG.tokens.find((t) => t.symbol === 'cNGN');
    const exec = createExecutionManager({
      CONFIG: { ...CONFIG, tradesLogPath: tmpLog },
      STATE: { balances: { cngn: 7200 } },
      wallet: { address: CONFIG.agentWallet },
      provider: mockProvider,
      routerIface,
      erc20Iface,
      sendTagged: async (tx) => {
        if (tx.to.toLowerCase() === CONFIG.contracts.uniSwapRouter02.toLowerCase()) {
          routerCalls += 1;
          if (routerCalls === 1) {
            throw new Error('execution reverted: Too little received');
          }
        }
        sentTxs.push(tx);
        return { hash: `0x${String(sentTxs.length).padStart(64, 'd')}`, logs: [] };
      },
      bestUniQuote: async () => {
        uniQuoteCalls += 1;
        // Call 1 (pre-Leg-1): $346.3500; Call 2 (post-slip flatten): $346.0200 (-5.2 bps vs $346.20 spent)
        return uniQuoteCalls === 1
          ? { amountOut: 346_350000n, fee: 100 }
          : { amountOut: 346_020000n, fee: 100 };
      },
      textileRequestQuote: async () => ({
        rfqId: 'rfq-t2u',
        claimToken: 'claim-t2u',
        quote: { buyAmount: '498029174058' },
        transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
      }),
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({}),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers: (_r, tok, f) => {
        if (tok === cngnToken.address && f.toAddr) return 498_029_174058n;
        if (tok === CONFIG.contracts.usdt && f.fromAddr) return 346_200000n; // includes 2-bps Textile fee ($346.1308 + $0.0692)
        if (tok === CONFIG.contracts.usdt && f.toAddr) return 346_020000n;
        return 0n;
      },
      getCachedOffChainFx: () => ({}),
    });

    const opp = {
      corridor: 'cNGN/USDT',
      symbol: 'cNGN',
      tokenAddress: cngnToken.address,
      decimals: 6,
      direction: 'textile->uni',
      sizeUsdt: 346.20,
      amountInRaw: '346200000',
      midTokenRaw: '498029174058',
      expectedOutUsdt: 346.35,
      uniFee: 100,
      edgeUsd: 0.15,
      edgeBps: 4.33,
      scannedAtMs: Date.now(),
    };

    const res = await exec.executeOpportunity(opp);
    assert.equal(res.type, 'LEG2_FLATTEN_DEX');
    assert.equal(res.edgeUsd, -0.18); // -$0.18 in 1 tx instead of -$1.11 across 3 slow $150 treasury unwinds!
    assert.equal(sentTxs.length, 2); // 1 Reactor Leg 1 + 1 single-tx 100% Uniswap flatten

    const logged = fs.readFileSync(tmpLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].type, 'LEG2_FLATTEN_DEX');
    assert.equal(logged[0].edgeUsd, -0.18);

    // Immediate retry within 5m cooldown is skipped with 0 gas
    const retryRes = await exec.executeOpportunity({ ...opp, scannedAtMs: Date.now() });
    assert.equal(retryRes, null);
    assert.equal(sentTxs.length, 2);
  } finally {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  }
});

test('33. SkewAtomicRouter rfq:aggregator Flash Mode executes $2,000 t2u & $1,500 u2t in 1 atomic tx, enforces firewall, and skips 0-loss reverts', async () => {
  const tmpLog = path.join(os.tmpdir(), `skew-trades.flash.${Date.now()}.jsonl`);
  const artifact = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'contracts', 'SkewAtomicRouter.artifact.json'), 'utf8')
  );
  const flashIface = new ethers.Interface(artifact.abi);
  assert.equal(flashIface.getFunction('executeFlashArb').selector, '0xbbccecf8');

  const simRouterAddr = '0x9905000000000000000000000000000000009905';
  const prevFlashAddr = CONFIG.flashRouterAddress;
  CONFIG.flashRouterAddress = simRouterAddr;

  const routerIface = new ethers.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  ]);
  const erc20Iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const externalCalldata =
    '0x3f62192e' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000240' +
    '0000000000000000000000000000000000000000000000000000000000000200' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '000000000000000000000000a9aa0a64769cbed4d3b1ceb4df01cde915c235b3' +
    '00000000000000000000000025a5c1ae6a47e5c57941a69b54ce6fc52e7cab52';

  try {
    // 1. Outbound firewall permits executeFlashArb on SkewAtomicRouter and blocks bogus selectors
    assert.equal(validateOutboundTx({ to: simRouterAddr, data: '0xbbccecf80000' }, CONFIG.agentWallet), true);
    assert.throws(
      () => validateOutboundTx({ to: simRouterAddr, data: '0xdeadbeef0000' }, CONFIG.agentWallet),
      /unauthorized SkewAtomicRouter selector/
    );

    // 2. Verify $2,000 textile->uni and $1,500 uni->textile single-tx atomic flash execution + 0-loss revert handling
    const cngnToken = CONFIG.tokens.find((t) => t.symbol === 'cNGN');
    const warsToken = CONFIG.tokens.find((t) => t.symbol === 'wARS');
    const requestedTakers = [];
    const sentTxs = [];
    let shouldRevertNext = false;

    const exec = createExecutionManager({
      CONFIG: {
        ...CONFIG,
        textileApiKey: 'tx_live_test_aggregator_key',
        flashRouterAddress: simRouterAddr,
        tradesLogPath: tmpLog,
      },
      STATE: { balances: { usdt: 384.52 } },
      wallet: { address: CONFIG.agentWallet },
      provider: {},
      routerIface,
      erc20Iface,
      sendTagged: async (tx, opts) => {
        validateOutboundTx(tx, CONFIG.agentWallet);
        assert.equal(opts?.priorityTip, true);
        if (shouldRevertNext) throw new Error('execution reverted: InsufficientProfit');
        sentTxs.push(tx);
        return { hash: `0x${String(sentTxs.length).padStart(64, 'f')}`, logs: [] };
      },
      bestUniQuote: async (tokIn) => {
        if (tokIn === cngnToken.address) return { amountOut: 2004_150000n, fee: 100 }; // +$4.15 on $2,000
        return { amountOut: 2_560_000n * 10n ** 18n, fee: 100 };
      },
      textileRequestQuote: async (sellTok, _buyTok, _amt, opts) => {
        requestedTakers.push(opts?.taker);
        if (sellTok === CONFIG.contracts.usdt) {
          return {
            rfqId: 'rfq-flash-t2u',
            claimToken: 'claim-1',
            quote: {
              takerPays: '2000000000',
              buyAmount: '2878000000000',
              spender: '0x7777777777777777777777777777777777777777', // Vault executor spender read dynamically!
            },
            transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
          };
        }
        return {
          rfqId: 'rfq-flash-u2t',
          claimToken: 'claim-2',
          quote: {
            takerPays: String(2_560_000n * 10n ** 18n),
            buyAmount: '1502850000', // +$2.85 on $1,500
            spender: CONFIG.contracts.reactor,
          },
          transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
        };
      },
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({}),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers: (_r, tok, f) => {
        if (tok === CONFIG.contracts.usdt && f.fromAddr === simRouterAddr && f.toAddr === CONFIG.agentWallet) {
          return sentTxs.length === 1 ? 4_150000n : 2_850000n;
        }
        return 0n;
      },
      getCachedOffChainFx: () => ({}),
    });

    const resT2U = await exec.executeOpportunity({
      corridor: 'cNGN/USDT',
      symbol: 'cNGN',
      tokenAddress: cngnToken.address,
      decimals: 6,
      direction: 'textile->uni',
      sizeUsdt: 2000,
      amountInRaw: '2000000000',
      midTokenRaw: '2878000000000',
      expectedOutUsdt: 2004.15,
      uniFee: 100,
      edgeUsd: 4.15,
      edgeBps: 20.75,
      scannedAtMs: Date.now(),
    });
    assert.equal(resT2U.direction, 'flash:textile->uni');
    assert.equal(resT2U.edgeUsd, 4.15);
    assert.equal(requestedTakers[0], simRouterAddr);
    assert.equal(sentTxs.length, 1);
    const [decoded1] = flashIface.decodeFunctionData('executeFlashArb', sentTxs[0].data);
    assert.equal(decoded1.isTextileToUni, true);
    assert.equal(decoded1.spender, '0x7777777777777777777777777777777777777777');

    const resU2T = await exec.executeOpportunity({
      corridor: 'wARS/USDT',
      symbol: 'wARS',
      tokenAddress: warsToken.address,
      decimals: 18,
      direction: 'uni->textile',
      sizeUsdt: 1500,
      amountInRaw: '1500000000',
      midTokenRaw: String(2_560_000n * 10n ** 18n),
      expectedOutUsdt: 1502.85,
      uniFee: 100,
      edgeUsd: 2.85,
      edgeBps: 19.0,
      scannedAtMs: Date.now(),
    });
    assert.equal(resU2T.direction, 'flash:uni->textile');
    assert.equal(resU2T.edgeUsd, 2.85);
    assert.equal(sentTxs.length, 2);

    // Lost race / InsufficientProfit pre-flight revert returns null cleanly with 0 txs sent and 0 loss
    shouldRevertNext = true;
    const skipped = await exec.executeOpportunity({
      corridor: 'cNGN/USDT',
      symbol: 'cNGN',
      tokenAddress: cngnToken.address,
      decimals: 6,
      direction: 'textile->uni',
      sizeUsdt: 2000,
      amountInRaw: '2000000000',
      midTokenRaw: '2878000000000',
      expectedOutUsdt: 2004.15,
      uniFee: 100,
      edgeUsd: 4.15,
      edgeBps: 20.75,
      scannedAtMs: Date.now(),
    });
    assert.equal(skipped, null);
    assert.equal(sentTxs.length, 2);
  } finally {
    CONFIG.flashRouterAddress = prevFlashAddr;
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  }
});

test('34. Aggregator /v2/rfq/levels piecewise Maker ladder isolates profitable mid-book & micro knots when $3,000 tier is underwater', async () => {
  // 1. Piecewise linear interpolation + unsorted/duplicate/bounds safety
  const sampleLevels = [
    { sellAmount: '1500000000', buyAmount: '2163000000000' }, // $1,500 -> 2,163,000 cNGN (1442.0/USDT)
    { sellAmount: '1000000', buyAmount: '1442000000' }, // $1 -> 1,442.0 cNGN
    { sellAmount: '1500000000', buyAmount: '2163000000000' }, // duplicate knot safety
    { sellAmount: '3000000000', buyAmount: '4314000000000' }, // $3,000 -> 4,314,000 cNGN (blended 1438.0/USDT)
  ];
  assert.equal(interpolateLadderBuyAmount(sampleLevels, 500_000n), 0n); // below min knot
  assert.equal(interpolateLadderBuyAmount(sampleLevels, 3_500_000000n), 0n); // above max knot
  assert.equal(interpolateLadderBuyAmount(sampleLevels, 1_500_000000n), 2_163_000_000000n); // exact knot
  // Midpoint $2,250 between $1,500 (2,163,000) and $3,000 (4,314,000) -> 3,238,500 cNGN
  assert.equal(interpolateLadderBuyAmount(sampleLevels, 2_250_000000n), 3_238_500_000000n);

  // 2. Flash-mode ladder scan finds +$2.08 at $1,500 Maker knot even though $3,000 blended tier is -$3.99 underwater
  const prevApiKey = CONFIG.textileApiKey;
  const prevFlashAddr = CONFIG.flashRouterAddress;
  CONFIG.textileApiKey = 'tx_live_test_ladder';
  CONFIG.flashRouterAddress = '0x6EA01bB2C883F2D7967da6bB85660B8AaA37f194';
  try {
    const cngnToken = CONFIG.tokens.find((t) => t.symbol === 'cNGN');
    const usdtLower = CONFIG.contracts.usdt.toLowerCase();
    const cngnLower = cngnToken.address.toLowerCase();

    // Uniswap V3 pool trades at 1440.5 cNGN/USDT (including 1 bps fee)
    const mockUniQuote = async (tokIn, _tokOut, amountIn) => {
      const inBig = BigInt(amountIn);
      if (tokIn.toLowerCase() === cngnLower) {
        return { amountOut: (inBig * 10000n) / 14405000n, fee: 100 };
      }
      return { amountOut: (inBig * 14405000n) / 10000n, fee: 100 };
    };

    const pairMap = new Map([
      [
        `${usdtLower}->${cngnLower}`,
        {
          sellToken: CONFIG.contracts.usdt,
          buyToken: cngnToken.address,
          minSellAmount: '1000000',
          maxSellAmount: '3050000000',
          levels: [
            { sellAmount: '1000000', buyAmount: '1442000000' },
            { sellAmount: '304000000', buyAmount: '438368000000' },
            { sellAmount: '1500000000', buyAmount: '2163000000000' }, // Maker A: 1442.0 cNGN/USDT (+10.4 bps vs Uni!)
            { sellAmount: '3050000000', buyAmount: '4385000000000' }, // Maker B drags $3,050 blended rate down to 1437.7 (-19.4 bps!)
          ],
        },
      ],
      [
        `${cngnLower}->${usdtLower}`,
        {
          sellToken: cngnToken.address,
          buyToken: CONFIG.contracts.usdt,
          minSellAmount: '1440000000',
          maxSellAmount: '4400000000000',
          levels: [
            { sellAmount: '1440000000', buyAmount: '1001200' },
            { sellAmount: '1755000000000', buyAmount: '1219800000' }, // $1,219.80 out for 1,755,000 cNGN (costs $1,218.33 on Uni -> +$1.47!)
            { sellAmount: '4400000000000', buyAmount: '3049000000' }, // $3,049 out for 4.4M cNGN (costs $3,054.50 on Uni -> -$5.50!)
          ],
        },
      ],
    ]);

    const rows = await scanTokenFromLadder(cngnToken, pairMap, 385, mockUniQuote);
    const t2u = rows.find((r) => r.direction === 'textile->uni');
    const u2t = rows.find((r) => r.direction === 'uni->textile');
    assert.ok(t2u && u2t);
    assert.equal(t2u.status, 'ACTIONABLE');
    assert.equal(t2u.sizeUsdt, 1500);
    assert.ok(t2u.edgeUsd > 1.5, `expected >$1.50 profit at $1,500 knot, got ${t2u.edgeUsd}`);
    assert.equal(u2t.status, 'ACTIONABLE');
    assert.ok(u2t.sizeUsdt >= 1200 && u2t.sizeUsdt <= 1250, `expected ~$1,219 knot, got ${u2t.sizeUsdt}`);
    assert.ok(u2t.edgeUsd > 1.4, `expected >$1.40 profit on uni->textile knot, got ${u2t.edgeUsd}`);

    // 3. Sub-$750 micro Maker knot ($122) is preserved even on a $3,050 deep ladder when larger knots are underwater
    const microMap = new Map([
      [
        `${usdtLower}->${cngnLower}`,
        {
          sellToken: CONFIG.contracts.usdt,
          buyToken: cngnToken.address,
          minSellAmount: '1000000',
          maxSellAmount: '3050000000',
          levels: [
            { sellAmount: '1000000', buyAmount: '1443000000' },
            { sellAmount: '122000000', buyAmount: '176046000000' }, // $122 at 1443.0 (+$0.21 profit!)
            { sellAmount: '609000000', buyAmount: '875742000000' }, // $609 blended 1438.0 (underwater)
            { sellAmount: '1826000000', buyAmount: '2625788000000' },
            { sellAmount: '3050000000', buyAmount: '4385900000000' },
          ],
        },
      ],
    ]);
    const microRows = await scanTokenFromLadder(cngnToken, microMap, 385, mockUniQuote);
    const microT2U = microRows.find((r) => r.direction === 'textile->uni');
    assert.equal(microT2U.status, 'ACTIONABLE');
    assert.equal(microT2U.sizeUsdt, 122);
    assert.ok(microT2U.edgeUsd > 0.2, `expected >$0.20 profit at $122 micro knot, got ${microT2U.edgeUsd}`);
  } finally {
    CONFIG.textileApiKey = prevApiKey;
    CONFIG.flashRouterAddress = prevFlashAddr;
  }
});

test('35. Profit-tiered priority gas & $35k USD / $12k FX flash caps capture $20k+ USAT whale waves', async () => {
  assert.equal(computeDynamicPriorityTipGwei(0.05, 85), 85);
  assert.equal(computeDynamicPriorityTipGwei(0.249, 85), 85);
  assert.equal(computeDynamicPriorityTipGwei(0.25, 85), 165);
  assert.equal(computeDynamicPriorityTipGwei(1.85, 85), 165);
  assert.equal(computeDynamicPriorityTipGwei(2.0, 85), 300);
  assert.equal(computeDynamicPriorityTipGwei(9.5, 85), 300);
  assert.equal(computeDynamicPriorityTipGwei(10.0, 85), 420);
  assert.equal(computeDynamicPriorityTipGwei(58.85, 85), 420);
  assert.equal(computeDynamicPriorityTipGwei(2.0, 350), 350);

  assert.equal(getMaxFlashSliceUsdt({ symbol: 'cNGN', fxCode: 'NGN' }), 12000);
  assert.equal(getMaxFlashSliceUsdt({ symbol: 'wARS', fxCode: 'ARS' }), 12000);
  assert.equal(getMaxFlashSliceUsdt({ symbol: 'CELO', fxCode: 'ASSET' }), 12000);
  assert.equal(getMaxFlashSliceUsdt({ symbol: 'USDC', fxCode: 'USD' }), 35000);
  assert.equal(getMaxFlashSliceUsdt({ symbol: 'USAT', fxCode: 'USD' }), 35000);

  // Verify $20,000 USAT/USDT whale knot (+$58.85) is evaluated and selected in one shot
  const prevKey = CONFIG.textileApiKey;
  const prevRouter = CONFIG.flashRouterAddress;
  CONFIG.textileApiKey = 'tx_live_test_usat_whale';
  CONFIG.flashRouterAddress = '0x6EA01bB2C883F2D7967da6bB85660B8AaA37f194';
  try {
    const usatToken = {
      symbol: 'USAT',
      address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771',
      decimals: 6,
      probeUsdt: 400,
      fxCode: 'USD',
    };
    const usdtLower = CONFIG.contracts.usdt.toLowerCase();
    const usatLower = usatToken.address.toLowerCase();
    const pairMap = new Map([
      [
        `${usatLower}->${usdtLower}`,
        {
          sellToken: usatToken.address,
          buyToken: CONFIG.contracts.usdt,
          minSellAmount: '1000000',
          maxSellAmount: '20408163265', // $20,408 depth -> 98% = $20,000
          levels: [
            { sellAmount: '1000000', buyAmount: '1003000' },
            { sellAmount: '5000000000', buyAmount: '5015000000' },
            { sellAmount: '20408163265', buyAmount: '20469387755' },
          ],
        },
      ],
    ]);
    const mockUni = async (_in, _out, amt) => ({ amountOut: (BigInt(amt) * 9999n) / 10000n, fee: 100 });
    const rows = await scanTokenFromLadder(usatToken, pairMap, 700, mockUni);
    const u2t = rows.find((r) => r.direction === 'uni->textile');
    assert.ok(u2t);
    assert.equal(u2t.status, 'ACTIONABLE');
    assert.ok(u2t.sizeUsdt >= 19900 && u2t.sizeUsdt <= 20100, `expected ~$20k USAT clip, got ${u2t.sizeUsdt}`);
    assert.ok(u2t.edgeUsd > 55, `expected >$55 profit on $20k USAT clip, got ${u2t.edgeUsd}`);
  } finally {
    CONFIG.textileApiKey = prevKey;
    CONFIG.flashRouterAddress = prevRouter;
  }
});

test('36. Adaptive partial-liquidity resize rescues partially drained flash quotes & enforces strict flashOnly wallet isolation', async () => {
  const tmpLog = path.join(os.tmpdir(), `skew-trades.partial.${Date.now()}.jsonl`);
  const simRouterAddr = '0x6EA01bB2C883F2D7967da6bB85660B8AaA37f194';
  const routerIface = new ethers.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  ]);
  const erc20Iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const externalCalldata =
    '0x3f62192e' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000240' +
    '0000000000000000000000001111111111111111111111111111111111111111'.repeat(16);

  // 1. Verify validateOutboundTx STILL blocks EOA approve() and SwapRouter02 sells on non-legacy extraFlashTokens (CELO, VGBP, COPM)
  for (const extraTok of CONFIG.extraFlashTokens) {
    assert.equal(extraTok.flashOnly, true);
    if (extraTok.symbol === 'WETH') continue; // WETH is in legacyUnwindTokens for startup dust settlement
    assert.throws(
      () =>
        validateOutboundTx(
          {
            to: extraTok.address,
            data: erc20Iface.encodeFunctionData('approve', [CONFIG.contracts.reactor, 1000n]),
          },
          CONFIG.agentWallet
        ),
      /TX_FIREWALL_BLOCKED/
    );
    assert.throws(
      () =>
        validateOutboundTx(
          {
            to: CONFIG.contracts.uniSwapRouter02,
            data: routerIface.encodeFunctionData('exactInputSingle', [
              {
                tokenIn: extraTok.address,
                tokenOut: CONFIG.contracts.usdt,
                fee: 100,
                recipient: CONFIG.agentWallet,
                amountIn: 1000n,
                amountOutMinimum: 1n,
                sqrtPriceLimitX96: 0n,
              },
            ]),
          },
          CONFIG.agentWallet
        ),
      /TX_FIREWALL_BLOCKED/
    );
  }

  // 2. Verify EOA fallback strictly skips flashOnly tokens (`return null`) if flash mode is disabled
  const eoaExec = createExecutionManager({
    CONFIG: { ...CONFIG, textileApiKey: '', flashRouterAddress: '', tradesLogPath: tmpLog },
    STATE: { balances: { usdt: 700 } },
    wallet: { address: CONFIG.agentWallet },
    provider: {},
    routerIface,
    erc20Iface,
    sendTagged: async () => {
      throw new Error('should not send EOA tx for flashOnly corridor');
    },
    bestUniQuote: async () => ({ amountOut: 0n, fee: 100 }),
    textileRequestQuote: async () => ({}),
    textileSubmitTx: async () => ({}),
    fetchJson: async () => ({}),
    isSelfMakerOrder,
    verifyFirmArbQuote,
    sumReceiptTokenTransfers: () => 0n,
    getCachedOffChainFx: () => ({}),
  });
  const celoExtra = CONFIG.extraFlashTokens.find((t) => t.symbol === 'CELO');
  const skippedEoa = await eoaExec.executeOpportunity({
    corridor: 'CELO/USDT',
    symbol: 'CELO',
    tokenAddress: celoExtra.address,
    decimals: 18,
    direction: 'textile->uni',
    sizeUsdt: 100,
    amountInRaw: '100000000',
    midTokenRaw: String(700n * 10n ** 18n),
    expectedOutUsdt: 100.5,
    uniFee: 100,
    edgeUsd: 0.5,
    edgeBps: 50,
    scannedAtMs: Date.now(),
  });
  assert.equal(skippedEoa, null);

  // 3. Verify Flash Mode rescues $20k quote when Maker only has $15k left (availableSellAmount -> 98% = $14,700) in same tick
  const prevFlashAddr = CONFIG.flashRouterAddress;
  CONFIG.flashRouterAddress = simRouterAddr;
  try {
    const quoteAmountsRequested = [];
    const flashExec = createExecutionManager({
      CONFIG: {
        ...CONFIG,
        textileApiKey: 'tx_live_partial_test',
        flashRouterAddress: simRouterAddr,
        tradesLogPath: tmpLog,
      },
      STATE: { balances: { usdt: 700 } },
      wallet: { address: CONFIG.agentWallet },
      provider: {},
      routerIface,
      erc20Iface,
      sendTagged: async (tx) => {
        validateOutboundTx(tx, CONFIG.agentWallet);
        return { hash: `0x${'a'.repeat(64)}`, logs: [] };
      },
      bestUniQuote: async (_tokIn, _tokOut, amt) => ({
        amountOut: (BigInt(amt) * 10025n) / 10000n, // +25 bps exit on CELO/USDT
        fee: 100,
      }),
      textileRequestQuote: async (_sellTok, _buyTok, amt) => {
        const sAmt = BigInt(amt);
        quoteAmountsRequested.push(sAmt);
        if (sAmt > 15_000_000000n) {
          const e = new Error('Textile /v2/rfq/request 422: insufficient maker liquidity');
          e.availableSellAmount = '15000000000';
          throw e;
        }
        return {
          rfqId: 'rfq-celo-resized',
          claimToken: 'claim-celo',
          quote: {
            takerPays: sAmt.toString(),
            buyAmount: sAmt.toString(),
            spender: CONFIG.contracts.reactor,
          },
          transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
        };
      },
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({}),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers: (_r, tok, f) => {
        if (tok === CONFIG.contracts.usdt && f.fromAddr === simRouterAddr && f.toAddr === CONFIG.agentWallet) {
          return 36_750000n; // +$36.75 realized USDT swept!
        }
        return 0n;
      },
      getCachedOffChainFx: () => ({}),
    });

    const won = await flashExec.executeOpportunity({
      corridor: 'CELO/USDT',
      symbol: 'CELO',
      tokenAddress: celoExtra.address,
      decimals: 18,
      direction: 'textile->uni',
      sizeUsdt: 20000,
      amountInRaw: '20000000000',
      midTokenRaw: '20000000000',
      expectedOutUsdt: 20050,
      uniFee: 100,
      edgeUsd: 50,
      edgeBps: 25,
      scannedAtMs: Date.now(),
    });
    assert.ok(won);
    assert.equal(won.direction, 'flash:textile->uni');
    assert.equal(won.edgeUsd, 36.75);
    assert.deepEqual(quoteAmountsRequested, [20_000_000000n, 14_700_000000n]);
  } finally {
    CONFIG.flashRouterAddress = prevFlashAddr;
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  }
});

test('37. Double-audit upgrades: concave midpoint + micro-tail ladder retention, sub-bps ($25k @ 0.40bps = +$1.00) flash gate, and USDC 8bps lean floor', async () => {
  // 1. Verify buildLadderCandidates preserves $40/$200/$500 micro-anchors AND inserts concave midpoints even when maxRaw = $35,000
  const knotRaws = [1, 684, 1711, 3421, 6843, 17106, 34211].map((u) => BigInt(u) * 1_000000n);
  const gridRaws = [35000, 30000, 25000, 20000, 15000, 10000, 7000, 5000, 3500, 2500, 1500, 1000, 500, 200, 40].map(
    (u) => BigInt(u) * 1_000000n
  );
  const cands = buildLadderCandidates(knotRaws, gridRaws, 15_000000n, 35000_000000n);
  const candUsds = cands.map((x) => Number(x) / 1e6);
  assert.ok(cands.length <= 24, `expected <=24 candidates, got ${cands.length}`);
  assert.ok(candUsds.includes(40), `expected $40 micro-anchor preserved at $35k cap, got ${candUsds.join(',')}`);
  assert.ok(candUsds.includes(200), `expected $200 micro-anchor preserved at $35k cap, got ${candUsds.join(',')}`);
  // Midpoint between $6,843 and $17,106 is ~$11,974.50
  assert.ok(
    candUsds.some((u) => u > 11500 && u < 12500),
    `expected concave midpoint between $6.8k and $17.1k, got ${candUsds.join(',')}`
  );

  // 2. Verify $25,000 USAT/USDT institutional peg arb at +0.40 bps (+$1.00 pure risk-free USDT) is ACTIONABLE & passes Flash firm check
  const prevKey = CONFIG.textileApiKey;
  const prevRouter = CONFIG.flashRouterAddress;
  const tmpLog = path.join(os.tmpdir(), `skew-trades.subbps.${Date.now()}.jsonl`);
  const tmpPolicy = path.join(os.tmpdir(), `skew-policy.usdcfloor.${Date.now()}.json`);
  const tmpRuntimeToml = path.join(os.tmpdir(), `stitch.runtime.usdcfloor.${Date.now()}.toml`);
  CONFIG.textileApiKey = 'tx_live_subbps_test';
  CONFIG.flashRouterAddress = '0x6EA01bB2C883F2D7967da6bB85660B8AaA37f194';
  try {
    const usatToken = {
      symbol: 'USAT',
      address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771',
      decimals: 6,
      probeUsdt: 400,
      fxCode: 'USD',
    };
    const pairMap = new Map([
      [
        `${CONFIG.contracts.usdt.toLowerCase()}->${usatToken.address.toLowerCase()}`,
        {
          sellToken: CONFIG.contracts.usdt,
          buyToken: usatToken.address,
          minSellAmount: '1000000',
          maxSellAmount: '25600000000',
          levels: [
            { sellAmount: '1000000', buyAmount: '1000140' },
            { sellAmount: '25000000000', buyAmount: '25003501000' }, // +1.4 bps Maker buy -> +0.40 bps (+$1.00) net of 1-bps pool!
            { sellAmount: '25600000000', buyAmount: '25603584000' },
          ],
        },
      ],
    ]);
    const mockUni = async (_in, _out, amt) => ({ amountOut: (BigInt(amt) * 9999n) / 10000n, fee: 100 });
    const rows = await scanTokenFromLadder(usatToken, pairMap, 700, mockUni);
    const t2u = rows.find((r) => r.direction === 'textile->uni');
    assert.ok(t2u);
    assert.equal(t2u.status, 'ACTIONABLE');
    assert.ok(t2u.edgeBps < 0.45 && t2u.edgeBps > 0.35, `expected ~0.40 bps, got ${t2u.edgeBps}`);
    assert.ok(t2u.edgeUsd >= 0.98, `expected >=+$0.98 pure USDT profit, got ${t2u.edgeUsd}`);

    // Verify fast fresh-scan skip avoids redundant bestUniQuote call & executes +$1.00 flash sweep cleanly
    let extraUniCalls = 0;
    const externalCalldata =
      '0x3f62192e' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '0000000000000000000000000000000000000000000000000000000000000240' +
      '0000000000000000000000001111111111111111111111111111111111111111'.repeat(16);
    const exec = createExecutionManager({
      CONFIG: { ...CONFIG, tradesLogPath: tmpLog },
      STATE: { balances: { usdt: 700 } },
      wallet: { address: CONFIG.agentWallet },
      provider: {},
      routerIface: new ethers.Interface([
        'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
      ]),
      erc20Iface: new ethers.Interface(['function approve(address,uint256) returns (bool)']),
      sendTagged: async (tx) => {
        validateOutboundTx(tx, CONFIG.agentWallet);
        return { hash: `0x${'b'.repeat(64)}`, logs: [] };
      },
      bestUniQuote: async () => {
        extraUniCalls++;
        return { amountOut: 0n, fee: 100 };
      },
      textileRequestQuote: async (_s, _b, amt) => ({
        rfqId: 'rfq-usat-25k',
        claimToken: 'claim-usat',
        quote: {
          takerPays: amt.toString(),
          buyAmount: t2u.midTokenRaw,
          spender: CONFIG.contracts.reactor,
        },
        transactions: { swap: { to: CONFIG.contracts.reactor, data: externalCalldata } },
      }),
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({}),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers: (_r, tok, f) =>
        tok === CONFIG.contracts.usdt && f.fromAddr === CONFIG.flashRouterAddress ? 1_000000n : 0n,
      getCachedOffChainFx: () => ({}),
    });
    const swept = await exec.executeOpportunity(t2u);
    assert.ok(swept);
    assert.equal(extraUniCalls, 0, 'fresh scan within 3% buyAmount should skip redundant bestUniQuote RTT');
    assert.equal(swept.edgeUsd, 1.0);

    // 3. Verify USDC/USDT passive Maker lean_floor_bps is raised to 8.0 in both skew-policy.json and stitch.runtime.toml
    const skewMetrics = computeSkewAndQuotes({ usdtUsd: 701, cngnBalance: 7264, textileMid: 0.000723, uniMid: 0.000725 });
    const risk = computeRiskOfficerDecisions({
      usdt: 701,
      cngn: 7264,
      wars: 8806,
      wbrl: 30,
      usdc: 6.5,
      uniCngnMid: 0.000725,
      uniWarsMid: 0.000568,
      skewMetrics,
    });
    syncStitchRuntimePolicy(risk, tmpPolicy);
    syncStitchRuntimeConfig(risk, path.join(repoRoot, 'stitch.toml'), tmpRuntimeToml);
    const policyJson = JSON.parse(fs.readFileSync(tmpPolicy, 'utf8'));
    const usdcAddr = CONFIG.tokens.find((t) => t.symbol === 'USDC').address;
    assert.equal(policyJson.corridors[usdcAddr].lean_floor_bps, 8.0);
    assert.equal(policyJson.corridors[CONFIG.tokens[0].address].lean_floor_bps, 1.0);
    const runtimeToml = fs.readFileSync(tmpRuntimeToml, 'utf8');
    const usdcSection = runtimeToml.split('[[pools]]').find((b) => b.includes('"usdc-usdt-celo"'));
    assert.match(usdcSection, /lean_floor_bps\s*=\s*8\.0/);
  } finally {
    CONFIG.textileApiKey = prevKey;
    CONFIG.flashRouterAddress = prevRouter;
    for (const p of [tmpLog, tmpPolicy, tmpRuntimeToml]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
});

test('38. Dashboard redacts proprietary PnL & RoC on public view while streaming live gas, wins & volume', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('CHECKPOINT_GAS_BURNED_CELO = 371.9328'));
  assert.ok(html.includes('FLASH_ROUTER = \'0x6EA01bB2C883F2D7967da6bB85660B8AaA37f194\''));
  assert.ok(html.includes('<span id="flash24hPnlVal">—</span>'));
  assert.ok(html.includes('<span id="pnlValue">—</span>'));
  assert.ok(html.includes('id="rocBadge">— RoC</span>'));
  assert.ok(html.includes('id="bestSweepVal">—</span>'));
  assert.ok(html.includes('syncLiveChainLogs'));
  assert.ok(html.includes('gasBurnedBadge'));
  assert.ok(!html.includes('CHECKPOINT_WITHDRAWN_USDT'), 'Cold-wallet withdrawal history must not appear in public HTML source');
  assert.ok(!html.includes('0xbb6C727e'), 'Cold wallet address must not appear in public HTML source');
  assert.ok(!html.includes('Banked Profits (Withdrawn)'));
  assert.ok(!html.includes('Hot Working Float'));
  assert.ok(!html.includes('Total Value (Banked + Hot)'));
  assert.ok(!html.includes('Router Sweeps (All-Time)'));
  assert.ok(!html.includes('Total Value (incl. Gas)'));
});

test('39. Full-universe CHASE preempts $0.28 CELO crumb with +$14.36 wARS whale & fetchTextileLadder overflows cleanly without touching 14-credit /request reserve', async () => {
  const prevKey = CONFIG.textileApiKey;
  const prevRouter = CONFIG.flashRouterAddress;
  const savedLad = { ...LADDER_BUDGET };
  const savedPrev = { ...PREVIEW_BUDGET };
  CONFIG.textileApiKey = 'tx_live_chase_universe_key';
  CONFIG.flashRouterAddress = '0x6EA01bB2C883F2D7967da6bB85660B8AaA37f194';

  try {
    // 1. Multi-corridor chase scan ranks $5,000 wARS (+$14.36) #1 ahead of $200 CELO (+$0.28) #2
    const warsTok = CONFIG.tokens.find((t) => t.symbol === 'wARS');
    const celoTok = CONFIG.extraFlashTokens.find((t) => t.symbol === 'CELO');
    const usdtAddr = CONFIG.contracts.usdt;
    const ladderPairs = [
      {
        sellToken: usdtAddr,
        buyToken: celoTok.address,
        minSellAmount: '1000000',
        maxSellAmount: '205000000',
        levels: [
          { sellAmount: '1000000', buyAmount: '18000000000000000000' },
          { sellAmount: '200000000', buyAmount: '3605040000000000000000' }, // $200 -> +$0.28 on Uni
          { sellAmount: '205000000', buyAmount: '3680000000000000000000' },
        ],
      },
      {
        sellToken: usdtAddr,
        buyToken: warsTok.address,
        minSellAmount: '1000000',
        maxSellAmount: '5100000000',
        levels: [
          { sellAmount: '1000000', buyAmount: '1735000000000000000000' },
          { sellAmount: '5000000000', buyAmount: '8699930000000000000000000' }, // $5,000 -> +$14.36 on Uni!
          { sellAmount: '5100000000', buyAmount: '8840000000000000000000000' },
        ],
      },
    ];
    const mockUni = async (tokIn, _tokOut, amtRaw) => {
      const a = BigInt(amtRaw);
      if (tokIn.toLowerCase() === celoTok.address.toLowerCase()) {
        // 18 CELO = $1.00 USDT
        return { amountOut: a / 18_000_000_000_000n, fee: 100 };
      }
      if (tokIn.toLowerCase() === warsTok.address.toLowerCase()) {
        // 1735 wARS = $1.00 USDT -> 8,699,930 wARS = $5,014.368 USDT (+$14.368!)
        return { amountOut: a / 1_735_000_000_000_000n, fee: 100 };
      }
      return { amountOut: 100_000000n, fee: 100 };
    };

    const universeRes = await scanUniverseFromLadder([celoTok, warsTok], ladderPairs, 125, mockUni);
    const allChaseRows = universeRes.flatMap((u) => u.rows);
    const cands = selectChaseCandidates(allChaseRows, CONFIG.minEdgeUsd, CONFIG.minFlashEdgeBps);
    assert.equal(cands.length, 2);
    assert.equal(cands[0].symbol, 'wARS', 'wARS $14.36 whale must preempt CELO $0.28 crumb during CHASE');
    assert.ok(cands[0].edgeUsd > 14.0, `expected >$14 wARS profit, got ${cands[0].edgeUsd}`);
    assert.equal(cands[1].symbol, 'CELO', 'CELO $0.28 remains #2 fallback if #1 quote skips on 0-gas pre-flight');
    assert.ok(cands[1].edgeUsd > 0.25 && cands[1].edgeUsd < 0.35);

    // 2. fetchTextileLadder overflows cleanly on public 429 to Bearer key, and stops when Partner Key hits 14-credit reserve
    LADDER_BUDGET.remaining = 20;
    LADDER_BUDGET.resetAtMs = Date.now() + 30_000;
    PREVIEW_BUDGET.remaining = 45;
    PREVIEW_BUDGET.resetAtMs = Date.now() + 30_000;

    const seenAuthHeaders = [];
    const mockFetch429ThenOk = async (_url, opts) => {
      const auth = opts?.headers?.authorization || '';
      seenAuthHeaders.push(auth);
      if (!auth) {
        return {
          status: 429,
          ok: false,
          headers: new Map([['x-ratelimit-limit', '60'], ['x-ratelimit-remaining', '0'], ['x-ratelimit-reset', '25']]),
          json: async () => ({}),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: new Map([['x-ratelimit-limit', '60'], ['x-ratelimit-remaining', '44'], ['x-ratelimit-reset', '25']]),
        json: async () => ({ data: { asOf: '2026-11-24T20:30:00Z', pairs: ladderPairs } }),
      };
    };
    const recovered = await fetchTextileLadder(mockFetch429ThenOk);
    assert.equal(recovered?.pairs?.length, 2);
    assert.deepEqual(seenAuthHeaders, ['', 'Bearer tx_live_chase_universe_key']);
    assert.equal(PREVIEW_BUDGET.remaining, 44);

    // When both public (0) and Partner Key (<=14 reserve) are at floor, never spend the 14-credit /request reserve!
    LADDER_BUDGET.remaining = 0;
    LADDER_BUDGET.resetAtMs = Date.now() + 20_000;
    PREVIEW_BUDGET.remaining = 14;
    PREVIEW_BUDGET.resetAtMs = Date.now() + 20_000;
    let calledReserve = false;
    const blockedRes = await fetchTextileLadder(async () => {
      calledReserve = true;
      throw new Error('must not touch 14-credit firm-quote reserve');
    });
    assert.equal(calledReserve, false);
    assert.equal(blockedRes, null);
  } finally {
    CONFIG.textileApiKey = prevKey;
    CONFIG.flashRouterAddress = prevRouter;
    Object.assign(LADDER_BUDGET, savedLad);
    Object.assign(PREVIEW_BUDGET, savedPrev);
  }
});

test('40. Cron watchdog hardening: run-vm.sh persists .env.runtime when GEMINI_API_KEY is empty & loadOnChainHistory bounds trades.jsonl to <=300', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');

  // 1. Validate run-vm.sh bash syntax & verify .env.runtime creation when GEMINI_API_KEY="" under set -euo pipefail
  execFileSync('bash', ['-n', path.join(repoRoot, 'run-vm.sh')]);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skew-vm-test-'));
  const bigTradesPath = path.join(tmpDir, 'trades.jsonl');
  try {
    // Extract lines 18-62 of run-vm.sh (env load + .env.runtime persistence) and run in bare env without GEMINI_API_KEY
    const vmScript = fs.readFileSync(path.join(repoRoot, 'run-vm.sh'), 'utf8');
    assert.ok(vmScript.includes('skew-desk-supervisor'), 'run-vm.sh must wrap skew-desk in 2s auto-respawn supervisor loop');
    assert.ok(vmScript.includes('skew-stitch-supervisor'), 'run-vm.sh must wrap skew-stitch in 2s auto-respawn supervisor loop');
    const deskSrc = fs.readFileSync(path.join(repoRoot, 'skew-desk.mjs'), 'utf8');
    assert.ok(
      deskSrc.includes('for (let chaseIdx = 1; chaseIdx <= CONFIG.maxChaseIterations; chaseIdx++) {\n                lastScanDoneMs = Date.now();'),
      'CHASE loop must refresh lastScanDoneMs heartbeat on every iteration so 8-win streaks never trigger 90s watchdog'
    );
    const envBlock = vmScript.split('# 2. Ensure Node.js')[0];
    fs.writeFileSync(path.join(tmpDir, '.env'), 'STITCH_PRIVATE_KEY=""\nTEXTILE_API_KEY=""\n', 'utf8');
    execFileSync('bash', ['-c', envBlock], {
      cwd: tmpDir,
      env: {
        PATH: process.env.PATH,
        STITCH_PRIVATE_KEY: '0x' + '11'.repeat(32),
        TEXTILE_API_KEY: 'tx_live_cron_persist_test',
      },
    });
    assert.ok(fs.existsSync(path.join(tmpDir, '.env.runtime')), '.env.runtime must be written even when GEMINI_API_KEY is empty');
    // Second run simulating bare cron (zero caller env vars, empty .env present): .env.runtime must win!
    const cronOut = execFileSync('bash', ['-c', envBlock + '\nprintf "%s|%s" "$STITCH_PRIVATE_KEY" "$TEXTILE_API_KEY"'], {
      cwd: tmpDir,
      env: { PATH: process.env.PATH },
    }).toString();
    assert.ok(cronOut.endsWith(`${'0x' + '11'.repeat(32)}|tx_live_cron_persist_test`), `bare cron must recover keys from .env.runtime, got: ${cronOut}`);

    // 2. Verify loadOnChainHistory tails 1,200-line trades.jsonl cleanly and bounds STATE.arbExecutions to <=300
    const lines = [];
    for (let i = 1; i <= 1200; i++) {
      lines.push(JSON.stringify({ timestamp: new Date().toISOString(), type: 'CROSS_VENUE_ARB', seq: i, edgeUsd: 0.25 }));
    }
    fs.writeFileSync(bigTradesPath, lines.join('\n') + '\n', 'utf8');
    const state = { arbExecutions: [], markoutRecords: [], quantBySymbol: {}, textileMids: {} };
    const exec = createExecutionManager({
      CONFIG: { ...CONFIG, tradesLogPath: bigTradesPath, markoutsLogPath: path.join(tmpDir, 'm.jsonl') },
      STATE: state,
      wallet: null,
      provider: {},
      routerIface: new ethers.Interface(['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)']),
      erc20Iface: new ethers.Interface(['function approve(address,uint256) returns (bool)']),
      sendTagged: async () => ({}),
      bestUniQuote: async () => ({ amountOut: 0n, fee: 100 }),
      textileRequestQuote: async () => ({}),
      textileSubmitTx: async () => ({}),
      fetchJson: async () => ({ items: [] }),
      isSelfMakerOrder,
      verifyFirmArbQuote,
      sumReceiptTokenTransfers,
      getCachedOffChainFx: () => ({}),
    });
    await exec.loadOnChainHistory();
    assert.equal(state.arbExecutions.length, 300);
    assert.equal(state.arbExecutions[0].seq, 1200, 'newest trade must be at index 0');
    assert.equal(state.arbExecutions[299].seq, 901, 'oldest retained trade must be seq 901');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
