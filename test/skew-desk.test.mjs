import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG,
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
} from '../skew-desk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

test('1. Celo Mainnet (42220) configuration & ERC-8004 Agent #9905 identity', () => {
  assert.equal(CONFIG.chainId, 42220);
  assert.equal(CONFIG.agentId, 9905);
  assert.equal(CONFIG.agentWallet, '0xe5036100B4A32B83D5E1997d403Ce64A4C7f7324');
  assert.equal(CONFIG.contracts.erc8004Registry, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
  assert.equal(CONFIG.contracts.reactor, '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3');
  assert.equal(CONFIG.contracts.permit2, '0x000000000022D473030F116dDEE9F6B43aC78BA3');
  assert.deepEqual(
    CONFIG.tokens.map((t) => t.symbol),
    ['cNGN', 'wARS', 'wBRL', 'USDC']
  );
  assert.deepEqual(
    CONFIG.tokens.map((t) => t.decimals),
    [6, 18, 18, 6]
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

test('8. Anti-self-trade calldata filter detects our own Maker address in LimitOrderReactor orders', () => {
  const reactorWord = '000000000000000000000000' + CONFIG.contracts.reactor.slice(2).toLowerCase();
  const ourMakerWord = '000000000000000000000000' + CONFIG.agentWallet.slice(2).toLowerCase();
  const externalMakerWord = '00000000000000000000000025a5c1ae0000000000000000000000000000ab52';

  const selfCalldata = '0x3f62192e' + reactorWord + ourMakerWord;
  const externalCalldata = '0x3f62192e' + reactorWord + externalMakerWord;

  assert.equal(isSelfMakerOrder(selfCalldata), true);
  assert.equal(isSelfMakerOrder(externalCalldata), false);
});

test('9. Multi-slice trade sizing computes 100%, 50%, 25% of liquid USDT budget and enforces cap', () => {
  const slices = computeSliceSizesUsdt(140.0, 150.0);
  assert.deepEqual(slices, [126, 63, 31.5, 25]);

  const capped = computeSliceSizesUsdt(200.0, 150.0);
  assert.equal(capped[0], 150);
  assert.equal(capped[1], 75);
  assert.equal(capped[2], 37.5);
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
  for (const tok of CONFIG.tokens) {
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
    '#81,871,867',
    '2,675',
    '6,860',
    '134',
    '5,208.24',
    '1,286',
    '125,409.10',
    '136,490.63',
    '272,981.26',
    '700.0x',
    '195.00',
    '258.38',
    '252.53',
    '63.38',
    '32.50%',
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
