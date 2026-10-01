mod common;

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::*;
use ika_account::digest;
use ika_account::error::IkaError;
use ika_account::state::*;
use k256::ecdsa::{signature::hazmat::PrehashVerifier, RecoveryId, Signature, VerifyingKey};
use solana_signer::Signer;

const RECIPIENT: [u8; 20] = [0x42; 20];

fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

/// Cross-check with the Foundry test vector in contracts/evm/README.md.
#[test]
fn execute_digest_matches_foundry_vector() {
    let call = digest::evm_call(&NATIVE_ASSET, &[0x22; 20], 1_000_000_000_000_000_000).unwrap();
    let pre = digest::execute_preimage(31337, &[0x11; 20], &call, 0, 1_700_000_000).unwrap();
    assert_eq!(
        digest::keccak(&[pre.as_slice()]),
        hex32("1f00b6a1ffc9240c0b8595df34ee26502762a951ea2e6c257bb01f551c65249e")
    );
}

#[test]
fn point_check_random_keys() {
    for _ in 0..200 {
        let k = Key::random();
        assert!(digest::verify_uncompressed(&k.compressed, &k.y).is_ok());
        let mut y = k.y;
        y[31] ^= 2; // keep parity, break the point
        assert!(digest::verify_uncompressed(&k.compressed, &y).is_err());
    }
}

fn verify_signed(key: &Key, final_digest: &[u8; 32]) {
    let (sig, recid): (Signature, RecoveryId) = key.sk.sign_prehash_recoverable(final_digest).unwrap();
    key.sk.verifying_key().verify_prehash(final_digest, &sig).unwrap();
    let rec = VerifyingKey::recover_from_prehash(final_digest, &sig, recid).unwrap();
    assert_eq!(&rec, key.sk.verifying_key());
}

#[test]
fn approve_direct_evm_creates_message_approval() {
    let mut env = Env::new();
    let t = env.setup_account(Mode::Enforced, default_policy());
    let params = evm_send(Chain::Base, USDC_BASE, RECIPIENT, 1_234_567, direct(7));
    let i = env.propose(&t, params.clone());
    env.approve(&t.account, &i);

    let it: Intent = env.fetch(&i);
    assert_eq!(it.status, IntentStatus::Approved);
    assert_eq!(it.approvals.len(), 1);
    let ap = &it.approvals[0];
    assert_eq!(ap.scheme, SCHEME_ECDSA_KECCAK256);

    // Independently rebuild the EIP-1559 preimage.
    let call = digest::evm_call(&USDC_BASE, &RECIPIENT, 1_234_567).unwrap();
    assert_eq!(call.to, USDC_BASE);
    assert_eq!(call.value, 0);
    let pre = digest::eip1559_preimage(
        &digest::Eip1559Fields { chain_id: BASE_CHAIN_ID, nonce: 7, max_priority_fee_per_gas: 1_000_000_000, max_fee_per_gas: 2_000_000_000, gas_limit: 21_000 },
        &call,
    )
    .unwrap();
    assert_eq!(ap.message_digest, digest::keccak(&[pre.as_slice()]));
    assert_eq!(ap.final_digest, ap.message_digest);

    // MessageApproval layout (Ika pre-alpha): disc 14, dwallet, digest, approver, user, scheme, status.
    let ma = env.read_message_approval(&ap.message_approval);
    let a: IkaAccount = env.fetch(&t.account);
    assert_eq!(ma.len(), 312);
    assert_eq!(ma[0], 14);
    assert_eq!(&ma[2..34], a.dwallets[0].dwallet.as_ref());
    assert_eq!(&ma[34..66], &ap.message_digest);
    assert_eq!(&ma[66..98], &[0u8; 32]);
    assert_eq!(&ma[98..130], cpi_authority().as_ref());
    assert_eq!(&ma[130..162], t.owner.pubkey().as_ref());
    assert_eq!(u16::from_le_bytes([ma[162], ma[163]]), 0);
    assert_eq!(ma[172], 0);
    verify_signed(&t.key, &ap.final_digest);

    // Idempotency: the same digest can't be approved twice (duplicate intent).
    let i2 = env.propose(&t, params);
    let ix = env.approve_ix(&t.account, &i2);
    let payer = env.payer.insecure_clone();
    assert!(env.send(&[compute_budget_ix(1_400_000), ix], &[&payer]).is_err());
}

#[test]
fn wrong_message_approval_account_rejected() {
    let mut env = Env::new();
    let t = env.setup_account(Mode::Enforced, default_policy());
    let i = env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 5, direct(0)));
    let mut ix = env.approve_ix(&t.account, &i);
    let last = ix.accounts.len() - 1;
    ix.accounts[last].pubkey = anchor_lang::prelude::Pubkey::new_unique();
    let payer = env.payer.insecure_clone();
    env.expect_err(&[compute_budget_ix(1_400_000), ix], &[&payer], err_code(IkaError::InvalidMessageApproval));
}

#[test]
fn evm_setup_uses_config_implementation_only() {
    let mut env = Env::new();
    let t = env.setup_account(Mode::EnforcedRecovery, default_policy());
    let setup = IntentParams {
        kind: IntentKind::EvmSetup,
        chain: Chain::Ethereum,
        asset: NATIVE_ASSET,
        to: vec![],
        amount: 0,
        evm: Some(EvmParams::Setup { eoa_nonce: 0 }),
        btc: None,
    };

    // Delegated execution is refused before setup.
    let deadline = env.now() + 3600;
    env.propose_err(
        &t,
        evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, EvmParams::Delegated { deadline }),
        err_code(IkaError::EvmNotDelegated),
    );

    let i = env.propose(&t, setup.clone());
    env.approve(&t.account, &i);
    let it: Intent = env.fetch(&i);
    assert_eq!(it.approvals.len(), 2);

    let auth = digest::authorization_preimage(ETH_CHAIN_ID, &IMPL_ETH, 0).unwrap();
    assert_eq!(it.approvals[0].final_digest, digest::keccak(&[auth.as_slice()]));
    let rec = t.recovery.as_ref().unwrap();
    let init = digest::init_preimage(ETH_CHAIN_ID, &t.key.evm_address(), &rec.evm_address(), 3600).unwrap();
    assert_eq!(it.approvals[1].final_digest, digest::keccak(&[init.as_slice()]));

    // Changing the configured implementation changes what gets authorized; no
    // intent field can choose it.
    let other_impl = [0xAB; 20];
    env.update_config(vec![
        EvmChainConfig { chain: Chain::Ethereum, chain_id: ETH_CHAIN_ID, implementation: other_impl },
        EvmChainConfig { chain: Chain::Base, chain_id: BASE_CHAIN_ID, implementation: IMPL_BASE },
    ]);
    let mut again = setup.clone();
    again.evm = Some(EvmParams::Setup { eoa_nonce: 1 });
    let previews = env.preview(&t.account, again.clone(), 0);
    let auth2 = digest::authorization_preimage(ETH_CHAIN_ID, &other_impl, 1).unwrap();
    assert_eq!(previews[0].final_digest, digest::keccak(&[auth2.as_slice()]));

    // No implementation configured → setup refused.
    env.update_config(vec![EvmChainConfig { chain: Chain::Ethereum, chain_id: ETH_CHAIN_ID, implementation: [0u8; 20] }]);
    env.propose_err(&t, again, err_code(IkaError::UnknownChain));
}

#[test]
fn delegated_execute_binds_and_bumps_nonce() {
    let mut env = Env::new();
    let t = env.setup_account(Mode::EnforcedRecovery, default_policy());
    let setup = IntentParams {
        kind: IntentKind::EvmSetup,
        chain: Chain::Base,
        asset: NATIVE_ASSET,
        to: vec![],
        amount: 0,
        evm: Some(EvmParams::Setup { eoa_nonce: 0 }),
        btc: None,
    };
    let i = env.propose(&t, setup);
    env.approve(&t.account, &i);

    let deadline = env.now() + 3600;
    for expected_nonce in 0..2u64 {
        let i = env.propose(&t, evm_send(Chain::Base, USDC_BASE, RECIPIENT, 10, EvmParams::Delegated { deadline }));
        env.approve(&t.account, &i);
        let it: Intent = env.fetch(&i);
        assert_eq!(it.evm_nonce, expected_nonce);
        let call = digest::evm_call(&USDC_BASE, &RECIPIENT, 10).unwrap();
        let pre = digest::execute_preimage(BASE_CHAIN_ID, &t.key.evm_address(), &call, expected_nonce, deadline as u64).unwrap();
        assert_eq!(it.approvals[0].final_digest, digest::keccak(&[pre.as_slice()]));
        verify_signed(&t.key, &it.approvals[0].final_digest);
    }

    // CancelRecovery consumes the next nonce.
    let cancel = IntentParams {
        kind: IntentKind::EvmCancelRecovery,
        chain: Chain::Base,
        asset: NATIVE_ASSET,
        to: vec![],
        amount: 0,
        evm: Some(EvmParams::CancelRecovery { deadline }),
        btc: None,
    };
    let i = env.propose(&t, cancel);
    env.approve(&t.account, &i);
    let it: Intent = env.fetch(&i);
    assert_eq!(it.evm_nonce, 2);
    let pre = digest::cancel_recovery_preimage(BASE_CHAIN_ID, &t.key.evm_address(), 2, deadline as u64).unwrap();
    assert_eq!(it.approvals[0].final_digest, digest::keccak(&[pre.as_slice()]));

    // Owner can resync the nonce.
    let ix = Instruction::new_with_bytes(
        ika_account::ID,
        &ika_account::instruction::SetEvmNonce { chain_id: BASE_CHAIN_ID, nonce: 9 }.data(),
        ika_account::accounts::OwnerOnly { account: t.account, owner: t.owner.pubkey() }.to_account_metas(None),
    );
    let o = t.owner.insecure_clone();
    env.send_ok(&[ix], &[&o]);
    let a: IkaAccount = env.fetch(&t.account);
    assert_eq!(a.evm_nonces.iter().find(|n| n.chain_id == BASE_CHAIN_ID).unwrap().nonce, 9);

    // Expired deadlines are refused.
    env.propose_err(
        &t,
        evm_send(Chain::Base, USDC_BASE, RECIPIENT, 10, EvmParams::Delegated { deadline: env.now() - 1 }),
        err_code(IkaError::DeadlineExpired),
    );
}

#[test]
fn cancel_recovery_requires_recovery_mode() {
    let mut env = Env::new();
    let t = env.setup_account(Mode::Enforced, default_policy());
    let deadline = env.now() + 60;
    let cancel = IntentParams {
        kind: IntentKind::EvmCancelRecovery,
        chain: Chain::Ethereum,
        asset: NATIVE_ASSET,
        to: vec![],
        amount: 0,
        evm: Some(EvmParams::CancelRecovery { deadline }),
        btc: None,
    };
    env.propose_err(&t, cancel, err_code(IkaError::RecoveryNotConfigured));
}

#[test]
fn btc_approval_one_digest_per_input() {
    let mut env = Env::new();
    for mode in [Mode::Recoverable, Mode::Enforced, Mode::EnforcedRecovery] {
        let t = env.setup_account(mode, default_policy());
        let to = {
            let mut s = vec![0x00, 0x14];
            s.extend_from_slice(&[0x55; 20]);
            s
        };
        let inputs: Vec<BtcInput> = (1..=4).map(|n| utxo(n + mode as u8 * 10, 25_000)).collect();
        let i = env.propose(&t, btc_send(to, 60_000, inputs, 2_000));
        env.approve(&t.account, &i);
        let it: Intent = env.fetch(&i);
        assert_eq!(it.approvals.len(), 4);
        let key = t.btc_key.as_ref().unwrap_or(&t.key);
        for ap in &it.approvals {
            assert_eq!(ap.scheme, SCHEME_ECDSA_DOUBLE_SHA256);
            assert_ne!(ap.final_digest, ap.message_digest);
            verify_signed(key, &ap.final_digest);
            let ma = env.read_message_approval(&ap.message_approval);
            assert_eq!(u16::from_le_bytes([ma[162], ma[163]]), SCHEME_ECDSA_DOUBLE_SHA256);
        }
    }
}
