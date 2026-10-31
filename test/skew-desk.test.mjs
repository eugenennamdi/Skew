import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG,
  MAX_UNI_QUOTE_GAS,
  OFFCHAIN_FX_DEFAULTS,
  appendErc8021Suffix,
  computeSkewAndQuotes,
  computeSliceSizesUsdt,
  computeRiskOfficerDecisions,
  isSelfMakerOrder,
  isValidUniQuoteGas,
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

test('15. Dashboard HTML & documentation include MiniPay detection, CIP-64 feeCurrency, Strategy, and Evidence', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('ERC-8004'));
  assert.ok(html.includes('isMiniPay'));
  assert.ok(html.includes('FEE_CURRENCY_USDT'));
  assert.ok(fs.existsSync(path.join(repoRoot, 'docs', 'STRATEGY.md')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'reports', 'EVIDENCE.md')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(repoRoot, '.env.example')));
});

test('16. Cross-document snapshot metrics and LaTeX formulas are 100% consistent across README, EVIDENCE, and STRATEGY', () => {
  const docsToCheck = ['README.md', 'reports/EVIDENCE.md', 'docs/STRATEGY.md'];
  const snapshotMetrics = [
    '#81,484,785',
    '1,466',
    '3,714',
    '41',
    '2,111.50',
    '690',
    '45,096.26',
    '49,604.23',
    '99,208.47',
    '254.4x',
    '195.00',
    '231.71',
    '227.86',
    '36.71',
    '18.83%',
    '3.85',
  ];
  for (const relPath of docsToCheck) {
    const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    assert.ok(!content.includes('\\;'), `${relPath} must not contain broken LaTeX \\; spacing escapes`);
    for (const metric of snapshotMetrics) {
      assert.ok(content.includes(metric), `${relPath} must include synchronized snapshot metric ${metric}`);
    }
  }
});
