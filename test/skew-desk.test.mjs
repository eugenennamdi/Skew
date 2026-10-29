import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG,
  MAX_UNI_QUOTE_GAS,
  appendErc8021Suffix,
  computeSkewAndQuotes,
  computeRiskOfficerDecisions,
  isSelfMakerOrder,
  isValidUniQuoteGas,
  renderDashboardHtml,
  runDryRunVerification,
} from '../skew-desk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Celo Mainnet (42220) configuration & ERC-8004 Agent #9905 identity', () => {
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
});

test('ERC-8021 attribution suffix appends exact 35-byte tag idempotently', () => {
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

test('Avellaneda-Stoikov inventory skew & Dual-Oracle Comparison Shield', () => {
  // Case 1: Balanced inventory (50% USDT / 50% cNGN) -> skew = 0
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

  // Case 2: Dual-Oracle Shield when Uniswap v3 trades richer than Textile oracle
  const shielded = computeSkewAndQuotes({
    usdtUsd: 150,
    cngnBalance: 25000,
    textileMid: 0.00072295, // 1383.22 cNGN/USDT
    uniMid: 0.00072538,     // 1378.59 cNGN/USDT (cNGN is more expensive on DEX)
  });
  assert.equal(shielded.effectiveSellMid, 0.00072538);
  assert.equal(shielded.effectiveBuyMid, 0.00072295);
  assert.ok(shielded.replenishEdgeBps > 30, 'Shielded ask must lock in positive DEX replenishment edge');

  // Case 3: Extreme USDT skew (cNGN depleted < $1) -> halts SELL side while keeping BUY side active
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

test('MAX_TICK gas-griefing filter rejects 17.04M gas wBRL/USDT pool and accepts healthy pools', () => {
  assert.equal(MAX_UNI_QUOTE_GAS, 800000n);
  assert.equal(isValidUniQuoteGas(53890000000000000000n, 145000n), true);
  assert.equal(isValidUniQuoteGas(53890000000000000000n, 800000n), true);
  assert.equal(isValidUniQuoteGas(53890000000000000000n, 17039337n), false);
  assert.equal(isValidUniQuoteGas(0n, 120000n), false);
});

test('Anti-self-trade calldata filter detects our own Maker address in LimitOrderReactor orders', () => {
  const reactorWord = '000000000000000000000000' + CONFIG.contracts.reactor.slice(2).toLowerCase();
  const ourMakerWord = '000000000000000000000000' + CONFIG.agentWallet.slice(2).toLowerCase();
  const externalMakerWord = '00000000000000000000000025a5c1ae0000000000000000000000000000ab52';

  const selfCalldata = '0x3f62192e' + reactorWord + ourMakerWord;
  const externalCalldata = '0x3f62192e' + reactorWord + externalMakerWord;

  assert.equal(isSelfMakerOrder(selfCalldata), true);
  assert.equal(isSelfMakerOrder(externalCalldata), false);
});

test('Autonomous Risk Officer & dry-run sandbox verification', () => {
  const dry = runDryRunVerification();
  assert.equal(dry.check, 'PASS');
  assert.equal(dry.chainId, 42220);
  assert.equal(dry.agentId, 9905);
  assert.equal(dry.erc8021SuffixBytes, 35);

  const skewMetrics = computeSkewAndQuotes({
    usdtUsd: 97.6,
    cngnBalance: 25020,
    textileMid: 0.00072295,
    uniMid: 0.00072538,
  });
  const risk = computeRiskOfficerDecisions({
    usdt: 97.6,
    cngn: 25020,
    wars: 22191,
    wbrl: 390.6,
    usdc: 15.0,
    uniCngnMid: 0.00072538,
    uniWarsMid: 0.00067808,
    skewMetrics,
  });
  assert.equal(risk.enabled, true);
  assert.equal(risk.corridors.length, 4);

  const regJsonPath = path.join(__dirname, '..', 'docs', '.well-known', 'agent-registration.json');
  const regJson = JSON.parse(fs.readFileSync(regJsonPath, 'utf8'));
  assert.equal(regJson.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  assert.ok(renderDashboardHtml().includes('ERC-8004'));
});
