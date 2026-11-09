// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Textile, Inc. / Skew Project
//! Adaptive Inventory-Skew, TWAP/Lean & Dual-Oracle Pricing for Textile FX RFQ Corridors.
//!
//! Connects:
//! 1. Dual-Oracle Shield (`min/max` of Textile FX Oracle, 120s step-function `Twap`, and Celo Uniswap v3 `slot0()`).
//! 2. Multi-corridor normalized Avellaneda-Stoikov skew (`s`) + `lean.rs` floor-clamped inventory bands (`x`).
//! 3. Zero-restart `skew-policy.json` hot-reload bridging Engine 2's EWMA volatility (`ewma_vol_bps`),
//!    post-fill markout toxicity (`markout_toxicity_bps`), and central-bank session horizon (`session_horizon_hours`).

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, U256};
use serde::Deserialize;
use crate::pricing::lean::{inventory_share, target_offsets, LeanParams};
use crate::pricing::quote::Spread;
use crate::pricing::twap::Twap;
use crate::rfq::wire::RejectReason;

/// Hard safety rails
pub const MIN_SPREAD_BPS: u32 = 1;              // Allow tightening down to 1 bps to win top-of-book RFQ flow
pub const MAX_SPREAD_BPS: u32 = 150;            // Never quote wider than 150 bps (unless base_bps > 150)
pub const EXTREME_IMBALANCE_THRESHOLD: f64 = 0.85; // |s| >= 0.85 triggers one-sided quoting
pub const MIN_PORTFOLIO_VALUE_USD: f64 = 0.05;  // Under $0.05 total value, fail closed
const POLICY_CACHE_TTL: Duration = Duration::from_secs(2);
const DEFAULT_RFQ_TWAP_WINDOW_SECS: u64 = 120;
const DEFAULT_RFQ_TWAP_MAX_GAP_SECS: u64 = 900;

static DEX_PRESENT_QUOTES: AtomicU64 = AtomicU64::new(0);
static DEX_ABSENT_FALLBACK_QUOTES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct CorridorRuntimePolicy {
    pub paused: bool,
    pub pause_buy: bool,
    pub pause_sell: bool,
    pub buy_offset_bps: Option<u32>,
    pub sell_offset_bps: Option<u32>,
    pub gamma_bps: Option<u32>,
    /// Share of shared wallet USDT assigned to this corridor in (0.05..=1.0) so multi-corridor skew centers around 0.0
    pub usdt_share_weight: Option<f64>,
    /// Rolling EWMA volatility in bps bridged from Engine 2 (`updateCorridorQuantState`)
    pub ewma_vol_bps: Option<f64>,
    /// Post-fill +1m/+5m markout toxicity in bps bridged from Engine 2 (`evaluateMarkoutAdjustments`)
    pub markout_toxicity_bps: Option<f64>,
    /// Remaining hours in current central-bank settlement regime (1h open, 16h overnight, 72h weekend)
    pub session_horizon_hours: Option<f64>,
    /// Minimum feed-accuracy floor spread in bps enforced via `lean::target_offsets`
    pub lean_floor_bps: Option<f64>,
    /// Optional strict mode: reject SELL quotes if external DEX reference price is absent
    pub fail_closed_without_dex: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct RuntimePolicyFile {
    corridors: HashMap<String, CorridorRuntimePolicy>,
}

#[derive(Default)]
struct RuntimePolicyCache {
    last_checked: Option<Instant>,
    last_mtime: Option<SystemTime>,
    last_path: String,
    policies: HashMap<Address, CorridorRuntimePolicy>,
}

static POLICY_CACHE: OnceLock<RwLock<RuntimePolicyCache>> = OnceLock::new();

fn policy_cache() -> &'static RwLock<RuntimePolicyCache> {
    POLICY_CACHE.get_or_init(|| RwLock::new(RuntimePolicyCache::default()))
}

/// Zero-restart hot-reload policy reader (ponytail: mtime-gated every 2s; zero blocking I/O on RFQ hot path).
pub fn get_corridor_runtime_policy(collateral: Address) -> Option<CorridorRuntimePolicy> {
    let path = std::env::var("SKEW_POLICY_FILE").unwrap_or_else(|_| "./skew-policy.json".to_string());
    if let Ok(guard) = policy_cache().read() {
        if guard.last_path == path
            && guard
                .last_checked
                .is_some_and(|t| t.elapsed() < POLICY_CACHE_TTL)
        {
            return guard.policies.get(&collateral).cloned();
        }
    }
    let Ok(mut guard) = policy_cache().write() else {
        return None;
    };
    let path_changed = guard.last_path != path;
    guard.last_checked = Some(Instant::now());
    guard.last_path = path.clone();

    let Ok(meta) = fs::metadata(&path) else {
        if path_changed {
            guard.last_mtime = None;
            guard.policies.clear();
        }
        return guard.policies.get(&collateral).cloned();
    };
    let mtime = meta.modified().ok();
    if !path_changed && mtime.is_some() && mtime == guard.last_mtime {
        return guard.policies.get(&collateral).cloned();
    }
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<RuntimePolicyFile>(&raw) {
            let mut next = HashMap::new();
            for (k, v) in parsed.corridors {
                if let Ok(addr) = k.parse::<Address>() {
                    next.insert(addr, v);
                }
            }
            guard.policies = next;
            guard.last_mtime = mtime;
        }
    }
    guard.policies.get(&collateral).cloned()
}

static DEX_MID_CACHE: OnceLock<RwLock<HashMap<Address, f64>>> = OnceLock::new();
static RFQ_TWAP_CACHE: OnceLock<RwLock<HashMap<Address, Twap>>> = OnceLock::new();

fn dex_cache() -> &'static RwLock<HashMap<Address, f64>> {
    DEX_MID_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn rfq_twap_cache() -> &'static RwLock<HashMap<Address, Twap>> {
    RFQ_TWAP_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Record the latest on-chain DEX (Uniswap v3) mid-price (debt per collateral, e.g. USDT per cNGN)
/// for a collateral token so the RFQ engine never quotes through the external DEX market.
pub fn set_dex_reference_price(collateral: Address, dex_mid: f64) {
    if dex_mid.is_finite() && dex_mid > 0.0 {
        if let Ok(mut map) = dex_cache().write() {
            map.insert(collateral, dex_mid);
        }
    }
}

/// Decode Multicall3 `slot0()` (`0x3850c7bd`) readings from the 4 Celo Mainnet Uniswap v3 0.01% pools
/// (`cNGN/USDT`, `wARS/USDT`, `USDC/USDT`, `wBRL/USDT`) and update `DEX_MID_CACHE` via [`set_dex_reference_price`].
/// Called every inventory refresh cycle (2s) by `rfq::refresh_celo_dex_reference`.
pub fn decode_and_cache_celo_dex_slot0(
    cngn_slot0: Option<&[u8]>,
    wars_slot0: Option<&[u8]>,
    usdc_slot0: Option<&[u8]>,
    wbrl_slot0: Option<&[u8]>,
) -> usize {
    let mut updated = 0usize;
    let q96 = 2f64.powi(96);

    if let (Some(bytes), Ok(tok)) = (
        cngn_slot0,
        "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f".parse::<Address>(),
    ) {
        if bytes.len() >= 32 {
            let sqrt_x96 = U256::from_be_slice(&bytes[..32]);
            if let Ok(v) = sqrt_x96.to_string().parse::<f64>() {
                let sqrt_p = v / q96;
                let cngn_per_usdt = sqrt_p * sqrt_p;
                if cngn_per_usdt > 100.0 && cngn_per_usdt < 10_000.0 {
                    set_dex_reference_price(tok, 1.0 / cngn_per_usdt);
                    updated += 1;
                }
            }
        }
    }
    if let (Some(bytes), Ok(tok)) = (
        wars_slot0,
        "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D".parse::<Address>(),
    ) {
        if bytes.len() >= 32 {
            let sqrt_x96 = U256::from_be_slice(&bytes[..32]);
            if let Ok(v) = sqrt_x96.to_string().parse::<f64>() {
                let sqrt_p = v / q96;
                let usdt_per_wars = sqrt_p * sqrt_p * 1e12;
                if usdt_per_wars > 0.00005 && usdt_per_wars < 0.05 {
                    set_dex_reference_price(tok, usdt_per_wars);
                    updated += 1;
                }
            }
        }
    }
    if let (Some(bytes), Ok(tok)) = (
        usdc_slot0,
        "0xcebA9300f2b948710d2653dD7B07f33A8B32118C".parse::<Address>(),
    ) {
        if bytes.len() >= 32 {
            let sqrt_x96 = U256::from_be_slice(&bytes[..32]);
            if let Ok(v) = sqrt_x96.to_string().parse::<f64>() {
                let sqrt_p = v / q96;
                let usdc_per_usdt = sqrt_p * sqrt_p;
                if usdc_per_usdt > 0.80 && usdc_per_usdt < 1.20 {
                    set_dex_reference_price(tok, 1.0 / usdc_per_usdt);
                    updated += 1;
                }
            }
        }
    }
    // Note: wBRL pool 0x01c3...A40F at MAX_TICK (887,271 -> ~10^38) fails the (2.0..20.0) sanity bound and is excluded
    if let (Some(bytes), Ok(tok)) = (
        wbrl_slot0,
        "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0".parse::<Address>(),
    ) {
        if bytes.len() >= 32 {
            let sqrt_x96 = U256::from_be_slice(&bytes[..32]);
            if let Ok(v) = sqrt_x96.to_string().parse::<f64>() {
                let sqrt_p = v / q96;
                let wbrl_per_usdt = (sqrt_p * sqrt_p) / 1e12;
                if wbrl_per_usdt > 2.0 && wbrl_per_usdt < 20.0 {
                    set_dex_reference_price(tok, 1.0 / wbrl_per_usdt);
                    updated += 1;
                }
            }
        }
    }
    updated
}

/// Look up the latest external DEX reference price for a collateral token.
pub fn get_dex_reference_price(collateral: Address) -> Option<f64> {
    if let Ok(env_val) = std::env::var("SKEW_DEX_MID") {
        if let Ok(parsed) = env_val.parse::<f64>() {
            if parsed.is_finite() && parsed > 0.0 {
                return Some(parsed);
            }
        }
    }
    dex_cache().read().ok()?.get(&collateral).copied()
}

/// Telemetry counters for DEX reference coverage (`(dex_present_quotes, dex_absent_fallback_quotes)`).
pub fn dex_shield_telemetry_counts() -> (u64, u64) {
    (
        DEX_PRESENT_QUOTES.load(Ordering::Relaxed),
        DEX_ABSENT_FALLBACK_QUOTES.load(Ordering::Relaxed),
    )
}

/// Feed the corridor's live oracle observation into its rolling 120s step-function [`Twap`]
/// (`crate::pricing::twap::Twap`) and return the smoothed TWAP mid.
pub fn observe_rfq_twap_mid(collateral: Address, oracle_mid: f64, now_secs: u64) -> f64 {
    if !oracle_mid.is_finite() || oracle_mid <= 0.0 {
        return oracle_mid;
    }
    let Ok(mut guard) = rfq_twap_cache().write() else {
        return oracle_mid;
    };
    let twap = guard
        .entry(collateral)
        .or_insert_with(|| Twap::new(DEFAULT_RFQ_TWAP_WINDOW_SECS, DEFAULT_RFQ_TWAP_MAX_GAP_SECS));
    let _ = twap.observe(now_secs, oracle_mid, now_secs);
    twap.value(now_secs).unwrap_or(oracle_mid)
}

/// Anti-Arb Dual-Oracle Price Guard:
/// - When buying collateral (`bid = true`, Maker pays USDT): anchor to `min(oracle_mid, dex_mid)`
///   so our bid is never above the external DEX price.
/// - When selling collateral (`bid = false`, Maker sells cNGN): anchor to `max(oracle_mid, dex_mid)`
///   so our ask is never below the external DEX price (preventing cross-venue arbitrage drain).
pub fn effective_mid_for_side(oracle_mid: f64, dex_mid: Option<f64>, bid: bool) -> f64 {
    match dex_mid {
        Some(d) if d.is_finite() && d > 0.0 => {
            DEX_PRESENT_QUOTES.fetch_add(1, Ordering::Relaxed);
            if bid {
                oracle_mid.min(d)
            } else {
                oracle_mid.max(d)
            }
        }
        _ => {
            DEX_ABSENT_FALLBACK_QUOTES.fetch_add(1, Ordering::Relaxed);
            oracle_mid
        }
    }
}

/// Full RFQ mid resolver combining:
/// 1. Instantaneous Textile FX feed (`oracle_mid`),
/// 2. Rolling 120s step-function `Twap` (`crate::pricing::twap::Twap`), and
/// 3. Live Celo Uniswap v3 `slot0()` reference (`dex_mid`).
/// Logs the exact mid decision and records when `dex_mid` is present vs fallback.
pub fn effective_mid_for_corridor(
    collateral: Address,
    oracle_mid: f64,
    dex_mid: Option<f64>,
    bid: bool,
) -> f64 {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let twap_mid = observe_rfq_twap_mid(collateral, oracle_mid, now_secs);
    let twap_anchored = if bid {
        oracle_mid.min(twap_mid)
    } else {
        oracle_mid.max(twap_mid)
    };
    let eff = effective_mid_for_side(twap_anchored, dex_mid, bid);
    let (present_cnt, fallback_cnt) = dex_shield_telemetry_counts();
    eprintln!(
        "[skew-mid] collateral={} side={} oracle={:.6} twap120s={:.6} dex={:?} -> eff={:.6} (dex_present={}, dex_fallback={})",
        collateral,
        if bid { "BUY " } else { "SELL" },
        oracle_mid,
        twap_mid,
        dex_mid,
        eff,
        present_cnt,
        fallback_cnt
    );
    eff
}

/// Helper to convert U256 atomic token amounts to f64 human units.
fn u256_to_f64_decimals(val: U256, decimals: u8) -> f64 {
    let s = val.to_string();
    let num: f64 = s.parse().unwrap_or(0.0);
    num / 10f64.powi(decimals as i32)
}

/// Calculate inventory skew metric s in [-1.0, +1.0] and total portfolio value in USD
/// using explicit token decimals for debt (USDT) and collateral (cNGN, wARS, wBRL, etc.).
pub fn calculate_inventory_skew_with_decimals(
    usdt_balance: U256,
    debt_decimals: u8,
    cngn_balance: U256,
    collateral_decimals: u8,
    mid: f64,
) -> (f64, f64, f64, f64) {
    let usdt_f64 = u256_to_f64_decimals(usdt_balance, debt_decimals);
    let cngn_f64 = u256_to_f64_decimals(cngn_balance, collateral_decimals);

    let cngn_val_usd = cngn_f64 * mid;
    let usdt_val_usd = usdt_f64;
    let total_val_usd = usdt_val_usd + cngn_val_usd;

    if total_val_usd < MIN_PORTFOLIO_VALUE_USD {
        return (0.0, total_val_usd, usdt_val_usd, cngn_val_usd);
    }

    // s = (V_usdt - V_cngn) / V_total
    let s = (usdt_val_usd - cngn_val_usd) / total_val_usd;
    (s.clamp(-1.0, 1.0), total_val_usd, usdt_val_usd, cngn_val_usd)
}

/// Calculate inventory skew metric s in [-1.0, +1.0] and total portfolio value in USD.
pub fn calculate_inventory_skew(
    usdt_balance: U256,
    cngn_balance: U256,
    mid: f64,
) -> (f64, f64, f64, f64) {
    calculate_inventory_skew_with_decimals(usdt_balance, 6, cngn_balance, 6, mid)
}

/// Computes the dynamic skew-adjusted spread for the active RFQ side with explicit token decimals.
pub fn calculate_dynamic_spread_with_decimals(
    base_spread: Spread,
    bid: bool,
    usdt_balance: U256,
    debt_decimals: u8,
    cngn_balance: U256,
    collateral_decimals: u8,
    mid: f64,
    gamma_bps: u32,
) -> Result<Spread, RejectReason> {
    let (skew, total_val, usdt_val, cngn_val) = calculate_inventory_skew_with_decimals(
        usdt_balance,
        debt_decimals,
        cngn_balance,
        collateral_decimals,
        mid,
    );

    if total_val < MIN_PORTFOLIO_VALUE_USD {
        return Err(RejectReason::Inventory);
    }

    if skew >= EXTREME_IMBALANCE_THRESHOLD && !bid && cngn_val < 1.00 {
        return Err(RejectReason::Inventory);
    }
    if skew <= -EXTREME_IMBALANCE_THRESHOLD && bid && usdt_val < 1.00 {
        return Err(RejectReason::Inventory);
    }

    let base_bps = match base_spread {
        Spread::Bps(b) => b,
        Spread::Abs(_) => {
            return Ok(base_spread);
        }
    };

    let delta = (gamma_bps as f64) * skew;
    let raw_bps = if bid {
        (base_bps as f64) - delta
    } else {
        (base_bps as f64) + delta
    };

    let max_bps = MAX_SPREAD_BPS.max(base_bps);
    let dynamic_bps = (raw_bps.round() as i64)
        .clamp(MIN_SPREAD_BPS as i64, max_bps as i64) as u32;

    eprintln!(
        "[skew] side={} s={:+.3} base={}bps -> dynamic={}bps (usdt=${:.2}, coll=${:.2}, total=${:.2})",
        if bid { "BUY " } else { "SELL" },
        skew,
        base_bps,
        dynamic_bps,
        usdt_val,
        cngn_val,
        total_val
    );

    Ok(Spread::Bps(dynamic_bps))
}

/// Computes the dynamic skew-adjusted spread for the active RFQ side (default 6dp).
pub fn calculate_dynamic_spread(
    base_spread: Spread,
    bid: bool,
    usdt_balance: U256,
    cngn_balance: U256,
    mid: f64,
    gamma_bps: u32,
) -> Result<Spread, RejectReason> {
    calculate_dynamic_spread_with_decimals(
        base_spread,
        bid,
        usdt_balance,
        6,
        cngn_balance,
        6,
        mid,
        gamma_bps,
    )
}

/// Convenience entry point reading `SKEW_GAMMA_BPS` from environment (default: 30 bps).
pub fn adjust_spread_for_skew_with_decimals(
    base_spread: Spread,
    bid: bool,
    usdt_balance: U256,
    debt_decimals: u8,
    cngn_balance: U256,
    collateral_decimals: u8,
    mid: f64,
) -> Result<Spread, RejectReason> {
    let gamma_bps = std::env::var("SKEW_GAMMA_BPS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(30);

    calculate_dynamic_spread_with_decimals(
        base_spread,
        bid,
        usdt_balance,
        debt_decimals,
        cngn_balance,
        collateral_decimals,
        mid,
        gamma_bps,
    )
}

/// Convenience entry point reading `SKEW_GAMMA_BPS` from environment (default: 30 bps).
pub fn adjust_spread_for_skew(
    base_spread: Spread,
    bid: bool,
    usdt_balance: U256,
    cngn_balance: U256,
    mid: f64,
) -> Result<Spread, RejectReason> {
    adjust_spread_for_skew_with_decimals(base_spread, bid, usdt_balance, 6, cngn_balance, 6, mid)
}

/// Apply live hot-reloaded corridor policy (`paused`, `pause_buy`, `pause_sell`, dynamic base offsets,
/// `gamma_bps`, multi-corridor `usdt_share_weight`, Engine 2's `ewma_vol_bps`, `markout_toxicity_bps`,
/// `session_horizon_hours`, and `lean.rs` floor clamp) on top of inventory-skew pricing without restarting Stitch.
///
/// Per-quote pipeline (`inputs -> mid -> spread -> floor clamp`):
/// 1. `inputs`: normalized skew `s`, collateral share `x`, EWMA volatility `σ`, horizon `τ`, markout `m`
/// 2. `mid`: `effective_mid_for_corridor` (`min/max` of Textile FX Oracle, 120s `Twap`, and Uniswap v3 `slot0()`)
/// 3. `spread`: `base ± γ·s + 0.5·(γ/6)·σ·√(τ/24) + max(0, -m)`
/// 4. `floor clamp`: `lean::target_offsets` feed-accuracy floor (`lean_floor_bps`, clamped to `[1, 150] bps`)
pub fn apply_corridor_policy_and_skew(
    policy: Option<&CorridorRuntimePolicy>,
    base_spread: Spread,
    bid: bool,
    usdt_balance: U256,
    debt_decimals: u8,
    collateral_balance: U256,
    collateral_decimals: u8,
    mid: f64,
    default_gamma_bps: u32,
) -> Result<Spread, RejectReason> {
    if let Some(p) = policy {
        if p.paused || (bid && p.pause_buy) || (!bid && p.pause_sell) {
            return Err(RejectReason::Busy);
        }
    }

    let effective_base = match policy {
        Some(p) if bid && p.buy_offset_bps.is_some() => Spread::Bps(p.buy_offset_bps.unwrap()),
        Some(p) if !bid && p.sell_offset_bps.is_some() => Spread::Bps(p.sell_offset_bps.unwrap()),
        _ => base_spread,
    };

    let gamma_bps = policy
        .and_then(|p| p.gamma_bps)
        .unwrap_or(default_gamma_bps);

    let raw_usdt_val = u256_to_f64_decimals(usdt_balance, debt_decimals);
    let coll_val = u256_to_f64_decimals(collateral_balance, collateral_decimals) * mid;
    let raw_total_val = raw_usdt_val + coll_val;
    if raw_total_val < MIN_PORTFOLIO_VALUE_USD {
        return Err(RejectReason::Inventory);
    }

    let weight = policy
        .and_then(|p| p.usdt_share_weight)
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or(1.0)
        .clamp(0.05, 1.0);
    let alloc_usdt_val = raw_usdt_val * weight;
    let alloc_total = alloc_usdt_val + coll_val;
    let skew = if alloc_total >= MIN_PORTFOLIO_VALUE_USD {
        ((alloc_usdt_val - coll_val) / alloc_total).clamp(-1.0, 1.0)
    } else {
        0.0
    };

    if skew >= EXTREME_IMBALANCE_THRESHOLD && !bid && coll_val < 1.00 {
        return Err(RejectReason::Inventory);
    }
    if skew <= -EXTREME_IMBALANCE_THRESHOLD && bid && raw_usdt_val < 1.00 {
        return Err(RejectReason::Inventory);
    }

    let Spread::Bps(base_bps) = effective_base else {
        return Ok(effective_base);
    };

    // 1. Inventory-skew term: ± γ · s
    let skew_delta = (gamma_bps as f64) * skew;
    let skew_adjusted = if bid {
        (base_bps as f64) - skew_delta
    } else {
        (base_bps as f64) + skew_delta
    };

    // 2. Avellaneda-Stoikov volatility-time term: 0.5 * (γ / 6) * σ_EWMA * sqrt(τ / 24h)
    let ewma_vol_bps = policy
        .and_then(|p| p.ewma_vol_bps)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.0);
    let horizon_hours = policy
        .and_then(|p| p.session_horizon_hours)
        .filter(|h| h.is_finite() && *h > 0.0)
        .unwrap_or(1.0)
        .clamp(0.25, 72.0);
    let vol_tau_term = 0.5 * ((gamma_bps as f64) / 6.0) * ewma_vol_bps * (horizon_hours / 24.0).sqrt();

    // 3. Post-fill markout toxicity term (widens when markout_toxicity_bps < 0)
    let markout_bps = policy
        .and_then(|p| p.markout_toxicity_bps)
        .filter(|m| m.is_finite())
        .unwrap_or(0.0);
    let markout_term = if markout_bps < 0.0 { (-markout_bps).min(25.0) } else { 0.0 };

    // 4. `lean.rs` inventory-band floor clamp (`inventory_share` + `target_offsets`)
    let alloc_debt_atomic = (alloc_usdt_val * 1_000_000.0).round().max(0.0) as u128;
    let coll_usd_atomic = ((coll_val / mid.max(1e-12)) * 1_000_000.0).round().max(0.0) as u128;
    let x_share = inventory_share(coll_usd_atomic, 6, alloc_debt_atomic, 6, mid).unwrap_or(0.5);
    let lean_floor_bps = policy
        .and_then(|p| p.lean_floor_bps)
        .filter(|f| f.is_finite() && *f >= 1.0)
        .unwrap_or(MIN_SPREAD_BPS as f64);
    let lean_offsets = target_offsets(
        x_share,
        &LeanParams {
            base_bps: base_bps as f64,
            wide_bps: gamma_bps as f64,
            floor_bps: lean_floor_bps,
        },
    );
    let floor_bps = if bid {
        lean_offsets.bid_bps.unwrap_or(lean_floor_bps)
    } else {
        lean_offsets.ask_bps.unwrap_or(lean_floor_bps)
    }
    .min(lean_floor_bps);

    let raw_bps = (skew_adjusted + vol_tau_term + markout_term).max(floor_bps);
    let max_bps = MAX_SPREAD_BPS.max(base_bps);
    let dynamic_bps = (raw_bps.round() as i64).clamp(MIN_SPREAD_BPS as i64, max_bps as i64) as u32;

    eprintln!(
        "[skew-decision] inputs(side={}, s={:+.3}, x={:.3}, vol={:.2}bps, tau={:.1}h, markout={:+.2}bps) -> mid(eff={:.6}) -> spread(base={}bps, skew={:+.1}bps, vol_tau={:+.2}bps, markout={:+.2}bps) -> floor_clamp(floor={:.1}bps, final={}bps)",
        if bid { "BUY " } else { "SELL" },
        skew,
        x_share,
        ewma_vol_bps,
        horizon_hours,
        markout_bps,
        mid,
        base_bps,
        if bid { -skew_delta } else { skew_delta },
        vol_tau_term,
        markout_term,
        floor_bps,
        dynamic_bps
    );

    Ok(Spread::Bps(dynamic_bps))
}

/// Live RFQ entry point reading `skew-policy.json` (if present) and `SKEW_GAMMA_BPS`.
pub fn adjust_spread_for_corridor(
    collateral: Address,
    base_spread: Spread,
    bid: bool,
    usdt_balance: U256,
    debt_decimals: u8,
    collateral_balance: U256,
    collateral_decimals: u8,
    mid: f64,
) -> Result<Spread, RejectReason> {
    let default_gamma = std::env::var("SKEW_GAMMA_BPS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(6);
    let policy = get_corridor_runtime_policy(collateral);
    if let Some(ref p) = policy {
        if !bid && p.fail_closed_without_dex && get_dex_reference_price(collateral).is_none() {
            return Err(RejectReason::StaleFeed);
        }
    }
    apply_corridor_policy_and_skew(
        policy.as_ref(),
        base_spread,
        bid,
        usdt_balance,
        debt_decimals,
        collateral_balance,
        collateral_decimals,
        mid,
        default_gamma,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MID_RATE: f64 = 0.000728; // ~1373.6 cNGN per 1 USDT

    fn to_u256_6dp(amount: f64) -> U256 {
        let atomic = (amount * 1_000_000.0).round() as u64;
        U256::from(atomic)
    }

    #[test]
    fn test_skew_scenarios() {
        struct TestCase {
            name: &'static str,
            usdt_usd: f64,
            cngn_usd: f64,
            bid: bool,
            base_bps: u32,
            gamma_bps: u32,
            expected_bps: Result<u32, RejectReason>,
        }

        let cases = vec![
            TestCase {
                name: "Balanced inventory BUY returns base spread",
                usdt_usd: 2.00,
                cngn_usd: 2.00,
                bid: true,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(25),
            },
            TestCase {
                name: "Balanced inventory SELL returns base spread",
                usdt_usd: 2.00,
                cngn_usd: 2.00,
                bid: false,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(25),
            },
            TestCase {
                name: "Excess USDT tightens BUY to attract cNGN",
                usdt_usd: 3.00,
                cngn_usd: 1.00,
                bid: true,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(10),
            },
            TestCase {
                name: "Excess USDT widens SELL to protect cNGN",
                usdt_usd: 3.00,
                cngn_usd: 1.00,
                bid: false,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(40),
            },
            TestCase {
                name: "Excess cNGN widens BUY to discourage more cNGN",
                usdt_usd: 1.00,
                cngn_usd: 3.00,
                bid: true,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(40),
            },
            TestCase {
                name: "Excess cNGN tightens SELL to offload cNGN",
                usdt_usd: 1.00,
                cngn_usd: 3.00,
                bid: false,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(10),
            },
            TestCase {
                name: "Aggressive skew clamps at MIN_SPREAD_BPS (1 bps)",
                usdt_usd: 3.80,
                cngn_usd: 0.80,
                bid: true,
                base_bps: 20,
                gamma_bps: 50,
                expected_bps: Ok(1),
            },
            TestCase {
                name: "Wide skew clamps at MAX_SPREAD_BPS (150 bps)",
                usdt_usd: 3.80,
                cngn_usd: 0.80,
                bid: false,
                base_bps: 120,
                gamma_bps: 50,
                expected_bps: Ok(150),
            },
            TestCase {
                name: "Critical cNGN shortage rejects SELL quote",
                usdt_usd: 3.85,
                cngn_usd: 0.15,
                bid: false,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Err(RejectReason::Inventory),
            },
            TestCase {
                name: "Critical cNGN shortage still permits BUY quote",
                usdt_usd: 3.85,
                cngn_usd: 0.15,
                bid: true,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(1),
            },
            TestCase {
                name: "Near-empty wallet fails closed",
                usdt_usd: 0.01,
                cngn_usd: 0.01,
                bid: true,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Err(RejectReason::Inventory),
            },
        ];

        for tc in cases {
            let usdt_bal = to_u256_6dp(tc.usdt_usd);
            let cngn_bal = to_u256_6dp(tc.cngn_usd / MID_RATE);

            let res = calculate_dynamic_spread(
                Spread::Bps(tc.base_bps),
                tc.bid,
                usdt_bal,
                cngn_bal,
                MID_RATE,
                tc.gamma_bps,
            );

            match tc.expected_bps {
                Ok(expected) => {
                    assert_eq!(
                        res,
                        Ok(Spread::Bps(expected)),
                        "Failed scenario: {}",
                        tc.name
                    );
                }
                Err(expected_err) => {
                    assert_eq!(res, Err(expected_err), "Failed scenario: {}", tc.name);
                }
            }
        }
    }

    #[test]
    fn test_dual_oracle_anti_arb_mid_guard() {
        let textile_mid = 0.00072295; // ~1,383.22 cNGN/USDT
        let uniswap_mid = 0.00072538; // ~1,378.59 cNGN/USDT (cNGN is more expensive on Uniswap)

        let ask_mid = effective_mid_for_side(textile_mid, Some(uniswap_mid), false);
        assert_eq!(ask_mid, uniswap_mid);

        let bid_mid = effective_mid_for_side(textile_mid, Some(uniswap_mid), true);
        assert_eq!(bid_mid, textile_mid);
    }

    #[test]
    fn test_hot_reload_policy_pause_and_normalized_multicorridor_skew() {
        let usdt_bal = to_u256_6dp(160.0);
        let cngn_bal = to_u256_6dp(24.0 / MID_RATE);

        let balanced_policy = CorridorRuntimePolicy {
            paused: false,
            pause_buy: false,
            pause_sell: false,
            buy_offset_bps: Some(4),
            sell_offset_bps: Some(9),
            gamma_bps: Some(8),
            usdt_share_weight: Some(0.15),
            ..Default::default()
        };
        assert_eq!(
            apply_corridor_policy_and_skew(
                Some(&balanced_policy),
                Spread::Bps(3),
                true,
                usdt_bal,
                6,
                cngn_bal,
                6,
                MID_RATE,
                6,
            ),
            Ok(Spread::Bps(4))
        );
        assert_eq!(
            apply_corridor_policy_and_skew(
                Some(&balanced_policy),
                Spread::Bps(2),
                false,
                usdt_bal,
                6,
                cngn_bal,
                6,
                MID_RATE,
                6,
            ),
            Ok(Spread::Bps(9))
        );

        let sell_paused = CorridorRuntimePolicy {
            pause_sell: true,
            ..balanced_policy.clone()
        };
        assert_eq!(
            apply_corridor_policy_and_skew(
                Some(&sell_paused),
                Spread::Bps(2),
                false,
                usdt_bal,
                6,
                cngn_bal,
                6,
                MID_RATE,
                6,
            ),
            Err(RejectReason::Busy)
        );
        assert_eq!(
            apply_corridor_policy_and_skew(
                Some(&sell_paused),
                Spread::Bps(3),
                true,
                usdt_bal,
                6,
                cngn_bal,
                6,
                MID_RATE,
                6,
            ),
            Ok(Spread::Bps(4))
        );
    }

    #[test]
    fn test_ewma_vol_horizon_markout_and_twap_dex_bridge() {
        let usdt_bal = to_u256_6dp(160.0);
        let cngn_bal = to_u256_6dp(24.0 / MID_RATE);

        // Weekend 72h horizon with 16 bps EWMA vol and -6 bps toxic markout widens spread above base
        let stressed_policy = CorridorRuntimePolicy {
            buy_offset_bps: Some(3),
            sell_offset_bps: Some(3),
            gamma_bps: Some(6),
            usdt_share_weight: Some(0.15),
            ewma_vol_bps: Some(16.0),
            session_horizon_hours: Some(72.0),
            markout_toxicity_bps: Some(-6.0),
            lean_floor_bps: Some(2.0),
            ..Default::default()
        };
        let res = apply_corridor_policy_and_skew(
            Some(&stressed_policy),
            Spread::Bps(3),
            false,
            usdt_bal,
            6,
            cngn_bal,
            6,
            MID_RATE,
            6,
        )
        .unwrap();
        let Spread::Bps(bps) = res else { panic!("expected Bps") };
        assert!(bps >= 20, "expected EWMA vol*sqrt(tau) + markout widening >= 20 bps, got {bps}");

        // Verify Twap + DEX mid bridge on cNGN
        let cngn_addr: Address = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f".parse().unwrap();
        let m1 = observe_rfq_twap_mid(cngn_addr, 0.000720, 1_000);
        assert!((m1 - 0.000720).abs() < 1e-9);
        let eff = effective_mid_for_corridor(cngn_addr, 0.000720, Some(0.000725), false);
        assert_eq!(eff, 0.000725);
    }
}
