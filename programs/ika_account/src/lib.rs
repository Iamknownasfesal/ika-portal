//! `ika_account`: Solana-controlled Bitcoin and EVM accounts backed by Ika dWallets.
//!
//! The owner (any Solana pubkey, including PDAs such as Squads vaults) proposes
//! structured intents; the program evaluates policy, computes every digest itself
//! from intent fields, and CPI-approves them on the Ika dWallet program. Clients
//! never submit raw digests.

use anchor_lang::prelude::*;

pub mod digest;
pub mod digests;
pub mod dwallet;
pub mod error;
pub mod events;
pub mod instructions;
pub mod policy;
pub mod state;

pub use instructions::*;
pub use state::*;

declare_id!("Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje");

#[program]
pub mod ika_account {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
        instructions::handle_initialize_config(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
        instructions::handle_update_config(ctx, args)
    }

    pub fn create_account(ctx: Context<CreateAccount>, args: CreateAccountArgs) -> Result<()> {
        instructions::handle_create_account(ctx, args)
    }

    pub fn register_dwallet(ctx: Context<RegisterDWallet>, role: DWalletRole, evm_pubkey_y: [u8; 32]) -> Result<()> {
        instructions::handle_register_dwallet(ctx, role, evm_pubkey_y)
    }

    pub fn propose_intent(ctx: Context<ProposeIntent>, params: IntentParams) -> Result<()> {
        instructions::handle_propose_intent(ctx, params)
    }

    pub fn cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
        instructions::handle_cancel_intent(ctx)
    }

    pub fn approve_intent<'info>(ctx: Context<'info, ApproveIntent<'info>>) -> Result<()> {
        instructions::handle_approve_intent(ctx)
    }

    pub fn preview_digests(ctx: Context<PreviewDigests>, params: IntentParams, evm_nonce: u64) -> Result<Vec<DigestPreview>> {
        instructions::handle_preview_digests(ctx, params, evm_nonce)
    }

    pub fn propose_policy(ctx: Context<OwnerOnly>, next: Policy) -> Result<()> {
        instructions::handle_propose_policy(ctx, next)
    }

    pub fn apply_policy(ctx: Context<Permissionless>) -> Result<()> {
        instructions::handle_apply_policy(ctx)
    }

    pub fn cancel_policy(ctx: Context<OwnerOnly>) -> Result<()> {
        instructions::handle_cancel_policy(ctx)
    }

    pub fn set_evm_nonce(ctx: Context<OwnerOnly>, chain_id: u64, nonce: u64) -> Result<()> {
        instructions::handle_set_evm_nonce(ctx, chain_id, nonce)
    }
}
