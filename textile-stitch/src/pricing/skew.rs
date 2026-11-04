// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Textile, Inc. / Skew Project
//! Adaptive Inventory-Skew Pricing for Textile FX RFQ Corridors.
//!
//! Hard constraint: Engineered to run safely under a < $5.00 total capital budget.

use std::collections::HashMap;
use std::fs;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime};

use alloy_primitives::{Address, U256};
use serde::Deserialize;
use crate::pricing::quote::Spread;
use crate::rfq::wire::RejectReason;

/// Hard safety rails
pub const MIN_SPREAD_BPS: u32 = 1;              // Allow tightening down to 1 bps to win top-of-book RFQ flow
pub const MAX_SPREAD_BPS: u32 = 150;            // Never quote wider than 150 bps (unless base_bps > 150)
pub const EXTREME_IMBALANCE_THRESHOLD: f64 = 0.85; // |s| >= 0.85 triggers one-sided quoting
pub const MIN_PORTFOLIO_VALUE_USD: f64 = 0.05;  // Under $0.05 total value, fail closed
const POLICY_CACHE_TTL: Duration = Duration::from_secs(2);

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

fn dex_cache() -> &'static RwLock<HashMap<Address, f64>> {
    DEX_MID_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
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

/// Anti-Arb Dual-Oracle Price Guard:
/// - When buying collateral (`bid = true`, Maker pays USDT): anchor to `min(oracle_mid, dex_mid)`
///   so our bid is never above the external DEX price.
/// - When selling collateral (`bid = false`, Maker sells cNGN): anchor to `max(oracle_mid, dex_mid)`
///   so our ask is never below the external DEX price (preventing cross-venue arbitrage drain).
pub fn effective_mid_for_side(oracle_mid: f64, dex_mid: Option<f64>, bid: bool) -> f64 {
    match dex_mid {
        Some(d) if d.is_finite() && d > 0.0 => {
            if bid {
                oracle_mid.min(d)
            } else {
                oracle_mid.max(d)
            }
        }
        _ => oracle_mid,
    }
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
///
/// Returns `(skew, total_value_usd, usdt_val_usd, cngn_val_usd)`
/// - `usdt_balance`: atomic balance of USDT (6 decimals)
/// - `cngn_balance`: atomic balance of cNGN (6 decimals)
/// - `mid`: debt per collateral (USDT per 1 cNGN, e.g. ~0.000728)
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

    // Guard: Insufficient inventory to quote
    if total_val < MIN_PORTFOLIO_VALUE_USD {
        return Err(RejectReason::Inventory);
    }

    // Circuit Breaker: One-sided quoting near extreme imbalance when depleted leg < $1.00
    if skew >= EXTREME_IMBALANCE_THRESHOLD && !bid && cngn_val < 1.00 {
        return Err(RejectReason::Inventory);
    }
    if skew <= -EXTREME_IMBALANCE_THRESHOLD && bid && usdt_val < 1.00 {
        return Err(RejectReason::Inventory);
    }

    // Extract base BPS from Spread enum
    let base_bps = match base_spread {
        Spread::Bps(b) => b,
        Spread::Abs(_) => {
            // If absolute spread configured, preserve as-is
            return Ok(base_spread);
        }
    };

    // Dynamic offset adjustment:
    // If s > 0 (excess USDT):
    //   - BUY side (bid=true)  tightens: base - (gamma * s)
    //   - SELL side (bid=false) widens:  base + (gamma * s)
    // If s < 0 (excess cNGN):
    //   - BUY side (bid=true)  widens:   base + (gamma * |s|)
    //   - SELL side (bid=false) tightens: base - (gamma * |s|)
    let delta = (gamma_bps as f64) * skew;
    let raw_bps = if bid {
        (base_bps as f64) - delta
    } else {
        (base_bps as f64) + delta
    };

    // Clamp between safe bounds [MIN_SPREAD_BPS, MAX_SPREAD_BPS.max(base_bps)]
    let max_bps = MAX_SPREAD_BPS.max(base_bps);
    let dynamic_bps = (raw_bps.round() as i64)
        .clamp(MIN_SPREAD_BPS as i64, max_bps as i64) as u32;

    // Structured observability log on quote decision
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
/// `gamma_bps`, and multi-corridor `usdt_share_weight`) on top of inventory-skew pricing without restarting Stitch.
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

    let delta = (gamma_bps as f64) * skew;
    let raw_bps = if bid {
        (base_bps as f64) - delta
    } else {
        (base_bps as f64) + delta
    };
    let max_bps = MAX_SPREAD_BPS.max(base_bps);
    let dynamic_bps = (raw_bps.round() as i64).clamp(MIN_SPREAD_BPS as i64, max_bps as i64) as u32;

    eprintln!(
        "[skew] side={} s={:+.3} base={}bps -> dynamic={}bps (usdt=${:.2}*{:.2}=${:.2}, coll=${:.2})",
        if bid { "BUY " } else { "SELL" },
        skew,
        base_bps,
        dynamic_bps,
        raw_usdt_val,
        weight,
        alloc_usdt_val,
        coll_val
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
            // 1. Balanced inventory (s ≈ 0): $2.00 USDT, $2.00 cNGN
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

            // 2. Moderate positive skew (s = +0.50): $3.00 USDT, $1.00 cNGN
            TestCase {
                name: "Excess USDT tightens BUY to attract cNGN",
                usdt_usd: 3.00,
                cngn_usd: 1.00,
                bid: true,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(10), // 25 - (30 * 0.5) = 10
            },
            TestCase {
                name: "Excess USDT widens SELL to protect cNGN",
                usdt_usd: 3.00,
                cngn_usd: 1.00,
                bid: false,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(40), // 25 + (30 * 0.5) = 40
            },

            // 3. Moderate negative skew (s = -0.50): $1.00 USDT, $3.00 cNGN
            TestCase {
                name: "Excess cNGN widens BUY to discourage more cNGN",
                usdt_usd: 1.00,
                cngn_usd: 3.00,
                bid: true,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(40), // 25 - (30 * -0.5) = 40
            },
            TestCase {
                name: "Excess cNGN tightens SELL to offload cNGN",
                usdt_usd: 1.00,
                cngn_usd: 3.00,
                bid: false,
                base_bps: 25,
                gamma_bps: 30,
                expected_bps: Ok(10), // 25 + (30 * -0.5) = 10
            },

            // 4. Clamping at min (1 bps)
            TestCase {
                name: "Aggressive skew clamps at MIN_SPREAD_BPS (1 bps)",
                usdt_usd: 3.80,
                cngn_usd: 0.80,
                bid: true,
                base_bps: 20,
                gamma_bps: 50,
                expected_bps: Ok(1),
            },

            // 5. Clamping at max (150 bps)
            TestCase {
                name: "Wide skew clamps at MAX_SPREAD_BPS (150 bps)",
                usdt_usd: 3.80,
                cngn_usd: 0.80,
                bid: false,
                base_bps: 120,
                gamma_bps: 50,
                expected_bps: Ok(150),
            },

            // 6. Extreme positive skew (s >= +0.85): $3.85 USDT, $0.15 cNGN
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

            // 7. Sub-$0.05 inventory fail-closed guard
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

        // When selling cNGN (bid=false), anchor to the higher mid (Uniswap) so we never sell cheap
        let ask_mid = effective_mid_for_side(textile_mid, Some(uniswap_mid), false);
        assert_eq!(ask_mid, uniswap_mid);

        // When buying cNGN (bid=true), anchor to the lower mid (Textile) so we never overpay
        let bid_mid = effective_mid_for_side(textile_mid, Some(uniswap_mid), true);
        assert_eq!(bid_mid, textile_mid);
    }

    #[test]
    fn test_hot_reload_policy_pause_and_normalized_multicorridor_skew() {
        // $160 total wallet USDT shared across 4 corridors with weight=0.15 ($24 allocated) vs $24 cNGN -> s = 0.0!
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

        // Per-side pause_sell rejects SELL with Busy while keeping BUY live
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
}
