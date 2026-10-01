mod common;

use common::*;
use ika_account::error::IkaError;
use ika_account::state::*;
use solana_signer::Signer;

const RECIPIENT: [u8; 20] = [0x42; 20];
const P2WPKH_TO: [u8; 22] = {
    let mut s = [0x77u8; 22];
    s[0] = 0x00;
    s[1] = 0x14;
    s
};

fn limit(chain: Chain, asset: [u8; 20], max: u64, window: u32) -> Limit {
    Limit { chain, asset, max_per_window: max, window_s: window }
}

#[test]
fn account_creation_all_modes_register_addresses() {
    let mut env = Env::new();
    for mode in [Mode::Recoverable, Mode::Enforced, Mode::EnforcedRecovery] {
        let t = env.setup_account(mode, default_policy());
        let a: IkaAccount = env.fetch(&t.account);
        assert_eq!(a.mode, mode);
        assert!(a.has_btc() && a.has_evm());
        assert_eq!(a.evm_address, t.key.evm_address());
        let btc_key = t.btc_key.as_ref().unwrap_or(&t.key);
        assert_eq!(a.btc_pubkey, btc_key.compressed);
        assert_eq!(a.dwallets.len(), if mode == Mode::Recoverable { 2 } else { 1 });
        if mode == Mode::EnforcedRecovery {
            assert_eq!(a.recovery_evm_address, t.recovery.as_ref().unwrap().evm_address());
        }
    }
}

#[test]
fn recovery_params_must_match_mode() {
    let mut env = Env::new();
    let owner = solana_keypair::Keypair::new();
    let r = Key::random();
    let mut args = ika_account::CreateAccountArgs {
        index: 0,
        mode: Mode::Enforced,
        user_share: UserShare::Public,
        ika_user: owner.pubkey(),
        policy: default_policy(),
        recovery: Some(RecoveryParams { pubkey: r.compressed, pubkey_y: r.y, csv_blocks: 6, recovery_delay_s: 60 }),
    };
    let ix = env.create_account_ix(&owner.pubkey(), args.clone());
    env.expect_err(&[ix], &[&owner], err_code(IkaError::InvalidRecovery));

    args.mode = Mode::EnforcedRecovery;
    args.recovery = None;
    let ix = env.create_account_ix(&owner.pubkey(), args.clone());
    env.expect_err(&[ix], &[&owner], err_code(IkaError::InvalidRecovery));

    // Wrong Y for the recovery key.
    let mut bad_y = r.y;
    bad_y[5] ^= 0xff;
    args.recovery = Some(RecoveryParams { pubkey: r.compressed, pubkey_y: bad_y, csv_blocks: 6, recovery_delay_s: 60 });
    let ix = env.create_account_ix(&owner.pubkey(), args);
    env.expect_err(&[ix], &[&owner], err_code(IkaError::InvalidPoint));
}

#[test]
fn register_requires_cpi_authority_and_correct_y() {
    let mut env = Env::new();
    let owner = solana_keypair::Keypair::new();
    env.svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
    let args = ika_account::CreateAccountArgs {
        index: 0,
        mode: Mode::Enforced,
        user_share: UserShare::Public,
        ika_user: owner.pubkey(),
        policy: default_policy(),
        recovery: None,
    };
    let ix = env.create_account_ix(&owner.pubkey(), args);
    env.send_ok(&[ix], &[&owner]);
    let account = account_pda(&owner.pubkey(), 0);
    let k = Key::random();
    let dw = env.create_dwallet(&k, &owner.pubkey());

    // Authority not transferred yet.
    let ix = Env::register_ix(&owner.pubkey(), &account, &dw, DWalletRole::Both, k.y);
    env.expect_err(&[ix], &[&owner], err_code(IkaError::WrongDWalletAuthority));

    let t = Env::transfer_ownership_ix(&owner.pubkey(), &dw, &cpi_authority());
    env.send_ok(&[t], &[&owner]);

    // Wrong role for mode.
    let ix = Env::register_ix(&owner.pubkey(), &account, &dw, DWalletRole::Evm, k.y);
    env.expect_err(&[ix], &[&owner], err_code(IkaError::InvalidRole));

    // Wrong Y.
    let mut y = k.y;
    y[0] ^= 1;
    let ix = Env::register_ix(&owner.pubkey(), &account, &dw, DWalletRole::Both, y);
    env.expect_err(&[ix], &[&owner], err_code(IkaError::InvalidPoint));

    let ix = Env::register_ix(&owner.pubkey(), &account, &dw, DWalletRole::Both, k.y);
    env.send_ok(&[ix], &[&owner]);

    // The same dWallet can't be registered to a second account.
    let other = solana_keypair::Keypair::new();
    env.svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    let args2 = ika_account::CreateAccountArgs {
        index: 0,
        mode: Mode::Enforced,
        user_share: UserShare::Public,
        ika_user: other.pubkey(),
        policy: default_policy(),
        recovery: None,
    };
    let ix = env.create_account_ix(&other.pubkey(), args2);
    env.send_ok(&[ix], &[&other]);
    let hijack = Env::register_ix(&other.pubkey(), &account_pda(&other.pubkey(), 0), &dw, DWalletRole::Both, k.y);
    assert!(env.send(&[hijack], &[&other]).is_err(), "dWallet double registration must fail");

    // Second dWallet for the same chains is rejected.
    let k2 = Key::random();
    let dw2 = env.create_dwallet(&k2, &cpi_authority());
    let ix = Env::register_ix(&owner.pubkey(), &account, &dw2, DWalletRole::Both, k2.y);
    env.expect_err(&[ix], &[&owner], err_code(IkaError::InvalidRole));
}

#[test]
fn limit_exceeded_and_window_reset() {
    let mut env = Env::new();
    let mut p = default_policy();
    p.limits = vec![limit(Chain::Ethereum, NATIVE_ASSET, 1_000, 3600)];
    let t = env.setup_account(Mode::Enforced, p);

    env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 600, direct(0)));
    env.propose_err(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 401, direct(1)), err_code(IkaError::LimitExceeded));
    env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 400, direct(1)));
    env.propose_err(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, direct(2)), err_code(IkaError::LimitExceeded));

    // Other assets/chains without an entry are unlimited.
    env.propose(&t, evm_send(Chain::Base, NATIVE_ASSET, RECIPIENT, 1_000_000, direct(0)));

    // Fixed window: one second before reset still blocked, at reset allowed.
    env.warp(3599);
    env.propose_err(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, direct(2)), err_code(IkaError::LimitExceeded));
    env.warp(1);
    env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1_000, direct(2)));
    let a: IkaAccount = env.fetch(&t.account);
    assert_eq!(a.spend[0].used, 1_000);
    assert_eq!(a.spend[0].window_start, START_TS + 3600);
}

#[test]
fn cancel_releases_spend() {
    let mut env = Env::new();
    let mut p = default_policy();
    p.limits = vec![limit(Chain::Ethereum, NATIVE_ASSET, 1_000, 3600)];
    let t = env.setup_account(Mode::Enforced, p);

    let i = env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1_000, direct(0)));
    env.propose_err(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, direct(1)), err_code(IkaError::LimitExceeded));
    env.cancel(&t, &i);
    let it: Intent = env.fetch(&i);
    assert_eq!(it.status, IntentStatus::Cancelled);
    env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1_000, direct(1)));

    // A cancelled intent can't be approved.
    let ix = env.approve_ix(&t.account, &i);
    let payer = env.payer.insecure_clone();
    env.expect_err(&[compute_budget_ix(1_400_000), ix], &[&payer], err_code(IkaError::IntentNotProposed));
}

#[test]
fn allowlist() {
    let mut env = Env::new();
    let mut p = default_policy();
    p.allowlist_enabled = true;
    p.allowlist = vec![
        AllowEntry { chain: Chain::Ethereum, address: RECIPIENT.to_vec() },
        AllowEntry { chain: Chain::Bitcoin, address: P2WPKH_TO.to_vec() },
    ];
    let t = env.setup_account(Mode::Enforced, p);
    env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, direct(0)));
    env.propose_err(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, [0x43; 20], 1, direct(1)), err_code(IkaError::RecipientNotAllowed));
    // Same address on another chain is not allowed.
    env.propose_err(&t, evm_send(Chain::Base, NATIVE_ASSET, RECIPIENT, 1, direct(0)), err_code(IkaError::RecipientNotAllowed));
    env.propose(&t, btc_send(P2WPKH_TO.to_vec(), 10_000, vec![utxo(1, 50_000)], 1_000));

    // Swap deposits are exempt from the allowlist.
    let mut swap = evm_send(Chain::Ethereum, NATIVE_ASSET, [0x99; 20], 1, direct(1));
    swap.kind = IntentKind::Swap;
    env.propose(&t, swap);
}

#[test]
fn swaps_disabled_and_swap_limits() {
    let mut env = Env::new();
    let mut p = default_policy();
    p.swaps_enabled = false;
    let t = env.setup_account(Mode::Enforced, p.clone());
    let mut swap = evm_send(Chain::Base, USDC_BASE, [0x99; 20], 100, direct(0));
    swap.kind = IntentKind::Swap;
    env.propose_err(&t, swap.clone(), err_code(IkaError::SwapsDisabled));

    p.swaps_enabled = true;
    p.swap_limits = vec![limit(Chain::Base, USDC_BASE, 150, 86_400)];
    p.limits = vec![limit(Chain::Base, USDC_BASE, 1_000, 86_400)];
    let t = env.setup_account(Mode::Enforced, p);
    env.propose(&t, swap.clone());
    swap.evm = Some(direct(1));
    env.propose_err(&t, swap.clone(), err_code(IkaError::SwapLimitExceeded));
    // Swaps also count toward the general limit.
    let a: IkaAccount = env.fetch(&t.account);
    assert_eq!(a.spend[0].used, 100);
    assert_eq!(a.swap_spend[0].used, 100);
    // Plain sends are not capped by swap limits.
    env.propose(&t, evm_send(Chain::Base, USDC_BASE, RECIPIENT, 500, direct(1)));
}

#[test]
fn fee_caps() {
    let mut env = Env::new();
    let mut p = default_policy();
    p.max_btc_fee_sats = 5_000;
    p.max_evm_fee_wei = 21_000 * 2_000_000_000;
    let t = env.setup_account(Mode::Enforced, p);

    env.propose(&t, btc_send(P2WPKH_TO.to_vec(), 10_000, vec![utxo(1, 50_000)], 5_000));
    env.propose_err(&t, btc_send(P2WPKH_TO.to_vec(), 10_000, vec![utxo(2, 50_000)], 5_001), err_code(IkaError::FeeTooHigh));
    // Sub-dust change is absorbed into the fee, which then counts toward the cap.
    env.propose_err(&t, btc_send(P2WPKH_TO.to_vec(), 10_000, vec![utxo(3, 15_500)], 5_000), err_code(IkaError::FeeTooHigh));
    env.propose_err(&t, btc_send(P2WPKH_TO.to_vec(), 10_000, vec![utxo(4, 12_000)], 5_000), err_code(IkaError::InsufficientInputs));

    env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, direct(0)));
    let pricey = EvmParams::Direct { nonce: 1, gas_limit: 21_000, max_fee_per_gas: 2_000_000_001, max_priority_fee_per_gas: 1 };
    env.propose_err(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, pricey), err_code(IkaError::FeeTooHigh));
}

#[test]
fn unknown_chain_asset_and_too_many_inputs() {
    let mut env = Env::new();
    let t = env.setup_account(Mode::Enforced, default_policy());
    // Base removed from config.
    env.update_config(vec![EvmChainConfig { chain: Chain::Ethereum, chain_id: ETH_CHAIN_ID, implementation: IMPL_ETH }]);
    env.propose_err(&t, evm_send(Chain::Base, NATIVE_ASSET, RECIPIENT, 1, direct(0)), err_code(IkaError::UnknownChain));
    // Token not configured on Ethereum.
    env.propose_err(&t, evm_send(Chain::Ethereum, USDC_BASE, RECIPIENT, 1, direct(0)), err_code(IkaError::UnknownAsset));
    let inputs = (1..=5).map(|i| utxo(i, 10_000)).collect();
    env.propose_err(&t, btc_send(P2WPKH_TO.to_vec(), 10_000, inputs, 1_000), err_code(IkaError::TooManyInputs));
}

#[test]
fn delay_threshold_blocks_early_approval() {
    let mut env = Env::new();
    let mut p = default_policy();
    p.delay_thresholds = vec![DelayThreshold { chain: Chain::Ethereum, asset: NATIVE_ASSET, amount: 1_000 }];
    p.delay_s = 600;
    let t = env.setup_account(Mode::Enforced, p);

    let small = env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 999, direct(0)));
    env.approve(&t.account, &small);

    let big = env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1_000, direct(1)));
    let it: Intent = env.fetch(&big);
    assert_eq!(it.executable_at, env.now() + 600);
    let payer = env.payer.insecure_clone();
    let ix = env.approve_ix(&t.account, &big);
    env.expect_err(&[compute_budget_ix(1_400_000), ix], &[&payer], err_code(IkaError::NotExecutableYet));
    env.warp(599);
    let ix = env.approve_ix(&t.account, &big);
    env.expect_err(&[compute_budget_ix(1_400_000), ix], &[&payer], err_code(IkaError::NotExecutableYet));
    env.warp(1);
    env.approve(&t.account, &big);
    let it: Intent = env.fetch(&big);
    assert_eq!(it.status, IntentStatus::Approved);
}

#[test]
fn policy_change_delay() {
    let mut env = Env::new();
    let mut p = default_policy();
    p.policy_change_delay_s = 86_400;
    p.limits = vec![limit(Chain::Ethereum, NATIVE_ASSET, 100, 86_400)];
    let t = env.setup_account(Mode::Enforced, p.clone());
    let owner = t.owner.insecure_clone();

    let mut next = p.clone();
    next.limits[0].max_per_window = 10_000;
    env.send_ok(&[Env::policy_ix(&t, "propose", Some(next.clone()))], &[&owner]);
    env.expect_err(&[Env::policy_ix(&t, "apply", None)], &[], err_code(IkaError::PolicyChangeNotReady));
    env.propose_err(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 500, direct(0)), err_code(IkaError::LimitExceeded));
    env.warp(86_399);
    env.expect_err(&[Env::policy_ix(&t, "apply", None)], &[], err_code(IkaError::PolicyChangeNotReady));
    env.warp(1);
    env.send_ok(&[Env::policy_ix(&t, "apply", None)], &[]);
    let a: IkaAccount = env.fetch(&t.account);
    assert_eq!(a.policy, next);
    assert!(a.pending_policy.is_none());
    env.propose(&t, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 500, direct(0)));

    // Cancel clears a pending change; applying afterwards fails.
    env.send_ok(&[Env::policy_ix(&t, "propose", Some(p))], &[&owner]);
    env.send_ok(&[Env::policy_ix(&t, "cancel", None)], &[&owner]);
    env.expect_err(&[Env::policy_ix(&t, "apply", None)], &[], err_code(IkaError::NoPendingPolicy));
}

#[test]
fn invalid_policy_rejected() {
    let mut env = Env::new();
    let owner = solana_keypair::Keypair::new();
    let mut p = default_policy();
    p.limits = vec![limit(Chain::Ethereum, NATIVE_ASSET, 1, 0)];
    let args = ika_account::CreateAccountArgs {
        index: 0,
        mode: Mode::Enforced,
        user_share: UserShare::Public,
        ika_user: owner.pubkey(),
        policy: p,
        recovery: None,
    };
    let ix = env.create_account_ix(&owner.pubkey(), args);
    env.expect_err(&[ix], &[&owner], err_code(IkaError::InvalidPolicy));
}

#[test]
fn only_owner_can_propose() {
    let mut env = Env::new();
    let t = env.setup_account(Mode::Enforced, default_policy());
    let stranger = solana_keypair::Keypair::new();
    let (ix, _) = env.propose_ix(&stranger.pubkey(), &t.account, evm_send(Chain::Ethereum, NATIVE_ASSET, RECIPIENT, 1, direct(0)));
    // Anchor has_one violation.
    env.expect_err(&[ix], &[&stranger], anchor_lang::error::ErrorCode::ConstraintHasOne as u32);
}
