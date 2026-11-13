/**
 * Skew v2 — Quantitative EWMA Volatility, Markout Toxicity, Bounded Gemini LLM & Rust Policy Bridge
 *
 * Bridges Engine 2 (Node.js Quant & Risk Desk) to Engine 1 (Rust `textile-stitch/src/pricing/skew.rs`)
 * via atomic 2-second hot-reload of `skew-policy.json`:
 * - Rolling EWMA volatility (`ewma_vol_bps`, lambda = 0.94)
 * - Post-fill +1m/+5m markout toxicity (`markout_toxicity_bps`)
 * - Regional central-bank horizon (`session_horizon_hours`: 4h open, 16h overnight, 72h weekend)
 * - Avellaneda-Stoikov time-scaled volatility reservation & half-spread term: 0.5 * gamma * sigma * sqrt(tau / 24)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

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
 * Compute inventory skew and dual-oracle anti-arb quotes mirroring `textile-stitch/src/pricing/skew.rs`
 */
export function computeSkewAndQuotes({
  usdtUsd,
  cngnBalance,
  textileMid,
  uniMid,
  baseBuyBps = 25,
  baseSellBps = 35,
  gammaBps = 30,
}) {
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

  const askCngnPerUsdt = effectiveSellMid > 0
    ? (1 / effectiveSellMid) / (1 + targetSellBps / 10000)
    : null;
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
 * Compute dynamic trade sizing slices (100%, 75%, 50%, 35%, 20% of liquid USDT budget, plus $25 floor)
 * at 92% free-USDT utilization up to maxSliceUsdt ($400 default) to maximize net dollar profit (edgeUsd).
 */
export function computeSliceSizesUsdt(liquidUsdt, maxSliceUsdt = 400) {
  const budget = Math.max(1.0, Math.min(maxSliceUsdt, Number(liquidUsdt || 25) * 0.92));
  const rawSlices = [budget, budget * 0.75, budget * 0.5, budget * 0.35, budget * 0.2, Math.min(25, budget)];
  const unique = [...new Set(rawSlices.map((v) => Number(Math.max(1.0, v).toFixed(2))))];
  return unique.sort((a, b) => b - a);
}

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
      return { session: 'CBN_LAGOS_WEEKEND_CLOSED', isOpen: false, isWeekend: true, spreadBufferBps: 5, carryMultiplier: 3.0, horizonHours: 72.0 };
    }
    const isOpen = hour >= 7 && hour < 15;
    return {
      session: isOpen ? 'CBN_LAGOS_OPEN' : 'CBN_LAGOS_OVERNIGHT',
      isOpen,
      isWeekend: false,
      spreadBufferBps: isOpen ? 0 : 2,
      carryMultiplier: isOpen ? 1.0 : 1.5,
      horizonHours: isOpen ? 4.0 : 16.0,
    };
  }
  if (symbol === 'wARS' || symbol === 'wARS/USDT') {
    if (isWeekend) {
      return { session: 'BCRA_BUE_WEEKEND_CLOSED', isOpen: false, isWeekend: true, spreadBufferBps: 6, carryMultiplier: 3.0, horizonHours: 72.0 };
    }
    const isOpen = hour >= 13 && hour < 18;
    return {
      session: isOpen ? 'BCRA_BUE_OPEN' : 'BCRA_BUE_OVERNIGHT',
      isOpen,
      isWeekend: false,
      spreadBufferBps: isOpen ? 0 : 3,
      carryMultiplier: isOpen ? 1.0 : 1.5,
      horizonHours: isOpen ? 4.0 : 16.0,
    };
  }
  if (symbol === 'wBRL' || symbol === 'wBRL/USDT') {
    if (isWeekend) {
      return { session: 'BCB_SAO_WEEKEND_CLOSED', isOpen: false, isWeekend: true, spreadBufferBps: 4, carryMultiplier: 2.5, horizonHours: 72.0 };
    }
    const isOpen = hour >= 12 && hour < 20;
    return {
      session: isOpen ? 'BCB_SAO_OPEN' : 'BCB_SAO_OVERNIGHT',
      isOpen,
      isWeekend: false,
      spreadBufferBps: isOpen ? 0 : 1,
      carryMultiplier: isOpen ? 1.0 : 1.25,
      horizonHours: isOpen ? 4.0 : 16.0,
    };
  }
  return { session: 'GLOBAL_USD_24_7', isOpen: true, isWeekend, spreadBufferBps: 0, carryMultiplier: 1.0, horizonHours: 1.0 };
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
        samples: 0,
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

  state.samples = (state.samples || 0) + 1;
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
export function evaluateMarkoutAdjustments(records = [], currentMids = {}, nowMs = Date.now(), tokens = []) {
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

  const symbols = tokens.length > 0 ? tokens.map((t) => t.symbol || t) : ['cNGN', 'wARS', 'wBRL', 'USDC'];
  const bySymbol = {};
  for (const sym of symbols) {
    const scored = records
      .filter((r) => r.symbol === sym && (r.markout5mBps != null || r.markout1mBps != null))
      .slice(0, 5);
    if (scored.length === 0) {
      bySymbol[sym] = { scoredFills: 0, avgMarkoutBps: 0, markoutBufferBps: 0 };
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
    bySymbol[sym] = { scoredFills: scored.length, avgMarkoutBps: avgRounded, markoutBufferBps };
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
    'Note: Rust Dual-Oracle Anti-Arb Guard (min/max of Textile & Uniswap v3) AND central-bank session buffers are ALREADY enforced below you in deterministic code.',
    'Evaluate ONLY the objective real-time corridor metrics below (no prior LLM state).',
    'Rules:',
    '- Default to NORMAL (addBuyBps=0, addSellBps=0, gammaBps=6) whenever ewmaVolBps <= 12, basisShockBps <= 80, and avgMarkoutBps >= -4 so our Maker wins top-of-book RFQ flow. Do NOT widen solely for routine overnight/weekend carry.',
    '- Cold-start guard: if warmupSamples < 3, output NORMAL (addBuyBps=0, addSellBps=0) unless basisShockBps > 80. Never TIGHTEN when warmupSamples < 3.',
    '- Use TIGHTEN (addBuyBps/addSellBps -1) ONLY when warmupSamples >= 3, ewmaVolBps < 4, basisShockBps < 20, and avgMarkoutBps >= 0.',
    '- Use WIDEN (addSellBps 4..20, gammaBps 8..12) ONLY on active market stress: ewmaVolBps > 12, basisShockBps > 80, or toxic avgMarkoutBps < -4.',
    '- Only use PAUSE_SELL / PAUSE_BUY / PAUSE_ALL (15..45 min) on severe dislocation (basisShockBps > 160 or ewmaVolBps > 35).',
    'Return strict JSON: {"marketRegimeSummary":"string","corridors":[{"corridor":"cNGN/USDT","action":"NORMAL|WIDEN|TIGHTEN|PAUSE_SELL|PAUSE_BUY|PAUSE_ALL","addBuyBps":0,"addSellBps":0,"gammaBps":6,"pauseMinutes":0,"rationale":"concise quant reason"}]}',
    `Telemetry: ${JSON.stringify(payload)}`,
  ].join('\n');
}

export async function runGeminiRiskSupervisor({
  corridors = [],
  fetchImpl = fetch,
  apiKey = process.env.GEMINI_API_KEY || '',
  model = process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  nowMs = Date.now(),
  persistLog = true,
  llmLogPath = path.join(REPO_ROOT, 'llm-decisions.jsonl'),
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
          fs.appendFileSync(llmLogPath, JSON.stringify(summary) + '\n');
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

const DEFAULT_TOKEN_ADDRESSES = {
  cNGN: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f',
  wARS: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D',
  wBRL: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0',
  USDC: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  USAT: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771',
};

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
  targetCorridorUsd = Number(process.env.TARGET_CORRIDOR_USD || '24'),
  maxSliceUsdt = Number(process.env.MAX_SLICE_USDT || '400'),
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
  const sliceSizesUsdt = computeSliceSizesUsdt(usdt, maxSliceUsdt);

  const compactFloatMode = targetCorridorUsd <= 10;
  const shareFloor = compactFloatMode ? 0.015 : 0.08;
  const usdtShareWeight = Number(
    Math.max(shareFloor, Math.min(1.0, Math.max(0.5, targetCorridorUsd) / Math.max(usdt, targetCorridorUsd, 1))).toFixed(4)
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

  const warsDispersionBps = warsTextileMid > 0 && uniWarsMid > 0
    ? Number((((uniWarsMid - warsTextileMid) / warsTextileMid) * 10000).toFixed(1))
    : warsOffChainBasisBps;
  const wbrlDispersionBps = wbrlOffChainBasisBps;
  const usdcDispersionBps = Number((((usdcMidUsd - 1.0) / 1.0) * 10000).toFixed(1));

  const resolveAdjustments = (sym, corridorName, baseBuy, baseSell, sessionObj, priorCarry) => {
    const q = quantBySymbol[sym] || {};
    const m = markoutBySymbol[sym] || {};
    const llmRaw = llmOverlay?.decisions?.[corridorName];
    const llmActive = llmRaw && (!llmRaw.pausedUntilMs || llmRaw.pausedUntilMs > nowMs) ? llmRaw : null;
    const pauseActive = Boolean(llmRaw && llmRaw.pausedUntilMs > nowMs);

    const isWeekend = String(sessionObj?.session || '').includes('WEEKEND');
    const rawSessionBuf = sessionObj?.spreadBufferBps ?? 0;
    const effectiveSessionBuf = isWeekend ? rawSessionBuf : Math.min(1, rawSessionBuf);

    const volBuf = q.volBufferBps || 0;
    const basisBuf = q.basisBufferBps || 0;
    const markoutBuf = m.markoutBufferBps || 0;
    const warmedUp = (q.samples ?? 0) >= 3;
    // ponytail: deterministic calm-market clamp prevents LLM over-caution from pricing Maker out of top-of-book when vol/basis/markouts are benign
    const calmMarket = (q.ewmaVolBps ?? 0) <= 12 && (q.basisShockBps ?? 0) <= 80 && (m.avgMarkoutBps ?? 0) >= -4;
    const rawLlmBuy = llmActive ? (warmedUp ? llmActive.addBuyBps : Math.max(0, llmActive.addBuyBps)) : 0;
    const rawLlmSell = llmActive ? (warmedUp ? llmActive.addSellBps : Math.max(0, llmActive.addSellBps)) : 0;
    const llmBuy = calmMarket && !pauseActive ? Math.min(0, rawLlmBuy) : rawLlmBuy;
    const llmSell = calmMarket && !pauseActive ? Math.min(1, rawLlmSell) : rawLlmSell;
    const gammaBps = llmActive?.gammaBps ?? Number(process.env.SKEW_GAMMA_BPS || 6);
    const dailyCarry = q.dailyCarryBps ?? priorCarry;

    const stitchBuyOffsetBps = Math.max(1, Math.min(120, baseBuy + Math.max(0, Math.round(volBuf * 0.5)) + llmBuy));
    const stitchSellOffsetBps = Math.max(
      1,
      Math.min(150, baseSell + effectiveSessionBuf + volBuf + basisBuf + markoutBuf + llmSell)
    );
    return {
      warmupSamples: q.samples ?? 0,
      ewmaVolBps: q.ewmaVolBps ?? 0,
      basisShockBps: q.basisShockBps ?? 0,
      avgMarkoutBps: m.avgMarkoutBps ?? 0,
      scoredMarkoutFills: m.scoredFills ?? 0,
      dailyCarryBps: dailyCarry,
      gammaBps,
      sessionHorizonHours: sessionObj?.horizonHours ?? 4.0,
      stitchBuyOffsetBps,
      stitchSellOffsetBps,
      paused: pauseActive && llmRaw.action === 'PAUSE_ALL',
      pauseBuy: pauseActive && llmRaw.action === 'PAUSE_BUY',
      pauseSell: pauseActive && llmRaw.action === 'PAUSE_SELL',
      llmAction: llmActive?.action || 'DETERMINISTIC',
      llmRationale: llmActive?.rationale || null,
    };
  };

  // ponytail: when targetCorridorUsd <= $10 ($350+ USDT vs $5 local float), skew.rs clamps usdt_share_weight >= 0.05 (+0.56 skew),
  // which would subtract ~3.4 bps and slam a 3 bps baseBuy down to 1 bps — causing Maker self-matches on $350 uni->textile sweeps.
  // Boosting baseBuy by +5 bps (+3 on USDC) keeps Maker Bids at high-margin ~5-6 bps net while leaving top-of-book clear for Taker arbs.
  const emBaseBuy = compactFloatMode ? 8 : 3;
  const usdcBaseBuy = compactFloatMode ? 5 : 2;
  const cngnAdj = resolveAdjustments('cNGN', 'cNGN/USDT', emBaseBuy, 3, cngnSession, 8.5);
  const warsAdj = resolveAdjustments('wARS', 'wARS/USDT', emBaseBuy, 3, warsSession, 13.3);
  const wbrlAdj = resolveAdjustments('wBRL', 'wBRL/USDT', emBaseBuy, 3, wbrlSession, 4.2);
  const usdcAdj = resolveAdjustments('USDC', 'USDC/USDT', usdcBaseBuy, 1, usdcSession, 0.0);

  const decisions = [
    {
      corridor: 'cNGN/USDT',
      corridorSlug: 'cngn-usdt-celo',
      collateralAddress: DEFAULT_TOKEN_ADDRESSES.cNGN,
      dexMidUsd: Number(uniCngnMid.toFixed(9)),
      regime: cngnAdj.paused || cngnAdj.pauseSell ? 'LLM_GUARD_PAUSED' : Math.abs(skewMetrics.oracleGapBps) > 15 ? 'DUAL_ORACLE_SHIELD' : 'SKEW_REBALANCE',
      bankingSession: cngnSession.session,
      sessionSpreadBufferBps: cngnSession.spreadBufferBps,
      inventoryUsd: Number(cngnUsd.toFixed(2)),
      skew: normSkew(cngnUsd),
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
      collateralAddress: DEFAULT_TOKEN_ADDRESSES.wARS,
      dexMidUsd: Number(uniWarsMid.toFixed(9)),
      regime: warsAdj.paused || warsAdj.pauseSell ? 'LLM_GUARD_PAUSED' : 'DUAL_ORACLE_SHIELD',
      bankingSession: warsSession.session,
      sessionSpreadBufferBps: warsSession.spreadBufferBps,
      inventoryUsd: Number(warsUsd.toFixed(2)),
      skew: normSkew(warsUsd),
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
      collateralAddress: DEFAULT_TOKEN_ADDRESSES.wBRL,
      dexMidUsd: Number(wbrlMidUsd.toFixed(6)),
      regime: wbrlAdj.paused || wbrlAdj.pauseSell ? 'LLM_GUARD_PAUSED' : wbrlUsd >= 5 ? 'TWO_WAY_ACTIVE' : 'GAS_SHIELD_BUY_ACTIVE',
      bankingSession: wbrlSession.session,
      sessionSpreadBufferBps: wbrlSession.spreadBufferBps,
      inventoryUsd: Number(wbrlUsd.toFixed(2)),
      skew: normSkew(wbrlUsd),
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
      collateralAddress: DEFAULT_TOKEN_ADDRESSES.USDC,
      dexMidUsd: Number(usdcMidUsd.toFixed(6)),
      regime: usdcAdj.paused ? 'LLM_GUARD_PAUSED' : 'PEG_TIGHT_TWO_WAY',
      bankingSession: usdcSession.session,
      sessionSpreadBufferBps: 0,
      inventoryUsd: Number(usdcUsd.toFixed(2)),
      skew: normSkew(usdcUsd),
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
 * so per-corridor spreads, gamma, EWMA volatility (`ewma_vol_bps`), post-fill markout toxicity
 * (`markout_toxicity_bps`), central-bank session horizon (`session_horizon_hours`), and bounded LLM
 * pauses take effect immediately on live WebSocket RFQs without restarting the Rust Stitch process.
 */
export function syncStitchRuntimePolicy(
  riskOfficer,
  policyPath = process.env.SKEW_POLICY_FILE || path.join(REPO_ROOT, 'skew-policy.json')
) {
  if (!riskOfficer?.decisions) return { updated: false };
  const corridors = {};
  for (const d of riskOfficer.decisions) {
    if (!d.collateralAddress) continue;
    const markoutToxicityBps = d.avgMarkoutBps < 0 ? Number(Math.abs(d.avgMarkoutBps).toFixed(2)) : 0.0;
    corridors[d.collateralAddress] = {
      corridor: d.corridor,
      paused: Boolean(d.paused),
      pause_buy: Boolean(d.pauseBuy),
      pause_sell: Boolean(d.pauseSell),
      buy_offset_bps: d.stitchBuyOffsetBps,
      sell_offset_bps: d.stitchSellOffsetBps,
      gamma_bps: d.gammaBps ?? 6,
      usdt_share_weight: d.usdtShareWeight ?? riskOfficer.usdtShareWeight ?? 0.25,
      ewma_vol_bps: Number((d.ewmaVolBps ?? 0).toFixed(2)),
      markout_toxicity_bps: markoutToxicityBps,
      session_horizon_hours: d.sessionHorizonHours ?? 4.0,
      lean_floor_bps: 1.0,
      dex_mid: d.dexMidUsd ?? null,
      fail_closed_without_dex: false,
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
  baseTomlPath = path.join(REPO_ROOT, 'stitch.toml'),
  runtimeTomlPath = path.join(REPO_ROOT, 'stitch.runtime.toml')
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
