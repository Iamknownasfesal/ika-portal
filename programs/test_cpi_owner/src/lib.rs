//! Test-only stand-in for a Squads vault: a PDA that signs arbitrary
//! instructions via `invoke_signed`, so tests can exercise PDA owners.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};

declare_id!("C86ZbaTdqH5dHZ5sBRrNrpMUYJxjubk8Adt4fNT9RnLA");

pub const VAULT_SEED: &[u8] = b"vault";

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: the vault PDA (system-owned, holds SOL, signs via seeds).
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the program to call.
    pub target_program: UncheckedAccount<'info>,
}

#[program]
pub mod test_cpi_owner {
    use super::*;

    /// Call `target_program` with `data`; remaining accounts become the
    /// instruction's accounts, with the vault marked as a signer.
    pub fn execute<'info>(ctx: Context<'info, Execute<'info>>, data: Vec<u8>) -> Result<()> {
        let vault = ctx.accounts.vault.key();
        let metas = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                is_signer: a.is_signer || *a.key == vault,
                is_writable: a.is_writable,
            })
            .collect();
        let ix = Instruction { program_id: ctx.accounts.target_program.key(), accounts: metas, data };
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.target_program.to_account_info());
        invoke_signed(&ix, &infos, &[&[VAULT_SEED, &[ctx.bumps.vault]]])?;
        Ok(())
    }
}
