//! Intent → preimages. The only place that decides what gets signed.

use anchor_lang::prelude::*;

use crate::digest::{self, BtcOutpoint, BtcOutput, Preimage, ScriptCode};
use crate::error::IkaError;
use crate::state::*;

pub struct Signable {
    pub preimage: Preimage,
    pub scheme: u16,
}

impl Signable {
    pub fn message_digest(&self) -> [u8; 32] {
        digest::keccak(&[self.preimage.as_slice()])
    }

    pub fn final_digest(&self) -> [u8; 32] {
        match self.scheme {
            SCHEME_ECDSA_DOUBLE_SHA256 => digest::sha256d(self.preimage.as_slice()),
            _ => self.message_digest(),
        }
    }
}

fn d<T>(r: digest::DResult<T>) -> Result<T> {
    r.map_err(|e| error!(IkaError::from(e)))
}

fn evm_to(p: &IntentParams) -> Result<[u8; 20]> {
    p.to.as_slice().try_into().map_err(|_| error!(IkaError::InvalidAddress))
}

fn deadline_u64(deadline: i64, now: i64) -> Result<u64> {
    require!(deadline >= now, IkaError::DeadlineExpired);
    Ok(deadline as u64)
}

/// Effective BTC fee after the change/dust decision; also validates coverage.
pub fn btc_effective_fee(btc: &BtcParams, amount: u64) -> Result<u64> {
    let (_, fee) = btc_change(btc, amount)?;
    Ok(fee)
}

/// Returns (change_value or 0 when absorbed into the fee, effective fee).
fn btc_change(btc: &BtcParams, amount: u64) -> Result<(u64, u64)> {
    let mut total: u64 = 0;
    for i in &btc.inputs {
        total = total.checked_add(i.value).ok_or(error!(IkaError::Overflow))?;
    }
    let spend = amount.checked_add(btc.fee).ok_or(error!(IkaError::Overflow))?;
    require!(total >= spend, IkaError::InsufficientInputs);
    let change = total - spend;
    if change >= digest::BTC_DUST {
        Ok((change, btc.fee))
    } else {
        Ok((0, total - amount))
    }
}

/// Validate intent shape at propose time (no hashing).
pub fn validate_params(acct: &IkaAccount, cfg: &Config, p: &IntentParams, now: i64) -> Result<()> {
    require!(acct.dwallet_for(p.chain).is_some(), IkaError::AccountNotReady);
    match p.chain {
        Chain::Bitcoin => {
            require!(acct.has_btc(), IkaError::AccountNotReady);
            require!(matches!(p.kind, IntentKind::Send | IntentKind::Swap), IkaError::InvalidIntentParams);
            require!(p.asset == NATIVE_ASSET, IkaError::UnknownAsset);
            require!(p.evm.is_none(), IkaError::InvalidIntentParams);
            let btc = p.btc.as_ref().ok_or(error!(IkaError::InvalidIntentParams))?;
            require!(
                btc.inputs.len() <= cfg.max_btc_inputs as usize && btc.inputs.len() <= digest::MAX_BTC_INPUTS,
                IkaError::TooManyInputs
            );
            require!(!btc.inputs.is_empty(), IkaError::InvalidIntentParams);
            crate::policy::validate_address(p.chain, &p.to)?;
            require!(p.amount >= digest::BTC_DUST, IkaError::InvalidIntentParams);
            btc_change(btc, p.amount)?;
        }
        Chain::Ethereum | Chain::Base => {
            require!(acct.has_evm(), IkaError::AccountNotReady);
            let chain_cfg = cfg.evm_chain(p.chain).ok_or(error!(IkaError::UnknownChain))?;
            require!(p.btc.is_none(), IkaError::InvalidIntentParams);
            let evm = p.evm.as_ref().ok_or(error!(IkaError::InvalidIntentParams))?;
            match (p.kind, evm) {
                (IntentKind::Send | IntentKind::Swap, EvmParams::Direct { .. }) => {}
                (IntentKind::Send | IntentKind::Swap, EvmParams::Delegated { deadline }) => {
                    deadline_u64(*deadline, now)?;
                    let delegated = acct
                        .evm_nonces
                        .iter()
                        .any(|n| n.chain_id == chain_cfg.chain_id && n.delegated);
                    require!(delegated, IkaError::EvmNotDelegated);
                }
                (IntentKind::EvmSetup, EvmParams::Setup { .. }) => {
                    require!(chain_cfg.implementation != [0u8; 20], IkaError::UnknownChain);
                }
                (IntentKind::EvmCancelRecovery, EvmParams::CancelRecovery { deadline }) => {
                    require!(acct.mode == Mode::EnforcedRecovery, IkaError::RecoveryNotConfigured);
                    deadline_u64(*deadline, now)?;
                }
                _ => return err!(IkaError::InvalidIntentParams),
            }
            if matches!(p.kind, IntentKind::Send | IntentKind::Swap) {
                require!(cfg.asset_known(p.chain, &p.asset), IkaError::UnknownAsset);
                crate::policy::validate_address(p.chain, &p.to)?;
                require!(p.amount > 0, IkaError::InvalidIntentParams);
            }
        }
    }
    Ok(())
}

/// Build every preimage the intent needs signed, in order.
/// `evm_nonce` is the `IkaAccount` nonce bound into Execute / CancelRecovery.
pub fn build(acct: &IkaAccount, cfg: &Config, p: &IntentParams, evm_nonce: u64, now: i64) -> Result<Vec<Signable>> {
    let mut out = Vec::with_capacity(MAX_APPROVALS);
    match p.chain {
        Chain::Bitcoin => {
            let btc = p.btc.as_ref().ok_or(error!(IkaError::InvalidIntentParams))?;
            let (change, _) = btc_change(btc, p.amount)?;

            let ws;
            let (own_script, script_code) = if acct.mode == Mode::EnforcedRecovery {
                let rec = acct.recovery_pubkey.ok_or(error!(IkaError::RecoveryNotConfigured))?;
                ws = d(digest::recovery_witness_script(&acct.btc_pubkey, acct.csv_blocks, &rec))?;
                (digest::p2wsh_script(ws.as_slice()), ScriptCode::P2wsh(ws.as_slice()))
            } else {
                (digest::p2wpkh_script(&acct.btc_pkh), ScriptCode::P2wpkh(&acct.btc_pkh))
            };

            let mut outputs = vec![BtcOutput { value: p.amount, script: &p.to }];
            if change > 0 {
                outputs.push(BtcOutput { value: change, script: own_script.as_slice() });
            }
            let inputs: Vec<BtcOutpoint> = btc
                .inputs
                .iter()
                .map(|i| BtcOutpoint { txid: i.txid, vout: i.vout, value: i.value })
                .collect();
            let ctx = d(digest::btc_context(&inputs, &outputs))?;
            for input in &inputs {
                out.push(Signable {
                    preimage: d(digest::bip143_preimage(&ctx, input, &script_code))?,
                    scheme: SCHEME_ECDSA_DOUBLE_SHA256,
                });
            }
        }
        Chain::Ethereum | Chain::Base => {
            let chain_cfg = cfg.evm_chain(p.chain).ok_or(error!(IkaError::UnknownChain))?;
            let chain_id = chain_cfg.chain_id;
            let evm = p.evm.as_ref().ok_or(error!(IkaError::InvalidIntentParams))?;
            let keccak = |preimage| Signable { preimage, scheme: SCHEME_ECDSA_KECCAK256 };
            match *evm {
                EvmParams::Direct { nonce, gas_limit, max_fee_per_gas, max_priority_fee_per_gas } => {
                    let call = d(digest::evm_call(&p.asset, &evm_to(p)?, p.amount))?;
                    let f = digest::Eip1559Fields { chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit };
                    out.push(keccak(d(digest::eip1559_preimage(&f, &call))?));
                }
                EvmParams::Delegated { deadline } => {
                    let call = d(digest::evm_call(&p.asset, &evm_to(p)?, p.amount))?;
                    let dl = deadline_u64(deadline, now)?;
                    out.push(keccak(d(digest::execute_preimage(chain_id, &acct.evm_address, &call, evm_nonce, dl))?));
                }
                EvmParams::Setup { eoa_nonce } => {
                    // Only ever authorize the configured implementation.
                    out.push(keccak(d(digest::authorization_preimage(chain_id, &chain_cfg.implementation, eoa_nonce))?));
                    let (rk, delay) = if acct.mode == Mode::EnforcedRecovery {
                        (acct.recovery_evm_address, acct.recovery_delay_s as u64)
                    } else {
                        ([0u8; 20], 0)
                    };
                    out.push(keccak(d(digest::init_preimage(chain_id, &acct.evm_address, &rk, delay))?));
                }
                EvmParams::CancelRecovery { deadline } => {
                    let dl = deadline_u64(deadline, now)?;
                    out.push(keccak(d(digest::cancel_recovery_preimage(chain_id, &acct.evm_address, evm_nonce, dl))?));
                }
            }
        }
    }
    Ok(out)
}
