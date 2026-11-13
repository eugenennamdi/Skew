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
  verifyFirmArbQuote,
  sumReceiptTokenTransfers,
  renderDashboardHtml,
  runDryRunVerification,
  validatePrivateKey,
  validateOutboundTx,
  evaluateCircuitBreaker,
} from '../skew-desk.mjs';
import {
  verifyCommittedOnChainLedger,
  evaluateMakerFillVsFixedBaseline,
} from '../scripts/verify-onchain-pnl.mjs';

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

  // 4. Loopback server default, rate-aware preview budget, & SHA-256 binary pin in run-vm.sh
  assert.equal(CONFIG.bindHost, '127.0.0.1');
  assert.equal(PREVIEW_BUDGET.limit, 60);
  assert.equal(PREVIEW_BUDGET.reserveForChase, 10);
  const runVmSh = fs.readFileSync(path.join(repoRoot, 'run-vm.sh'), 'utf8');
  assert.match(runVmSh, /EXPECTED_STITCH_SHA256="caa5f515672f0b06b48a584cb857862dbf3138e143757675fc097f81f486338d"/);
  assert.match(runVmSh, /SCAN_INTERVAL_MS="\$\{SCAN_INTERVAL_MS:-6000\}"/);
  assert.match(runVmSh, /sha256sum -c/);
});
