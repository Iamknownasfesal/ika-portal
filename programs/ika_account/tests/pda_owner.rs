//! PDA owners (Squads vaults, programs) via the test CPI program.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{InstructionData, ToAccountMetas};
use common::*;
use ika_account::error::IkaError;
use ika_account::state::*;
use ika_account::CreateAccountArgs;
use solana_signer::Signer;

fn vault() -> Pubkey {
    Pubkey::find_program_address(&[test_cpi_owner::VAULT_SEED], &cpi_owner_id()).0
}

/// Wrap `inner` so the vault PDA signs it via the test program.
fn via_vault(inner: Instruction) -> Instruction {
    let v = vault();
    let mut metas = test_cpi_owner::accounts::Execute { vault: v, target_program: inner.program_id }.to_account_metas(None);
    for m in inner.accounts {
        // The vault can't sign the outer transaction; the program signs for it.
        let is_signer = m.is_signer && m.pubkey != v;
        metas.push(AccountMeta { pubkey: m.pubkey, is_signer, is_writable: m.is_writable });
    }
    Instruction::new_with_bytes(cpi_owner_id(), &test_cpi_owner::instruction::Execute { data: inner.data }.data(), metas)
}

fn args(share: UserShare) -> CreateAccountArgs {
    CreateAccountArgs {
        index: 0,
        mode: Mode::Enforced,
        user_share: share,
        ika_user: Pubkey::new_unique(),
        policy: default_policy(),
        recovery: None,
    }
}

#[test]
fn pda_owner_with_encrypted_share_is_rejected() {
    let mut env = Env::new();
    let v = vault();
    env.svm.airdrop(&v, 10_000_000_000).unwrap();
    let mut inner = env.create_account_ix(&v, args(UserShare::Encrypted));
    inner.accounts[2].pubkey = v; // vault pays too
    let payer = env.payer.insecure_clone();
    env.expect_err(&[via_vault(inner)], &[&payer], err_code(IkaError::PdaOwnerRequiresPublicShare));

    // A keypair owner may use an encrypted share.
    let owner = solana_keypair::Keypair::new();
    let ix = env.create_account_ix(&owner.pubkey(), args(UserShare::Encrypted));
    env.send_ok(&[ix], &[&owner]);
}

#[test]
fn pda_owner_full_flow() {
    let mut env = Env::new();
    let v = vault();
    env.svm.airdrop(&v, 10_000_000_000).unwrap();
    let payer = env.payer.insecure_clone();

    // create_account signed by the vault
    let mut inner = env.create_account_ix(&v, args(UserShare::Public));
    inner.accounts[2].pubkey = v;
    env.send_ok(&[via_vault(inner)], &[&payer]);
    let account = account_pda(&v, 0);

    // dWallet created for the vault; the vault transfers ownership and registers it.
    let key = Key::random();
    let dw = env.create_dwallet(&key, &v);
    let t_ix = Env::transfer_ownership_ix(&v, &dw, &cpi_authority());
    let r_ix = Env::register_ix(&v, &account, &dw, DWalletRole::Both, key.y);
    env.send_ok(&[via_vault(t_ix), via_vault(r_ix)], &[&payer]);

    // Propose through the vault; the intent PDA appears; anyone approves.
    let (mut p_ix, intent) = env.propose_ix(&v, &account, evm_send(Chain::Ethereum, NATIVE_ASSET, [7; 20], 1, direct(0)));
    let payer_idx = p_ix.accounts.iter().position(|m| m.pubkey == env.payer.pubkey()).unwrap();
    p_ix.accounts[payer_idx].pubkey = v;
    env.send_ok(&[via_vault(p_ix)], &[&payer]);
    env.approve(&account, &intent);
    let it: Intent = env.fetch(&intent);
    assert_eq!(it.status, IntentStatus::Approved);

    // The same instruction without the vault's signature fails.
    let (ix, _) = env.propose_ix(&v, &account, evm_send(Chain::Ethereum, NATIVE_ASSET, [7; 20], 1, direct(1)));
    let mut unsigned = ix.clone();
    for m in unsigned.accounts.iter_mut() {
        if m.pubkey == v {
            m.is_signer = false;
        }
    }
    assert!(env.send(&[unsigned], &[&payer]).is_err());
}
