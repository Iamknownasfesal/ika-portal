use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ACCOUNT_SEED: &[u8] = b"account";
pub const INTENT_SEED: &[u8] = b"intent";
pub const CLAIM_SEED: &[u8] = b"claim";

pub const MAX_DWALLETS: usize = 3;
pub const MAX_EVM_CHAINS: usize = 4;
pub const MAX_TOKENS: usize = 8;
pub const MAX_LIMITS: usize = 8;
pub const MAX_ALLOWLIST: usize = 16;
pub const MAX_THRESHOLDS: usize = 8;
pub const MAX_APPROVALS: usize = 4;
pub const MAX_ADDR: usize = 34;

pub const NATIVE_ASSET: [u8; 20] = [0u8; 20];

/// Ika `DWalletSignatureScheme` values used here.
pub const SCHEME_ECDSA_KECCAK256: u16 = 0;
pub const SCHEME_ECDSA_DOUBLE_SHA256: u16 = 2;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Chain {
    Bitcoin,
    Ethereum,
    Base,
}

impl Chain {
    pub fn is_evm(self) -> bool {
        !matches!(self, Chain::Bitcoin)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Mode {
    Recoverable,
    Enforced,
    EnforcedRecovery,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum UserShare {
    Public,
    Encrypted,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum DWalletRole {
    Btc,
    Evm,
    Both,
}

impl DWalletRole {
    pub fn covers(self, chain: Chain) -> bool {
        match self {
            DWalletRole::Both => true,
            DWalletRole::Btc => chain == Chain::Bitcoin,
            DWalletRole::Evm => chain.is_evm(),
        }
    }
}

// ── Config ───────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct EvmChainConfig {
    pub chain: Chain,
    pub chain_id: u64,
    /// `IkaAccount` delegate implementation on this chain (for EIP-7702 setup).
    pub implementation: [u8; 20],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct TokenConfig {
    pub chain: Chain,
    pub address: [u8; 20],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BtcNetwork {
    Mainnet,
    Testnet,
    Regtest,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Ika dWallet program (or `mock_dwallet` locally). Switching is config-only.
    pub dwallet_program: Pubkey,
    pub btc_network: BtcNetwork,
    pub max_btc_inputs: u8,
    #[max_len(MAX_EVM_CHAINS)]
    pub evm_chains: Vec<EvmChainConfig>,
    #[max_len(MAX_TOKENS)]
    pub tokens: Vec<TokenConfig>,
    pub bump: u8,
}

impl Config {
    pub fn evm_chain(&self, chain: Chain) -> Option<&EvmChainConfig> {
        self.evm_chains.iter().find(|c| c.chain == chain)
    }

    pub fn asset_known(&self, chain: Chain, asset: &[u8; 20]) -> bool {
        *asset == NATIVE_ASSET || (chain.is_evm() && self.tokens.iter().any(|t| t.chain == chain && t.address == *asset))
    }
}

// ── Policy ───────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct Limit {
    pub chain: Chain,
    pub asset: [u8; 20],
    pub max_per_window: u64,
    pub window_s: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct AllowEntry {
    pub chain: Chain,
    /// EVM: 20-byte address. Bitcoin: the output scriptPubKey.
    #[max_len(MAX_ADDR)]
    pub address: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct DelayThreshold {
    pub chain: Chain,
    pub asset: [u8; 20],
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct Policy {
    #[max_len(MAX_LIMITS)]
    pub limits: Vec<Limit>,
    pub allowlist_enabled: bool,
    #[max_len(MAX_ALLOWLIST)]
    pub allowlist: Vec<AllowEntry>,
    #[max_len(MAX_THRESHOLDS)]
    pub delay_thresholds: Vec<DelayThreshold>,
    pub delay_s: u32,
    pub swaps_enabled: bool,
    #[max_len(MAX_LIMITS)]
    pub swap_limits: Vec<Limit>,
    pub max_btc_fee_sats: u64,
    /// Cap on `gas_limit * max_fee_per_gas` for direct (self-paid) EVM transactions.
    pub max_evm_fee_wei: u64,
    pub policy_change_delay_s: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace)]
pub struct SpendWindow {
    pub window_start: i64,
    pub used: u64,
}

// ── Account ──────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct DWalletEntry {
    pub dwallet: Pubkey,
    pub curve: u16,
    pub role: DWalletRole,
    pub pubkey: [u8; 33],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct EvmNonce {
    pub chain_id: u64,
    /// Next `IkaAccount` nonce this program will sign for.
    pub nonce: u64,
    pub delegated: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct RecoveryParams {
    /// Compressed secp256k1 recovery key, generated and kept by the user.
    pub pubkey: [u8; 33],
    /// Uncompressed Y of `pubkey`; verified on-chain, used for the EVM address.
    pub pubkey_y: [u8; 32],
    pub csv_blocks: u16,
    pub recovery_delay_s: u32,
}

#[account]
#[derive(InitSpace)]
pub struct IkaAccount {
    pub owner: Pubkey,
    pub index: u16,
    pub mode: Mode,
    pub user_share: UserShare,
    /// Ed25519 key authorized to call Ika gRPC `Sign` for this account's approvals.
    pub ika_user: Pubkey,
    #[max_len(MAX_DWALLETS)]
    pub dwallets: Vec<DWalletEntry>,
    pub btc_pubkey: [u8; 33],
    pub btc_pkh: [u8; 20],
    pub evm_address: [u8; 20],
    pub recovery_pubkey: Option<[u8; 33]>,
    pub recovery_evm_address: [u8; 20],
    pub csv_blocks: u16,
    pub recovery_delay_s: u32,
    pub policy: Policy,
    pub pending_policy: Option<Policy>,
    pub pending_policy_at: i64,
    #[max_len(MAX_LIMITS)]
    pub spend: Vec<SpendWindow>,
    #[max_len(MAX_LIMITS)]
    pub swap_spend: Vec<SpendWindow>,
    pub intent_nonce: u64,
    #[max_len(MAX_EVM_CHAINS)]
    pub evm_nonces: Vec<EvmNonce>,
    pub bump: u8,
}

impl IkaAccount {
    pub fn dwallet_for(&self, chain: Chain) -> Option<&DWalletEntry> {
        self.dwallets.iter().find(|d| d.role.covers(chain))
    }

    pub fn has_btc(&self) -> bool {
        self.btc_pubkey[0] != 0
    }

    pub fn has_evm(&self) -> bool {
        self.evm_address != [0u8; 20]
    }

    pub fn evm_nonce_mut(&mut self, chain_id: u64) -> Result<&mut EvmNonce> {
        if let Some(i) = self.evm_nonces.iter().position(|n| n.chain_id == chain_id) {
            return Ok(&mut self.evm_nonces[i]);
        }
        require!(self.evm_nonces.len() < MAX_EVM_CHAINS, crate::error::IkaError::UnknownChain);
        self.evm_nonces.push(EvmNonce { chain_id, nonce: 0, delegated: false });
        let last = self.evm_nonces.len() - 1;
        Ok(&mut self.evm_nonces[last])
    }
}

// ── Intent ───────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum IntentKind {
    Send,
    Swap,
    EvmSetup,
    EvmCancelRecovery,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum IntentStatus {
    Proposed,
    Approved,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum EvmParams {
    /// Self-paid EIP-1559 transaction from the dWallet EOA. No contract needed.
    Direct {
        nonce: u64,
        gas_limit: u64,
        max_fee_per_gas: u64,
        max_priority_fee_per_gas: u64,
    },
    /// `IkaAccount.execute` signed by the dWallet and relayed (EIP-7702 account).
    Delegated { deadline: i64 },
    /// `evm_setup`: 7702 authorization + `Init`.
    Setup { eoa_nonce: u64 },
    /// `evm_cancel_recovery`.
    CancelRecovery { deadline: i64 },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct BtcInput {
    /// Internal byte order (reverse of the displayed txid).
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct BtcParams {
    #[max_len(4)]
    pub inputs: Vec<BtcInput>,
    pub fee: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct IntentParams {
    pub kind: IntentKind,
    pub chain: Chain,
    pub asset: [u8; 20],
    /// EVM: 20-byte address. Bitcoin: recipient scriptPubKey.
    #[max_len(MAX_ADDR)]
    pub to: Vec<u8>,
    pub amount: u64,
    pub evm: Option<EvmParams>,
    pub btc: Option<BtcParams>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct Approval {
    /// keccak256(preimage): the Ika `MessageApproval` key.
    pub message_digest: [u8; 32],
    /// The 32-byte hash that is actually signed (EIP-712 / tx hash / BIP143 sighash).
    pub final_digest: [u8; 32],
    pub scheme: u16,
    pub message_approval: Pubkey,
}

/// Spend-window usage recorded at propose time so `cancel_intent` can release it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace)]
pub struct Charge {
    pub index: u8,
    pub window_start: i64,
    pub amount: u64,
}

pub const NO_CHARGE: u8 = u8::MAX;

#[account]
#[derive(InitSpace)]
pub struct Intent {
    pub account: Pubkey,
    pub nonce: u64,
    pub params: IntentParams,
    pub status: IntentStatus,
    pub created_at: i64,
    pub executable_at: i64,
    /// EVM `IkaAccount` nonce bound into the signed digest (delegated / cancel-recovery).
    pub evm_nonce: u64,
    pub limit_charge: Charge,
    pub swap_charge: Charge,
    #[max_len(MAX_APPROVALS)]
    pub approvals: Vec<Approval>,
    pub bump: u8,
}

/// One per dWallet: a dWallet can be registered to exactly one account.
#[account]
#[derive(InitSpace)]
pub struct DWalletClaim {
    pub account: Pubkey,
    pub dwallet: Pubkey,
    pub bump: u8,
}
