//! `mock_dwallet`: a local stand-in for the Ika dWallet program.
//!
//! Implements the subset `ika_account` uses, with the same wire format as the
//! pre-alpha program (instruction discriminators, account order, PDA seeds and
//! account layouts), so `ika_account` switches between them by program id only:
//!
//! - `approve_message` (disc 8), CPI path, 7 accounts
//! - `transfer_ownership` (disc 24), signer path (2 accounts) and CPI path (3)
//!
//! Test-only helpers (not in Ika): `mock_init` (coordinator), `mock_create_dwallet`
//! (stands in for DKG + CommitDWallet) and `mock_commit_signature` (stands in for
//! the network's CommitSignature, disc 43).

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("6sewJoZnLJN1hMzaYLySG61VSLiPoFzbA8Cyd7KJkwv");

pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";
pub const COORDINATOR_SEED: &[u8] = b"dwallet_coordinator";

pub const DISC_COORDINATOR: u8 = 1;
pub const DISC_DWALLET: u8 = 2;
pub const DISC_MESSAGE_APPROVAL: u8 = 14;
pub const COORDINATOR_LEN: usize = 116;
pub const DWALLET_LEN: usize = 153;
pub const MESSAGE_APPROVAL_LEN: usize = 312;

#[error_code]
pub enum MockError {
    #[msg("Invalid accounts")]
    InvalidAccounts,
    #[msg("Caller program is not executable")]
    NotExecutable,
    #[msg("CPI authority mismatch")]
    BadCpiAuthority,
    #[msg("Signer is not the dWallet authority")]
    NotAuthority,
    #[msg("MessageApproval PDA mismatch")]
    BadMessageApproval,
    #[msg("MessageApproval already exists")]
    AlreadyApproved,
    #[msg("Invalid account data")]
    BadData,
}

#[derive(Accounts)]
pub struct Raw {}

#[derive(Accounts)]
pub struct MockInit<'info> {
    /// CHECK: created here with the Ika coordinator layout.
    #[account(mut, seeds = [COORDINATOR_SEED], bump)]
    pub coordinator: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MockCreateDWallet<'info> {
    /// CHECK: PDA verified in the handler.
    #[account(mut)]
    pub dwallet: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MockCommitSignature<'info> {
    /// CHECK: owner + discriminator checked in the handler.
    #[account(mut)]
    pub message_approval: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

fn dwallet_seeds_payload(curve: u16, pk: &[u8; 33]) -> [u8; 35] {
    let mut p = [0u8; 35];
    p[..2].copy_from_slice(&curve.to_le_bytes());
    p[2..].copy_from_slice(pk);
    p
}

fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    let lamports = Rent::get()?.minimum_balance(space);
    system_program::create_account(
        CpiContext::new_with_signer(
            system.key(),
            system_program::CreateAccount { from: payer.clone(), to: target.clone() },
            &[seeds],
        ),
        lamports,
        space as u64,
        &crate::ID,
    )
}

#[program]
pub mod mock_dwallet {
    use super::*;

    /// Ika `approve_message` (CPI path). Data: bump, message_digest,
    /// message_metadata_digest, user_pubkey, signature_scheme (u16 LE).
    #[instruction(discriminator = [8])]
    pub fn approve_message<'info>(
        ctx: Context<'info, Raw>,
        bump: u8,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
    ) -> Result<()> {
        let accs = ctx.remaining_accounts;
        require!(accs.len() >= 7, MockError::InvalidAccounts);
        let (coordinator, ma, dwallet, caller, cpi_auth, payer, system) =
            (&accs[0], &accs[1], &accs[2], &accs[3], &accs[4], &accs[5], &accs[6]);

        require_keys_eq!(*coordinator.owner, crate::ID, MockError::BadData);
        let epoch = {
            let d = coordinator.try_borrow_data()?;
            require!(d.len() >= COORDINATOR_LEN && d[0] == DISC_COORDINATOR, MockError::BadData);
            u64::from_le_bytes(d[34..42].try_into().unwrap())
        };

        require!(caller.executable, MockError::NotExecutable);
        let (expected_auth, _) = Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], caller.key);
        require_keys_eq!(*cpi_auth.key, expected_auth, MockError::BadCpiAuthority);
        require!(cpi_auth.is_signer, MockError::BadCpiAuthority);

        require_keys_eq!(*dwallet.owner, crate::ID, MockError::BadData);
        let (curve, pk) = {
            let d = dwallet.try_borrow_data()?;
            require!(d.len() >= DWALLET_LEN && d[0] == DISC_DWALLET, MockError::BadData);
            require!(&d[2..34] == cpi_auth.key.as_ref(), MockError::NotAuthority);
            require!(d[37] == 33, MockError::BadData);
            let mut pk = [0u8; 33];
            pk.copy_from_slice(&d[38..71]);
            (u16::from_le_bytes([d[34], d[35]]), pk)
        };

        let payload = dwallet_seeds_payload(curve, &pk);
        let scheme_le = signature_scheme.to_le_bytes();
        let bump_b = [bump];
        let with_meta = message_metadata_digest != [0u8; 32];
        let base: [&[u8]; 6] = [b"dwallet", &payload[..32], &payload[32..], b"message_approval", &scheme_le, &message_digest];
        let mut seeds: Vec<&[u8]> = base.to_vec();
        if with_meta {
            seeds.push(&message_metadata_digest);
        }
        seeds.push(&bump_b);
        let expected = Pubkey::create_program_address(&seeds, &crate::ID).map_err(|_| error!(MockError::BadMessageApproval))?;
        require_keys_eq!(*ma.key, expected, MockError::BadMessageApproval);
        require!(ma.data_is_empty() && ma.lamports() == 0, MockError::AlreadyApproved);

        create_pda(payer, ma, system, MESSAGE_APPROVAL_LEN, &seeds)?;
        let mut d = ma.try_borrow_mut_data()?;
        d[0] = DISC_MESSAGE_APPROVAL;
        d[1] = 1;
        d[2..34].copy_from_slice(dwallet.key.as_ref());
        d[34..66].copy_from_slice(&message_digest);
        d[66..98].copy_from_slice(&message_metadata_digest);
        d[98..130].copy_from_slice(cpi_auth.key.as_ref());
        d[130..162].copy_from_slice(&user_pubkey);
        d[162..164].copy_from_slice(&scheme_le);
        d[164..172].copy_from_slice(&epoch.to_le_bytes());
        d[172] = 0; // Pending
        d[303] = bump;
        Ok(())
    }

    /// Ika `transfer_ownership`. Signer path: [authority (s), dwallet (w)].
    /// CPI path: [caller_program, cpi_authority (s), dwallet (w)].
    #[instruction(discriminator = [24])]
    pub fn transfer_ownership<'info>(ctx: Context<'info, Raw>, new_authority: Pubkey) -> Result<()> {
        let accs = ctx.remaining_accounts;
        let (signer, dwallet) = match accs.len() {
            2 => (&accs[0], &accs[1]),
            n if n >= 3 => {
                let (caller, cpi_auth) = (&accs[0], &accs[1]);
                require!(caller.executable, MockError::NotExecutable);
                let (expected, _) = Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], caller.key);
                require_keys_eq!(*cpi_auth.key, expected, MockError::BadCpiAuthority);
                (cpi_auth, &accs[2])
            }
            _ => return err!(MockError::InvalidAccounts),
        };
        require!(signer.is_signer, MockError::NotAuthority);
        require_keys_eq!(*dwallet.owner, crate::ID, MockError::BadData);
        let mut d = dwallet.try_borrow_mut_data()?;
        require!(d.len() >= DWALLET_LEN && d[0] == DISC_DWALLET, MockError::BadData);
        require!(&d[2..34] == signer.key.as_ref(), MockError::NotAuthority);
        d[2..34].copy_from_slice(new_authority.as_ref());
        Ok(())
    }

    /// Test-only: create the coordinator PDA (epoch = 1).
    #[instruction(discriminator = [200])]
    pub fn mock_init(ctx: Context<MockInit>) -> Result<()> {
        let bump = ctx.bumps.coordinator;
        let seeds: &[&[u8]] = &[COORDINATOR_SEED, &[bump]];
        create_pda(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.coordinator.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            COORDINATOR_LEN,
            seeds,
        )?;
        let mut d = ctx.accounts.coordinator.try_borrow_mut_data()?;
        d[0] = DISC_COORDINATOR;
        d[1] = 1;
        d[2..34].copy_from_slice(ctx.accounts.payer.key.as_ref());
        d[34..42].copy_from_slice(&1u64.to_le_bytes());
        d[51] = bump;
        Ok(())
    }

    /// Test-only: stands in for DKG/import + CommitDWallet. Creates an Active
    /// secp256k1 dWallet whose authority is `authority`.
    #[instruction(discriminator = [201])]
    pub fn mock_create_dwallet(ctx: Context<MockCreateDWallet>, public_key: [u8; 33], authority: Pubkey, is_imported: bool) -> Result<()> {
        let payload = dwallet_seeds_payload(0, &public_key);
        let (expected, bump) = Pubkey::find_program_address(&[b"dwallet", &payload[..32], &payload[32..]], &crate::ID);
        require_keys_eq!(ctx.accounts.dwallet.key(), expected, MockError::BadData);
        let bump_b = [bump];
        let seeds: &[&[u8]] = &[b"dwallet", &payload[..32], &payload[32..], &bump_b];
        create_pda(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.dwallet.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            DWALLET_LEN,
            seeds,
        )?;
        let mut d = ctx.accounts.dwallet.try_borrow_mut_data()?;
        d[0] = DISC_DWALLET;
        d[1] = 1;
        d[2..34].copy_from_slice(authority.as_ref());
        d[34..36].copy_from_slice(&0u16.to_le_bytes());
        d[36] = 1; // Active
        d[37] = 33;
        d[38..71].copy_from_slice(&public_key);
        d[103..111].copy_from_slice(&1u64.to_le_bytes());
        d[143] = is_imported as u8;
        d[144] = bump;
        Ok(())
    }

    /// Test-only: stands in for the network's CommitSignature (disc 43).
    #[instruction(discriminator = [43])]
    pub fn mock_commit_signature(ctx: Context<MockCommitSignature>, signature: Vec<u8>) -> Result<()> {
        let ma = &ctx.accounts.message_approval;
        require_keys_eq!(*ma.owner, crate::ID, MockError::BadData);
        require!(signature.len() <= 128, MockError::BadData);
        let mut d = ma.try_borrow_mut_data()?;
        require!(d.len() >= MESSAGE_APPROVAL_LEN && d[0] == DISC_MESSAGE_APPROVAL, MockError::BadData);
        d[172] = 1; // Signed
        d[173..175].copy_from_slice(&(signature.len() as u16).to_le_bytes());
        d[175..175 + signature.len()].copy_from_slice(&signature);
        Ok(())
    }
}
