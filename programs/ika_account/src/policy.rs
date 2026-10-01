use anchor_lang::prelude::*;

use crate::error::IkaError;
use crate::state::*;

pub fn validate_address(chain: Chain, addr: &[u8]) -> Result<()> {
    if chain.is_evm() {
        require!(addr.len() == 20, IkaError::InvalidAddress);
    } else {
        require!(!addr.is_empty() && addr.len() <= MAX_ADDR, IkaError::InvalidAddress);
    }
    Ok(())
}

pub fn validate_policy(p: &Policy) -> Result<()> {
    require!(p.limits.len() <= MAX_LIMITS, IkaError::InvalidPolicy);
    require!(p.swap_limits.len() <= MAX_LIMITS, IkaError::InvalidPolicy);
    require!(p.allowlist.len() <= MAX_ALLOWLIST, IkaError::InvalidPolicy);
    require!(p.delay_thresholds.len() <= MAX_THRESHOLDS, IkaError::InvalidPolicy);
    for limits in [&p.limits, &p.swap_limits] {
        for (i, l) in limits.iter().enumerate() {
            require!(l.window_s > 0, IkaError::InvalidPolicy);
            require!(l.chain.is_evm() || l.asset == NATIVE_ASSET, IkaError::InvalidPolicy);
            // One entry per (chain, asset) keeps accounting unambiguous.
            require!(
                !limits[..i].iter().any(|o| o.chain == l.chain && o.asset == l.asset),
                IkaError::InvalidPolicy
            );
        }
    }
    for a in &p.allowlist {
        validate_address(a.chain, &a.address).map_err(|_| error!(IkaError::InvalidPolicy))?;
    }
    Ok(())
}

fn find_limit(limits: &[Limit], chain: Chain, asset: &[u8; 20]) -> Option<usize> {
    limits.iter().position(|l| l.chain == chain && l.asset == *asset)
}

/// Returns the charge to apply, or the rejection. Does not mutate.
fn check_window(
    limits: &[Limit],
    spend: &[SpendWindow],
    chain: Chain,
    asset: &[u8; 20],
    amount: u64,
    now: i64,
    err: IkaError,
) -> Result<Charge> {
    let Some(i) = find_limit(limits, chain, asset) else {
        return Ok(Charge { index: NO_CHARGE, ..Default::default() });
    };
    let l = &limits[i];
    let w = spend.get(i).copied().unwrap_or_default();
    let expired = now >= w.window_start.saturating_add(l.window_s as i64);
    let (start, used) = if expired { (now, 0) } else { (w.window_start, w.used) };
    let total = used.checked_add(amount).ok_or(error!(IkaError::Overflow))?;
    if total > l.max_per_window {
        return Err(error!(err));
    }
    Ok(Charge { index: i as u8, window_start: start, amount })
}

fn apply_charge(limits: &[Limit], spend: &mut Vec<SpendWindow>, c: &Charge) {
    if c.index == NO_CHARGE {
        return;
    }
    let i = c.index as usize;
    if spend.len() < limits.len() {
        spend.resize(limits.len(), SpendWindow::default());
    }
    let w = &mut spend[i];
    if w.window_start != c.window_start {
        *w = SpendWindow { window_start: c.window_start, used: 0 };
    }
    w.used = w.used.saturating_add(c.amount);
}

pub fn release_charge(spend: &mut [SpendWindow], c: &Charge) {
    if c.index == NO_CHARGE {
        return;
    }
    if let Some(w) = spend.get_mut(c.index as usize) {
        // Only release usage that still belongs to the current window.
        if w.window_start == c.window_start {
            w.used = w.used.saturating_sub(c.amount);
        }
    }
}

pub struct Evaluation {
    pub executable_at: i64,
    pub limit_charge: Charge,
    pub swap_charge: Charge,
}

/// Section 7 policy evaluation. On success, spend-window usage is recorded.
pub fn evaluate(acct: &mut IkaAccount, p: &IntentParams, now: i64) -> Result<Evaluation> {
    let none = Charge { index: NO_CHARGE, ..Default::default() };
    if matches!(p.kind, IntentKind::EvmSetup | IntentKind::EvmCancelRecovery) {
        return Ok(Evaluation { executable_at: now, limit_charge: none, swap_charge: none });
    }
    let policy = &acct.policy;

    if p.kind == IntentKind::Swap {
        require!(policy.swaps_enabled, IkaError::SwapsDisabled);
    }
    // Swap deposits go to provider addresses and are exempt from the allowlist.
    if p.kind == IntentKind::Send && policy.allowlist_enabled {
        let allowed = policy
            .allowlist
            .iter()
            .any(|a| a.chain == p.chain && a.address.as_slice() == p.to.as_slice());
        require!(allowed, IkaError::RecipientNotAllowed);
    }

    // Fee caps.
    match (&p.evm, &p.btc) {
        (Some(EvmParams::Direct { gas_limit, max_fee_per_gas, .. }), _) => {
            let max_fee = (*gas_limit as u128) * (*max_fee_per_gas as u128);
            require!(max_fee <= policy.max_evm_fee_wei as u128, IkaError::FeeTooHigh);
        }
        (_, Some(btc)) => {
            let fee = crate::digests::btc_effective_fee(btc, p.amount)?;
            require!(fee <= policy.max_btc_fee_sats, IkaError::FeeTooHigh);
        }
        _ => {}
    }

    let limit_charge = check_window(&policy.limits, &acct.spend, p.chain, &p.asset, p.amount, now, IkaError::LimitExceeded)?;
    let swap_charge = if p.kind == IntentKind::Swap {
        check_window(&policy.swap_limits, &acct.swap_spend, p.chain, &p.asset, p.amount, now, IkaError::SwapLimitExceeded)?
    } else {
        none
    };

    let delayed = policy
        .delay_thresholds
        .iter()
        .any(|t| t.chain == p.chain && t.asset == p.asset && p.amount >= t.amount);
    let executable_at = if delayed { now.saturating_add(policy.delay_s as i64) } else { now };

    let limits = acct.policy.limits.clone();
    let swap_limits = acct.policy.swap_limits.clone();
    apply_charge(&limits, &mut acct.spend, &limit_charge);
    apply_charge(&swap_limits, &mut acct.swap_spend, &swap_charge);

    Ok(Evaluation { executable_at, limit_charge, swap_charge })
}

/// Carry spend usage across a policy change for limits that keep the same
/// (chain, asset, window); new or changed limits start fresh.
pub fn remap_spend(old: &[Limit], old_spend: &[SpendWindow], new: &[Limit]) -> Vec<SpendWindow> {
    new.iter()
        .map(|n| {
            old.iter()
                .position(|o| o.chain == n.chain && o.asset == n.asset && o.window_s == n.window_s)
                .and_then(|i| old_spend.get(i).copied())
                .unwrap_or_default()
        })
        .collect()
}
