use anchor_lang::prelude::*;

use crate::state::{DWalletRole, Mode, UserShare};

#[event]
pub struct AccountCreated {
    pub account: Pubkey,
    pub owner: Pubkey,
    pub index: u16,
    pub mode: Mode,
    pub user_share: UserShare,
}

#[event]
pub struct DWalletRegistered {
    pub account: Pubkey,
    pub dwallet: Pubkey,
    pub role: DWalletRole,
}

#[event]
pub struct IntentProposed {
    pub account: Pubkey,
    pub intent: Pubkey,
    pub nonce: u64,
    pub executable_at: i64,
}

#[event]
pub struct IntentApproved {
    pub account: Pubkey,
    pub intent: Pubkey,
    pub evm_nonce: u64,
}

#[event]
pub struct IntentCancelled {
    pub account: Pubkey,
    pub intent: Pubkey,
}

#[event]
pub struct PolicyProposed {
    pub account: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct PolicyApplied {
    pub account: Pubkey,
}
