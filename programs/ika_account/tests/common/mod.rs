#![allow(dead_code)]
//! LiteSVM harness: ika_account + mock_dwallet + test_cpi_owner.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::{AccountMeta, Instruction}, system_program},
    AccountDeserialize, AnchorSerialize, InstructionData, ToAccountMetas,
};
use ika_account::state::*;
use ika_account::{ConfigArgs, CreateAccountArgs};
use k256::ecdsa::SigningKey;
use litesvm::{types::TransactionResult, LiteSVM};
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub const DEPLOY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy");
pub const ETH_CHAIN_ID: u64 = 11155111;
pub const BASE_CHAIN_ID: u64 = 84532;
pub const IMPL_ETH: [u8; 20] = [0xE1; 20];
pub const IMPL_BASE: [u8; 20] = [0xBA; 20];
pub const USDC_BASE: [u8; 20] = [0x5C; 20];
pub const START_TS: i64 = 1_800_000_000;

pub fn mock_id() -> Pubkey {
    mock_dwallet::ID
}

pub fn cpi_owner_id() -> Pubkey {
    test_cpi_owner::ID
}

pub fn cpi_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__ika_cpi_authority"], &ika_account::ID).0
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &ika_account::ID).0
}

pub fn account_pda(owner: &Pubkey, index: u16) -> Pubkey {
    Pubkey::find_program_address(&[ACCOUNT_SEED, owner.as_ref(), &index.to_le_bytes()], &ika_account::ID).0
}

pub fn intent_pda(account: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(&[INTENT_SEED, account.as_ref(), &nonce.to_le_bytes()], &ika_account::ID).0
}

pub fn coordinator() -> Pubkey {
    Pubkey::find_program_address(&[b"dwallet_coordinator"], &mock_id()).0
}

pub fn dwallet_pda(pk: &[u8; 33]) -> Pubkey {
    let payload = ika_account::dwallet::dwallet_payload(0, pk);
    Pubkey::find_program_address(&[b"dwallet", &payload[..32], &payload[32..]], &mock_id()).0
}

pub fn err_code(e: ika_account::error::IkaError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

pub fn compute_budget_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: "ComputeBudget111111111111111111111111111111".parse().unwrap(),
        accounts: vec![],
        data,
    }
}

pub struct Key {
    pub sk: SigningKey,
    pub compressed: [u8; 33],
    pub y: [u8; 32],
    pub x: [u8; 32],
}

impl Key {
    pub fn random() -> Self {
        Self::from(SigningKey::random(&mut rand::thread_rng()))
    }

    pub fn from(sk: SigningKey) -> Self {
        let vk = sk.verifying_key();
        let c = vk.to_encoded_point(true);
        let u = vk.to_encoded_point(false);
        let mut compressed = [0u8; 33];
        compressed.copy_from_slice(c.as_bytes());
        let mut x = [0u8; 32];
        let mut y = [0u8; 32];
        x.copy_from_slice(&u.as_bytes()[1..33]);
        y.copy_from_slice(&u.as_bytes()[33..65]);
        Self { sk, compressed, y, x }
    }

    pub fn evm_address(&self) -> [u8; 20] {
        ika_account::digest::evm_address(&self.x, &self.y)
    }
}

pub fn default_policy() -> Policy {
    Policy {
        limits: vec![],
        allowlist_enabled: false,
        allowlist: vec![],
        delay_thresholds: vec![],
        delay_s: 0,
        swaps_enabled: true,
        swap_limits: vec![],
        max_btc_fee_sats: 100_000,
        max_evm_fee_wei: 10_000_000_000_000_000, // 0.01 ETH
        policy_change_delay_s: 0,
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
}

pub struct TestAccount {
    pub owner: Keypair,
    pub account: Pubkey,
    pub key: Key,          // the dWallet key (DKG modes) or the EVM key (recoverable)
    pub btc_key: Option<Key>, // recoverable mode only
    pub recovery: Option<Key>,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        for (id, name) in [
            (ika_account::ID, "ika_account"),
            (mock_id(), "mock_dwallet"),
            (cpi_owner_id(), "test_cpi_owner"),
        ] {
            svm.add_program_from_file(id, format!("{DEPLOY}/{name}.so")).unwrap();
        }
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        let mut env = Self { svm, payer };
        env.set_time(START_TS);
        env.mock_init();
        env.init_config(vec![
            EvmChainConfig { chain: Chain::Ethereum, chain_id: ETH_CHAIN_ID, implementation: IMPL_ETH },
            EvmChainConfig { chain: Chain::Base, chain_id: BASE_CHAIN_ID, implementation: IMPL_BASE },
        ]);
        env
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, ts: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp = ts;
        self.svm.set_sysvar(&c);
    }

    pub fn warp(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let mut all: Vec<&Keypair> = vec![&self.payer];
        for s in signers {
            if s.pubkey() != self.payer.pubkey() {
                all.push(s);
            }
        }
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &bh);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
        self.svm.send_transaction(tx)
    }

    pub fn send_ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) {
        if let Err(e) = self.send(ixs, signers) {
            panic!("tx failed: {:?}\n{}", e.err, e.meta.logs.join("\n"));
        }
    }

    pub fn expect_err(&mut self, ixs: &[Instruction], signers: &[&Keypair], code: u32) {
        match self.send(ixs, signers) {
            Ok(_) => panic!("expected error {code}, tx succeeded"),
            Err(e) => {
                let s = format!("{:?}", e.err);
                assert!(s.contains(&format!("Custom({code})")), "expected Custom({code}), got {s}\n{}", e.meta.logs.join("\n"));
            }
        }
    }

    pub fn fetch<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self.svm.get_account(key).expect("account missing");
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn mock_init(&mut self) {
        let ix = Instruction::new_with_bytes(
            mock_id(),
            &mock_dwallet::instruction::MockInit {}.data(),
            mock_dwallet::accounts::MockInit { coordinator: coordinator(), payer: self.payer.pubkey(), system_program: system_program::ID }
                .to_account_metas(None),
        );
        let p = self.payer.insecure_clone();
        self.send_ok(&[ix], &[&p]);
    }

    pub fn config_ix(&self, evm_chains: Vec<EvmChainConfig>, update: bool) -> Instruction {
        let args = ConfigArgs {
            dwallet_program: mock_id(),
            btc_network: BtcNetwork::Regtest,
            max_btc_inputs: 4,
            evm_chains,
            tokens: vec![TokenConfig { chain: Chain::Base, address: USDC_BASE }],
        };
        if update {
            Instruction::new_with_bytes(
                ika_account::ID,
                &ika_account::instruction::UpdateConfig { args }.data(),
                ika_account::accounts::UpdateConfig { config: config_pda(), admin: self.payer.pubkey() }.to_account_metas(None),
            )
        } else {
            Instruction::new_with_bytes(
                ika_account::ID,
                &ika_account::instruction::InitializeConfig { args }.data(),
                ika_account::accounts::InitializeConfig { config: config_pda(), admin: self.payer.pubkey(), system_program: system_program::ID }
                    .to_account_metas(None),
            )
        }
    }

    fn init_config(&mut self, chains: Vec<EvmChainConfig>) {
        let ix = self.config_ix(chains, false);
        let p = self.payer.insecure_clone();
        self.send_ok(&[ix], &[&p]);
    }

    pub fn update_config(&mut self, chains: Vec<EvmChainConfig>) {
        let ix = self.config_ix(chains, true);
        let p = self.payer.insecure_clone();
        self.send_ok(&[ix], &[&p]);
    }

    /// Stand-in for DKG: create a dWallet whose authority is `authority`.
    pub fn create_dwallet(&mut self, key: &Key, authority: &Pubkey) -> Pubkey {
        let dw = dwallet_pda(&key.compressed);
        let ix = Instruction::new_with_bytes(
            mock_id(),
            &mock_dwallet::instruction::MockCreateDwallet { public_key: key.compressed, authority: *authority, is_imported: false }.data(),
            mock_dwallet::accounts::MockCreateDWallet { dwallet: dw, payer: self.payer.pubkey(), system_program: system_program::ID }
                .to_account_metas(None),
        );
        let p = self.payer.insecure_clone();
        self.send_ok(&[ix], &[&p]);
        dw
    }

    pub fn transfer_ownership_ix(authority: &Pubkey, dwallet: &Pubkey, new_authority: &Pubkey) -> Instruction {
        let mut data = vec![24u8];
        data.extend_from_slice(new_authority.as_ref());
        Instruction {
            program_id: mock_id(),
            accounts: vec![AccountMeta::new_readonly(*authority, true), AccountMeta::new(*dwallet, false)],
            data,
        }
    }

    pub fn create_account_ix(&self, owner: &Pubkey, args: CreateAccountArgs) -> Instruction {
        Instruction::new_with_bytes(
            ika_account::ID,
            &ika_account::instruction::CreateAccount { args: args.clone() }.data(),
            ika_account::accounts::CreateAccount {
                account: account_pda(owner, args.index),
                owner: *owner,
                payer: self.payer.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn register_ix(owner: &Pubkey, account: &Pubkey, dwallet: &Pubkey, role: DWalletRole, y: [u8; 32]) -> Instruction {
        Self::register_ix_payer(owner, account, dwallet, role, y, owner)
    }

    pub fn register_ix_payer(owner: &Pubkey, account: &Pubkey, dwallet: &Pubkey, role: DWalletRole, y: [u8; 32], payer: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            ika_account::ID,
            &ika_account::instruction::RegisterDwallet { role, evm_pubkey_y: y }.data(),
            ika_account::accounts::RegisterDWallet {
                account: *account,
                owner: *owner,
                config: config_pda(),
                dwallet: *dwallet,
                cpi_authority: cpi_authority(),
                claim: Pubkey::find_program_address(&[CLAIM_SEED, dwallet.as_ref()], &ika_account::ID).0,
                payer: *payer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Create an account with keypair owner, create + register its dWallets.
    pub fn setup_account(&mut self, mode: Mode, policy: Policy) -> TestAccount {
        let owner = Keypair::new();
        self.svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
        let recovery = (mode == Mode::EnforcedRecovery).then(Key::random);
        let args = CreateAccountArgs {
            index: 0,
            mode,
            user_share: UserShare::Public,
            ika_user: owner.pubkey(),
            policy,
            recovery: recovery.as_ref().map(|r| RecoveryParams {
                pubkey: r.compressed,
                pubkey_y: r.y,
                csv_blocks: 6,
                recovery_delay_s: 3600,
            }),
        };
        let ix = self.create_account_ix(&owner.pubkey(), args);
        self.send_ok(&[ix], &[&owner]);
        let account = account_pda(&owner.pubkey(), 0);

        let key = Key::random();
        let btc_key = (mode == Mode::Recoverable).then(Key::random);
        let roles: Vec<(&Key, DWalletRole)> = match &btc_key {
            Some(b) => vec![(&key, DWalletRole::Evm), (b, DWalletRole::Btc)],
            None => vec![(&key, DWalletRole::Both)],
        };
        let mut ixs = vec![];
        let mut dws = vec![];
        for (k, role) in roles {
            let dw = self.create_dwallet(k, &owner.pubkey());
            dws.push((dw, role, k.y));
        }
        for (dw, role, y) in dws {
            ixs.push(Self::transfer_ownership_ix(&owner.pubkey(), &dw, &cpi_authority()));
            ixs.push(Self::register_ix(&owner.pubkey(), &account, &dw, role, y));
        }
        self.send_ok(&ixs, &[&owner]);
        TestAccount { owner, account, key, btc_key, recovery }
    }

    pub fn propose_ix(&self, owner: &Pubkey, account: &Pubkey, params: IntentParams) -> (Instruction, Pubkey) {
        let acct: IkaAccount = self.fetch(account);
        let intent = intent_pda(account, acct.intent_nonce);
        let ix = Instruction::new_with_bytes(
            ika_account::ID,
            &ika_account::instruction::ProposeIntent { params }.data(),
            ika_account::accounts::ProposeIntent {
                account: *account,
                owner: *owner,
                config: config_pda(),
                intent,
                payer: self.payer.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        (ix, intent)
    }

    pub fn propose(&mut self, t: &TestAccount, params: IntentParams) -> Pubkey {
        let (ix, intent) = self.propose_ix(&t.owner.pubkey(), &t.account, params);
        let o = t.owner.insecure_clone();
        self.send_ok(&[ix], &[&o]);
        intent
    }

    pub fn propose_err(&mut self, t: &TestAccount, params: IntentParams, code: u32) {
        let (ix, _) = self.propose_ix(&t.owner.pubkey(), &t.account, params);
        let o = t.owner.insecure_clone();
        self.expect_err(&[ix], &[&o], code);
    }

    pub fn cancel(&mut self, t: &TestAccount, intent: &Pubkey) {
        let ix = Instruction::new_with_bytes(
            ika_account::ID,
            &ika_account::instruction::CancelIntent {}.data(),
            ika_account::accounts::CancelIntent { account: t.account, owner: t.owner.pubkey(), intent: *intent }.to_account_metas(None),
        );
        let o = t.owner.insecure_clone();
        self.send_ok(&[ix], &[&o]);
    }

    /// Build approve_intent; the MessageApproval PDAs come from preview_digests.
    pub fn approve_ix(&mut self, account: &Pubkey, intent: &Pubkey) -> Instruction {
        let acct: IkaAccount = self.fetch(account);
        let it: Intent = self.fetch(intent);
        let entry = acct.dwallet_for(it.params.chain).unwrap().clone();
        let evm_nonce = match it.params.evm {
            Some(EvmParams::Delegated { .. }) | Some(EvmParams::CancelRecovery { .. }) => {
                let cfg: Config = self.fetch(&config_pda());
                let cid = cfg.evm_chain(it.params.chain).unwrap().chain_id;
                acct.evm_nonces.iter().find(|n| n.chain_id == cid).map(|n| n.nonce).unwrap_or(0)
            }
            _ => 0,
        };
        let previews = self.preview(account, it.params.clone(), evm_nonce);
        let mut metas = ika_account::accounts::ApproveIntent {
            account: *account,
            config: config_pda(),
            intent: *intent,
            dwallet: entry.dwallet,
            coordinator: coordinator(),
            cpi_authority: cpi_authority(),
            caller_program: ika_account::ID,
            dwallet_program: mock_id(),
            payer: self.payer.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        for p in previews {
            let (ma, _) = ika_account::dwallet::find_message_approval(&mock_id(), 0, &entry.pubkey, p.scheme, &p.message_digest);
            metas.push(AccountMeta::new(ma, false));
        }
        Instruction::new_with_bytes(ika_account::ID, &ika_account::instruction::ApproveIntent {}.data(), metas)
    }

    pub fn approve(&mut self, account: &Pubkey, intent: &Pubkey) {
        let ix = self.approve_ix(account, intent);
        let p = self.payer.insecure_clone();
        self.send_ok(&[compute_budget_ix(1_400_000), ix], &[&p]);
    }

    pub fn preview(&mut self, account: &Pubkey, params: IntentParams, evm_nonce: u64) -> Vec<ika_account::DigestPreview> {
        let ix = Instruction::new_with_bytes(
            ika_account::ID,
            &ika_account::instruction::PreviewDigests { params, evm_nonce }.data(),
            ika_account::accounts::PreviewDigests { account: *account, config: config_pda() }.to_account_metas(None),
        );
        self.svm.expire_blockhash();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[compute_budget_ix(1_400_000), ix], Some(&self.payer.pubkey()), &bh);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.payer]).unwrap();
        let sim = self.svm.simulate_transaction(tx).unwrap_or_else(|e| panic!("preview failed: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        let data = sim.meta.return_data.data;
        <Vec<ika_account::DigestPreview> as anchor_lang::AnchorDeserialize>::deserialize(&mut data.as_slice()).unwrap()
    }

    pub fn policy_ix(t: &TestAccount, name: &str, next: Option<Policy>) -> Instruction {
        match name {
            "propose" => Instruction::new_with_bytes(
                ika_account::ID,
                &ika_account::instruction::ProposePolicy { next: next.unwrap() }.data(),
                ika_account::accounts::OwnerOnly { account: t.account, owner: t.owner.pubkey() }.to_account_metas(None),
            ),
            "apply" => Instruction::new_with_bytes(
                ika_account::ID,
                &ika_account::instruction::ApplyPolicy {}.data(),
                ika_account::accounts::Permissionless { account: t.account }.to_account_metas(None),
            ),
            _ => Instruction::new_with_bytes(
                ika_account::ID,
                &ika_account::instruction::CancelPolicy {}.data(),
                ika_account::accounts::OwnerOnly { account: t.account, owner: t.owner.pubkey() }.to_account_metas(None),
            ),
        }
    }

    pub fn read_message_approval(&self, ma: &Pubkey) -> Vec<u8> {
        self.svm.get_account(ma).expect("MessageApproval missing").data
    }
}

pub fn evm_send(chain: Chain, asset: [u8; 20], to: [u8; 20], amount: u64, evm: EvmParams) -> IntentParams {
    IntentParams { kind: IntentKind::Send, chain, asset, to: to.to_vec(), amount, evm: Some(evm), btc: None }
}

pub fn direct(nonce: u64) -> EvmParams {
    EvmParams::Direct { nonce, gas_limit: 21_000, max_fee_per_gas: 2_000_000_000, max_priority_fee_per_gas: 1_000_000_000 }
}

pub fn btc_send(to_script: Vec<u8>, amount: u64, inputs: Vec<BtcInput>, fee: u64) -> IntentParams {
    IntentParams {
        kind: IntentKind::Send,
        chain: Chain::Bitcoin,
        asset: NATIVE_ASSET,
        to: to_script,
        amount,
        evm: None,
        btc: Some(BtcParams { inputs, fee }),
    }
}

pub fn utxo(n: u8, value: u64) -> BtcInput {
    BtcInput { txid: [n; 32], vout: n as u32, value }
}

pub fn serialize<T: AnchorSerialize>(t: &T) -> Vec<u8> {
    let mut v = vec![];
    t.serialize(&mut v).unwrap();
    v
}
