// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Textile, Inc. / Skew Project
//! Adaptive Inventory-Skew Pricing for Textile FX RFQ Corridors.
//!
//! Hard constraint: Engineered to run safely under a < $5.00 total capital budget.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use alloy_primitives::{Address, U256};
use crate::pricing::quote::Spread;
use crate::rfq::wire::RejectReason;

/// Hard safety rails
pub const MIN_SPREAD_BPS: u32 = 6;              // Never quote below 6 bps (protocol fee + margin guard)
pub const MAX_SPREAD_BPS: u32 = 150;            // Never quote wider than 150 bps (unless base_bps > 150)
pub const EXTREME_IMBALANCE_THRESHOLD: f64 = 0.85; // |s| >= 0.85 triggers one-sided quoting
pub const MIN_PORTFOLIO_VALUE_USD: f64 = 0.05;  // Under $0.05 total value, fail closed

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
        eprintln!("[skew] Extreme skew s={:.3} >= +0.85 (coll=${:.2}): Suppressing SELL quote", skew, cngn_val);
        return Err(RejectReason::Inventory);
    }
    if skew <= -EXTREME_IMBALANCE_THRESHOLD && bid && usdt_val < 1.00 {
        eprintln!("[skew] Extreme skew s={:.3} <= -0.85 (usdt=${:.2}): Suppressing BUY quote", skew, usdt_val);
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

            // 4. Clamping at min (6 bps)
            TestCase {
                name: "Aggressive skew clamps at MIN_SPREAD_BPS (6 bps)",
                usdt_usd: 3.80,
                cngn_usd: 0.80,
                bid: true,
                base_bps: 20,
                gamma_bps: 50,
                expected_bps: Ok(6),
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
                expected_bps: Ok(6),
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
}
