use anchor_lang::prelude::*;

#[error_code]
pub enum IkaError {
    // ── Policy rejections (section 7). Each rule has its own code. ──
    #[msg("Spending limit for this chain/asset window exceeded")]
    LimitExceeded,
    #[msg("Recipient is not in the allowlist")]
    RecipientNotAllowed,
    #[msg("Swaps are disabled by policy")]
    SwapsDisabled,
    #[msg("Swap limit for this chain/asset window exceeded")]
    SwapLimitExceeded,
    #[msg("Fee exceeds the policy cap")]
    FeeTooHigh,
    #[msg("Chain is not configured")]
    UnknownChain,
    #[msg("Too many Bitcoin inputs")]
    TooManyInputs,

    // ── Validation ──
    #[msg("Asset is not configured for this chain")]
    UnknownAsset,
    #[msg("Invalid policy")]
    InvalidPolicy,
    #[msg("Recovery parameters do not match the account mode")]
    InvalidRecovery,
    #[msg("A PDA owner must use userShare = public")]
    PdaOwnerRequiresPublicShare,
    #[msg("Account is not owned by the configured dWallet program or has a bad layout")]
    InvalidDWallet,
    #[msg("dWallet is not active")]
    DWalletNotActive,
    #[msg("dWallet authority is not this program's CPI authority (run transfer_ownership first)")]
    WrongDWalletAuthority,
    #[msg("dWallet curve must be secp256k1")]
    WrongCurve,
    #[msg("dWallet role is invalid for this mode or already registered")]
    InvalidRole,
    #[msg("Account has no dWallet registered for this chain")]
    AccountNotReady,
    #[msg("Invalid intent parameters")]
    InvalidIntentParams,
    #[msg("Invalid address")]
    InvalidAddress,
    #[msg("Bitcoin inputs do not cover amount + fee")]
    InsufficientInputs,
    #[msg("Account is not set up for delegated EVM execution on this chain")]
    EvmNotDelegated,
    #[msg("Recovery is not configured for this account")]
    RecoveryNotConfigured,
    #[msg("Deadline has passed")]
    DeadlineExpired,
    #[msg("Invalid secp256k1 point")]
    InvalidPoint,
    #[msg("Digest serialization failed")]
    DigestError,

    // ── Lifecycle ──
    #[msg("Intent is not in the proposed state")]
    IntentNotProposed,
    #[msg("Intent is not executable yet (delay)")]
    NotExecutableYet,
    #[msg("No pending policy")]
    NoPendingPolicy,
    #[msg("Policy change delay has not elapsed")]
    PolicyChangeNotReady,
    #[msg("MessageApproval account does not match the computed PDA")]
    InvalidMessageApproval,
    #[msg("Wrong number of MessageApproval accounts")]
    WrongApprovalCount,
    #[msg("Wrong dWallet account for this chain")]
    WrongDWallet,
    #[msg("Arithmetic overflow")]
    Overflow,
}

impl From<crate::digest::DigestError> for IkaError {
    fn from(e: crate::digest::DigestError) -> Self {
        match e {
            crate::digest::DigestError::InvalidPoint => IkaError::InvalidPoint,
            _ => IkaError::DigestError,
        }
    }
}
