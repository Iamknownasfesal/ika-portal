use anchor_lang::prelude::*;
use ika_dwallet_anchor::{DWalletContext, CPI_AUTHORITY_SEED};

use crate::digests;
use crate::dwallet;
use crate::error::IkaError;
use crate::events::*;
use crate::policy;
use crate::state::*;

// ── Config ───────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigArgs {
    pub dwallet_program: Pubkey,
    pub btc_network: BtcNetwork,
    pub max_btc_inputs: u8,
    pub evm_chains: Vec<EvmChainConfig>,
    pub tokens: Vec<TokenConfig>,
}

fn write_config(cfg: &mut Config, args: ConfigArgs) -> Result<()> {
    require!(args.evm_chains.len() <= MAX_EVM_CHAINS, IkaError::UnknownChain);
    require!(args.tokens.len() <= MAX_TOKENS, IkaError::UnknownAsset);
    require!(
        args.max_btc_inputs >= 1 && args.max_btc_inputs as usize <= crate::digest::MAX_BTC_INPUTS,
        IkaError::TooManyInputs
    );
    require!(args.evm_chains.iter().all(|c| c.chain.is_evm()), IkaError::UnknownChain);
    require!(args.tokens.iter().all(|t| t.chain.is_evm()), IkaError::UnknownAsset);
    cfg.dwallet_program = args.dwallet_program;
    cfg.btc_network = args.btc_network;
    cfg.max_btc_inputs = args.max_btc_inputs;
    cfg.evm_chains = args.evm_chains;
    cfg.tokens = args.tokens;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.admin = ctx.accounts.admin.key();
    cfg.bump = ctx.bumps.config;
    write_config(cfg, args)
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
    write_config(&mut ctx.accounts.config, args)
}

// ── Account creation ─────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateAccountArgs {
    pub index: u16,
    pub mode: Mode,
    pub user_share: UserShare,
    pub ika_user: Pubkey,
    pub policy: Policy,
    pub recovery: Option<RecoveryParams>,
}

#[derive(Accounts)]
#[instruction(args: CreateAccountArgs)]
pub struct CreateAccount<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + IkaAccount::INIT_SPACE,
        seeds = [ACCOUNT_SEED, owner.key().as_ref(), &args.index.to_le_bytes()],
        bump,
    )]
    pub account: Box<Account<'info, IkaAccount>>,
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[allow(deprecated)]
fn is_on_curve(key: &Pubkey) -> bool {
    solana_curve25519::edwards::validate_edwards(&solana_curve25519::edwards::PodEdwardsPoint(key.to_bytes()))
}

pub fn handle_create_account(ctx: Context<CreateAccount>, args: CreateAccountArgs) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    // An encrypted user share needs the owner's device in every signature; a
    // PDA (Squads vault, program) has no device.
    if args.user_share == UserShare::Encrypted {
        require!(is_on_curve(&owner), IkaError::PdaOwnerRequiresPublicShare);
    }
    policy::validate_policy(&args.policy)?;

    let a = &mut ctx.accounts.account;
    a.owner = owner;
    a.index = args.index;
    a.mode = args.mode;
    a.user_share = args.user_share;
    a.ika_user = args.ika_user;
    a.dwallets = Vec::new();
    a.btc_pubkey = [0u8; 33];
    a.btc_pkh = [0u8; 20];
    a.evm_address = [0u8; 20];

    match (args.mode, &args.recovery) {
        (Mode::EnforcedRecovery, Some(r)) => {
            require!(r.csv_blocks >= 1 && r.recovery_delay_s > 0, IkaError::InvalidRecovery);
            let xy = crate::digest::verify_uncompressed(&r.pubkey, &r.pubkey_y).map_err(|_| error!(IkaError::InvalidPoint))?;
            let (x, y) = xy.split_at(32);
            a.recovery_pubkey = Some(r.pubkey);
            a.recovery_evm_address = crate::digest::evm_address(x.try_into().unwrap(), y.try_into().unwrap());
            a.csv_blocks = r.csv_blocks;
            a.recovery_delay_s = r.recovery_delay_s;
        }
        (Mode::EnforcedRecovery, None) => return err!(IkaError::InvalidRecovery),
        (_, Some(_)) => return err!(IkaError::InvalidRecovery),
        (_, None) => {
            a.recovery_pubkey = None;
            a.recovery_evm_address = [0u8; 20];
            a.csv_blocks = 0;
            a.recovery_delay_s = 0;
        }
    }

    a.spend = vec![SpendWindow::default(); args.policy.limits.len()];
    a.swap_spend = vec![SpendWindow::default(); args.policy.swap_limits.len()];
    a.policy = args.policy;
    a.pending_policy = None;
    a.pending_policy_at = 0;
    a.intent_nonce = 0;
    a.evm_nonces = Vec::new();
    a.bump = ctx.bumps.account;

    emit!(AccountCreated { account: a.key(), owner, index: a.index, mode: a.mode, user_share: a.user_share });
    Ok(())
}

// ── dWallet registration ─────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RegisterDWallet<'info> {
    #[account(mut, has_one = owner)]
    pub account: Box<Account<'info, IkaAccount>>,
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: parsed and validated against the configured dWallet program.
    pub dwallet: UncheckedAccount<'info>,
    /// CHECK: this program's CPI authority PDA.
    #[account(seeds = [CPI_AUTHORITY_SEED], bump)]
    pub cpi_authority: UncheckedAccount<'info>,
    /// Prevents the same dWallet from being registered to a second account.
    #[account(init, payer = payer, space = 8 + DWalletClaim::INIT_SPACE, seeds = [CLAIM_SEED, dwallet.key().as_ref()], bump)]
    pub claim: Box<Account<'info, DWalletClaim>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `evm_pubkey_y`: uncompressed Y of the dWallet key; required for EVM roles
/// (verified on-chain), ignored for the Bitcoin-only role.
pub fn handle_register_dwallet(ctx: Context<RegisterDWallet>, role: DWalletRole, evm_pubkey_y: [u8; 32]) -> Result<()> {
    let info = dwallet::parse(&ctx.accounts.dwallet.to_account_info(), &ctx.accounts.config.dwallet_program)?;
    require_keys_eq!(info.authority, ctx.accounts.cpi_authority.key(), IkaError::WrongDWalletAuthority);

    let a = &mut ctx.accounts.account;
    let dwallet_key = ctx.accounts.dwallet.key();
    require!(!a.dwallets.iter().any(|d| d.dwallet == dwallet_key), IkaError::InvalidRole);
    let role_ok = match a.mode {
        Mode::Recoverable => matches!(role, DWalletRole::Btc | DWalletRole::Evm),
        Mode::Enforced | Mode::EnforcedRecovery => role == DWalletRole::Both,
    };
    require!(role_ok, IkaError::InvalidRole);
    // Each chain family may be covered by exactly one dWallet.
    let covers_btc = role.covers(Chain::Bitcoin);
    let covers_evm = role.covers(Chain::Ethereum);
    require!(!(covers_btc && a.has_btc()) && !(covers_evm && a.has_evm()), IkaError::InvalidRole);

    if covers_btc {
        a.btc_pubkey = info.pubkey;
        a.btc_pkh = crate::digest::hash160(&info.pubkey);
    }
    if covers_evm {
        let xy = crate::digest::verify_uncompressed(&info.pubkey, &evm_pubkey_y).map_err(|_| error!(IkaError::InvalidPoint))?;
        let (x, y) = xy.split_at(32);
        a.evm_address = crate::digest::evm_address(x.try_into().unwrap(), y.try_into().unwrap());
    }
    a.dwallets.push(DWalletEntry { dwallet: dwallet_key, curve: info.curve, role, pubkey: info.pubkey });
    let account_key = a.key();
    let claim = &mut ctx.accounts.claim;
    claim.account = account_key;
    claim.dwallet = dwallet_key;
    claim.bump = ctx.bumps.claim;

    emit!(DWalletRegistered { account: account_key, dwallet: dwallet_key, role });
    Ok(())
}

// ── Intents ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ProposeIntent<'info> {
    #[account(mut, has_one = owner)]
    pub account: Box<Account<'info, IkaAccount>>,
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Intent::INIT_SPACE,
        seeds = [INTENT_SEED, account.key().as_ref(), &account.intent_nonce.to_le_bytes()],
        bump,
    )]
    pub intent: Box<Account<'info, Intent>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_intent(ctx: Context<ProposeIntent>, params: IntentParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts.account;
    require!(params.to.len() <= MAX_ADDR, IkaError::InvalidAddress);
    digests::validate_params(a, &ctx.accounts.config, &params, now)?;
    let eval = policy::evaluate(a, &params, now)?;

    let nonce = a.intent_nonce;
    a.intent_nonce = nonce.checked_add(1).ok_or(error!(IkaError::Overflow))?;

    let account_key = a.key();
    let i = &mut ctx.accounts.intent;
    i.account = account_key;
    i.nonce = nonce;
    i.params = params;
    i.status = IntentStatus::Proposed;
    i.created_at = now;
    i.executable_at = eval.executable_at;
    i.evm_nonce = 0;
    i.limit_charge = eval.limit_charge;
    i.swap_charge = eval.swap_charge;
    i.approvals = Vec::new();
    i.bump = ctx.bumps.intent;

    emit!(IntentProposed { account: account_key, intent: i.key(), nonce, executable_at: i.executable_at });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelIntent<'info> {
    #[account(mut, has_one = owner)]
    pub account: Box<Account<'info, IkaAccount>>,
    pub owner: Signer<'info>,
    #[account(mut, has_one = account)]
    pub intent: Box<Account<'info, Intent>>,
}

pub fn handle_cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
    let i = &mut ctx.accounts.intent;
    require!(i.status == IntentStatus::Proposed, IkaError::IntentNotProposed);
    i.status = IntentStatus::Cancelled;
    let a = &mut ctx.accounts.account;
    policy::release_charge(&mut a.spend, &i.limit_charge);
    policy::release_charge(&mut a.swap_spend, &i.swap_charge);
    emit!(IntentCancelled { account: a.key(), intent: i.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct ApproveIntent<'info> {
    #[account(mut)]
    pub account: Box<Account<'info, IkaAccount>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = account)]
    pub intent: Box<Account<'info, Intent>>,
    /// CHECK: must equal the account's dWallet for the intent's chain.
    pub dwallet: UncheckedAccount<'info>,
    /// CHECK: Ika DWalletCoordinator PDA; validated by the dWallet program.
    pub coordinator: UncheckedAccount<'info>,
    /// CHECK: this program's CPI authority PDA.
    #[account(seeds = [CPI_AUTHORITY_SEED], bump)]
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: this program (executable), required by the dWallet program's CPI check.
    #[account(address = crate::ID)]
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: the configured dWallet program.
    #[account(address = config.dwallet_program)]
    pub dwallet_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: one writable MessageApproval PDA per digest, in order.
}

pub fn handle_approve_intent<'info>(ctx: Context<'info, ApproveIntent<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accs = &mut *ctx.accounts;
    require!(accs.intent.status == IntentStatus::Proposed, IkaError::IntentNotProposed);
    require!(now >= accs.intent.executable_at, IkaError::NotExecutableYet);

    let params = accs.intent.params.clone();
    let cfg = &accs.config;
    let a = &mut accs.account;

    // Validate again: config or state may have changed since propose.
    digests::validate_params(a, cfg, &params, now)?;

    // Bind and consume the IkaAccount nonce where the digest needs one.
    let mut evm_nonce = 0;
    if params.chain.is_evm() {
        let chain_id = cfg.evm_chain(params.chain).ok_or(error!(IkaError::UnknownChain))?.chain_id;
        let entry = a.evm_nonce_mut(chain_id)?;
        match params.evm {
            Some(EvmParams::Delegated { .. }) | Some(EvmParams::CancelRecovery { .. }) => {
                evm_nonce = entry.nonce;
                entry.nonce = entry.nonce.checked_add(1).ok_or(error!(IkaError::Overflow))?;
            }
            Some(EvmParams::Setup { .. }) => entry.delegated = true,
            _ => {}
        }
    }

    let signables = digests::build(a, cfg, &params, evm_nonce, now)?;
    let entry = a.dwallet_for(params.chain).ok_or(error!(IkaError::AccountNotReady))?.clone();
    require_keys_eq!(accs.dwallet.key(), entry.dwallet, IkaError::WrongDWallet);
    require!(ctx.remaining_accounts.len() == signables.len(), IkaError::WrongApprovalCount);

    let dctx = DWalletContext {
        dwallet_program: accs.dwallet_program.to_account_info(),
        cpi_authority: accs.cpi_authority.to_account_info(),
        caller_program: accs.caller_program.to_account_info(),
        cpi_authority_bump: ctx.bumps.cpi_authority,
    };
    let ika_user = a.ika_user.to_bytes();
    let mut approvals = Vec::with_capacity(signables.len());
    for (s, ma) in signables.iter().zip(ctx.remaining_accounts.iter()) {
        let message_digest = s.message_digest();
        let (expected, bump) =
            dwallet::find_message_approval(&cfg.dwallet_program, entry.curve, &entry.pubkey, s.scheme, &message_digest);
        require_keys_eq!(ma.key(), expected, IkaError::InvalidMessageApproval);
        dctx.approve_message(
            &accs.coordinator.to_account_info(),
            ma,
            &accs.dwallet.to_account_info(),
            &accs.payer.to_account_info(),
            &accs.system_program.to_account_info(),
            message_digest,
            [0u8; 32],
            ika_user,
            s.scheme,
            bump,
        )?;
        approvals.push(Approval { message_digest, final_digest: s.final_digest(), scheme: s.scheme, message_approval: expected });
    }

    let i = &mut accs.intent;
    i.evm_nonce = evm_nonce;
    i.approvals = approvals;
    i.status = IntentStatus::Approved;
    emit!(IntentApproved { account: a.key(), intent: i.key(), evm_nonce });
    Ok(())
}

// ── Digest preview (read-only; used by the SDK and parity tests) ────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DigestPreview {
    pub message_digest: [u8; 32],
    pub final_digest: [u8; 32],
    pub scheme: u16,
}

#[derive(Accounts)]
pub struct PreviewDigests<'info> {
    pub account: Box<Account<'info, IkaAccount>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

pub fn handle_preview_digests(ctx: Context<PreviewDigests>, params: IntentParams, evm_nonce: u64) -> Result<Vec<DigestPreview>> {
    let now = Clock::get()?.unix_timestamp;
    let out = digests::build(&ctx.accounts.account, &ctx.accounts.config, &params, evm_nonce, now)?;
    Ok(out
        .iter()
        .map(|s| DigestPreview { message_digest: s.message_digest(), final_digest: s.final_digest(), scheme: s.scheme })
        .collect())
}

// ── Policy changes ───────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(mut, has_one = owner)]
    pub account: Box<Account<'info, IkaAccount>>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Permissionless<'info> {
    #[account(mut)]
    pub account: Box<Account<'info, IkaAccount>>,
}

pub fn handle_propose_policy(ctx: Context<OwnerOnly>, next: Policy) -> Result<()> {
    policy::validate_policy(&next)?;
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts.account;
    // The *current* policy's delay governs how soon a change can land.
    a.pending_policy_at = now.saturating_add(a.policy.policy_change_delay_s as i64);
    a.pending_policy = Some(next);
    emit!(PolicyProposed { account: a.key(), effective_at: a.pending_policy_at });
    Ok(())
}

pub fn handle_apply_policy(ctx: Context<Permissionless>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts.account;
    let next = a.pending_policy.clone().ok_or(error!(IkaError::NoPendingPolicy))?;
    require!(now >= a.pending_policy_at, IkaError::PolicyChangeNotReady);
    a.spend = policy::remap_spend(&a.policy.limits, &a.spend, &next.limits);
    a.swap_spend = policy::remap_spend(&a.policy.swap_limits, &a.swap_spend, &next.swap_limits);
    a.policy = next;
    a.pending_policy = None;
    a.pending_policy_at = 0;
    emit!(PolicyApplied { account: a.key() });
    Ok(())
}

pub fn handle_cancel_policy(ctx: Context<OwnerOnly>) -> Result<()> {
    let a = &mut ctx.accounts.account;
    require!(a.pending_policy.is_some(), IkaError::NoPendingPolicy);
    a.pending_policy = None;
    a.pending_policy_at = 0;
    Ok(())
}

/// Resynchronize the program's view of the `IkaAccount` nonce, e.g. after an
/// approved `execute` expired unsubmitted. Safe: the contract nonce still
/// prevents replay; a wrong value only yields unusable signatures.
pub fn handle_set_evm_nonce(ctx: Context<OwnerOnly>, chain_id: u64, nonce: u64) -> Result<()> {
    let entry = ctx.accounts.account.evm_nonce_mut(chain_id)?;
    entry.nonce = nonce;
    Ok(())
}
