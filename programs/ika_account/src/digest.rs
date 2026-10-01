//! Digest serialization: RLP, EIP-712, EIP-1559, EIP-7702 and BIP143.
//!
//! Everything here is allocation-free and uses only the Solana `keccak` and
//! `sha256` hashers (syscalls on-chain, pure Rust off-chain), so the same code
//! runs in the program and in native parity tests.
//!
//! Every builder returns a *preimage*. Ika approvals are keyed by
//! `keccak256(preimage)` and the network applies the scheme's own hash
//! (Keccak256 for EVM, double SHA-256 for BIP143) before signing. The
//! `final_digest` helpers compute that last hash so parity tests can compare
//! the 32-byte value that actually gets signed.

use ripemd::{Digest as _, Ripemd160};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestError {
    BufferOverflow,
    InvalidPoint,
    InvalidScriptNumber,
}

pub type DResult<T> = core::result::Result<T, DigestError>;

// ── Hashing ──────────────────────────────────────────────────────────────

pub fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    solana_keccak_hasher::hashv(parts).to_bytes()
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    solana_sha256_hasher::hashv(parts).to_bytes()
}

pub fn sha256d(data: &[u8]) -> [u8; 32] {
    let first = sha256(&[data]);
    sha256(&[&first])
}

pub fn hash160(data: &[u8]) -> [u8; 20] {
    let s = sha256(&[data]);
    let r = Ripemd160::digest(s);
    let mut out = [0u8; 20];
    out.copy_from_slice(&r);
    out
}

// ── Fixed-capacity buffer ────────────────────────────────────────────────

#[derive(Clone)]
pub struct Buf<const N: usize> {
    data: [u8; N],
    len: usize,
}

impl<const N: usize> Buf<N> {
    pub const fn new() -> Self {
        Self { data: [0u8; N], len: 0 }
    }

    pub fn put(&mut self, bytes: &[u8]) -> DResult<()> {
        let end = self
            .len
            .checked_add(bytes.len())
            .ok_or(DigestError::BufferOverflow)?;
        if end > N {
            return Err(DigestError::BufferOverflow);
        }
        self.data[self.len..end].copy_from_slice(bytes);
        self.len = end;
        Ok(())
    }

    pub fn byte(&mut self, b: u8) -> DResult<()> {
        self.put(&[b])
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.data[..self.len]
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl<const N: usize> Default for Buf<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// Maximum preimage size produced by this module (BIP143 with a P2WSH script
/// code is the largest at ~260 bytes; an EIP-1559 ERC-20 transfer is ~150).
pub const MAX_PREIMAGE: usize = 320;
pub type Preimage = Buf<MAX_PREIMAGE>;

// ── Integer helpers ──────────────────────────────────────────────────────

pub fn u256_be(v: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&v.to_be_bytes());
    out
}

pub fn addr_word(addr: &[u8; 20]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(addr);
    out
}

// ── RLP ──────────────────────────────────────────────────────────────────

fn be_trimmed(v: u128, out: &mut [u8; 16]) -> usize {
    *out = v.to_be_bytes();
    let lead = (v.leading_zeros() / 8) as usize;
    16 - lead
}

pub fn rlp_uint<const N: usize>(buf: &mut Buf<N>, v: u128) -> DResult<()> {
    if v == 0 {
        return buf.byte(0x80);
    }
    let mut tmp = [0u8; 16];
    let n = be_trimmed(v, &mut tmp);
    rlp_bytes(buf, &tmp[16 - n..])
}

fn rlp_len_prefix<const N: usize>(buf: &mut Buf<N>, short_base: u8, len: usize) -> DResult<()> {
    if len <= 55 {
        buf.byte(short_base + len as u8)
    } else {
        let mut tmp = [0u8; 16];
        let n = be_trimmed(len as u128, &mut tmp);
        buf.byte(short_base + 55 + n as u8)?;
        buf.put(&tmp[16 - n..])
    }
}

pub fn rlp_bytes<const N: usize>(buf: &mut Buf<N>, b: &[u8]) -> DResult<()> {
    if b.len() == 1 && b[0] < 0x80 {
        return buf.byte(b[0]);
    }
    rlp_len_prefix(buf, 0x80, b.len())?;
    buf.put(b)
}

pub fn rlp_list<const N: usize, const M: usize>(buf: &mut Buf<N>, payload: &Buf<M>) -> DResult<()> {
    rlp_len_prefix(buf, 0xc0, payload.len())?;
    buf.put(payload.as_slice())
}

// ── EVM ──────────────────────────────────────────────────────────────────

pub const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
pub const MAX_EVM_CALLDATA: usize = 68;

pub fn erc20_transfer_calldata(to: &[u8; 20], amount: u64) -> [u8; 68] {
    let mut out = [0u8; 68];
    out[..4].copy_from_slice(&ERC20_TRANSFER_SELECTOR);
    out[4..36].copy_from_slice(&addr_word(to));
    out[36..].copy_from_slice(&u256_be(amount as u128));
    out
}

/// The (to, value, data) triple an EVM send resolves to.
pub struct EvmCall {
    pub to: [u8; 20],
    pub value: u64,
    pub data: Buf<MAX_EVM_CALLDATA>,
}

/// Native sends go straight to the recipient with empty data; ERC-20 sends
/// call `token.transfer(recipient, amount)` with zero value.
pub fn evm_call(asset: &[u8; 20], to: &[u8; 20], amount: u64) -> DResult<EvmCall> {
    let mut data = Buf::new();
    if *asset == [0u8; 20] {
        Ok(EvmCall { to: *to, value: amount, data })
    } else {
        data.put(&erc20_transfer_calldata(to, amount))?;
        Ok(EvmCall { to: *asset, value: 0, data })
    }
}

pub const DOMAIN_TYPE: &[u8] =
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
pub const EXECUTE_TYPE: &[u8] =
    b"Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)";
pub const INIT_TYPE: &[u8] = b"Init(address recoveryKey,uint256 recoveryDelay)";
pub const CANCEL_RECOVERY_TYPE: &[u8] = b"CancelRecovery(uint256 nonce,uint256 deadline)";

pub fn domain_separator(chain_id: u64, verifying_contract: &[u8; 20]) -> [u8; 32] {
    keccak(&[
        &keccak(&[DOMAIN_TYPE]),
        &keccak(&[b"IkaAccount"]),
        &keccak(&[b"1"]),
        &u256_be(chain_id as u128),
        &addr_word(verifying_contract),
    ])
}

fn eip712_preimage(chain_id: u64, account: &[u8; 20], struct_hash: &[u8; 32]) -> DResult<Preimage> {
    let mut p = Preimage::new();
    p.put(&[0x19, 0x01])?;
    p.put(&domain_separator(chain_id, account))?;
    p.put(struct_hash)?;
    Ok(p)
}

pub fn execute_preimage(
    chain_id: u64,
    account: &[u8; 20],
    call: &EvmCall,
    nonce: u64,
    deadline: u64,
) -> DResult<Preimage> {
    let sh = keccak(&[
        &keccak(&[EXECUTE_TYPE]),
        &addr_word(&call.to),
        &u256_be(call.value as u128),
        &keccak(&[call.data.as_slice()]),
        &u256_be(nonce as u128),
        &u256_be(deadline as u128),
    ]);
    eip712_preimage(chain_id, account, &sh)
}

pub fn init_preimage(
    chain_id: u64,
    account: &[u8; 20],
    recovery_key: &[u8; 20],
    recovery_delay: u64,
) -> DResult<Preimage> {
    let sh = keccak(&[
        &keccak(&[INIT_TYPE]),
        &addr_word(recovery_key),
        &u256_be(recovery_delay as u128),
    ]);
    eip712_preimage(chain_id, account, &sh)
}

pub fn cancel_recovery_preimage(
    chain_id: u64,
    account: &[u8; 20],
    nonce: u64,
    deadline: u64,
) -> DResult<Preimage> {
    let sh = keccak(&[
        &keccak(&[CANCEL_RECOVERY_TYPE]),
        &u256_be(nonce as u128),
        &u256_be(deadline as u128),
    ]);
    eip712_preimage(chain_id, account, &sh)
}

/// EIP-7702 authorization: `0x05 ‖ rlp([chain_id, address, nonce])`.
pub fn authorization_preimage(chain_id: u64, implementation: &[u8; 20], eoa_nonce: u64) -> DResult<Preimage> {
    let mut payload = Buf::<64>::new();
    rlp_uint(&mut payload, chain_id as u128)?;
    rlp_bytes(&mut payload, implementation)?;
    rlp_uint(&mut payload, eoa_nonce as u128)?;
    let mut p = Preimage::new();
    p.byte(0x05)?;
    rlp_list(&mut p, &payload)?;
    Ok(p)
}

pub struct Eip1559Fields {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u64,
    pub max_fee_per_gas: u64,
    pub gas_limit: u64,
}

/// EIP-1559 signing payload: `0x02 ‖ rlp([chain_id, nonce, max_priority_fee,
/// max_fee, gas_limit, to, value, data, access_list])` with an empty access list.
pub fn eip1559_preimage(f: &Eip1559Fields, call: &EvmCall) -> DResult<Preimage> {
    let mut payload = Buf::<256>::new();
    rlp_uint(&mut payload, f.chain_id as u128)?;
    rlp_uint(&mut payload, f.nonce as u128)?;
    rlp_uint(&mut payload, f.max_priority_fee_per_gas as u128)?;
    rlp_uint(&mut payload, f.max_fee_per_gas as u128)?;
    rlp_uint(&mut payload, f.gas_limit as u128)?;
    rlp_bytes(&mut payload, &call.to)?;
    rlp_uint(&mut payload, call.value as u128)?;
    rlp_bytes(&mut payload, call.data.as_slice())?;
    payload.byte(0xc0)?; // empty access list
    let mut p = Preimage::new();
    p.byte(0x02)?;
    rlp_list(&mut p, &payload)?;
    Ok(p)
}

pub fn evm_address(x: &[u8; 32], y: &[u8; 32]) -> [u8; 20] {
    let h = keccak(&[x, y]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&h[12..]);
    out
}

// ── secp256k1 point check ────────────────────────────────────────────────
//
// The program only has compressed keys (33 bytes) from Ika. Deriving an EVM
// address needs the uncompressed Y. Decompressing on-chain means a modular
// square root; instead the client supplies Y and we verify it: parity matches
// the prefix and y² = x³ + 7 (mod p). Only mulmod is needed.

type U256 = [u64; 4]; // little-endian limbs

const P: U256 = [
    0xFFFF_FFFE_FFFF_FC2F,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_FFFF_FFFF,
];
const P_FOLD: u64 = 0x1_0000_03D1; // 2^256 mod p

fn from_be(b: &[u8; 32]) -> U256 {
    let mut out = [0u64; 4];
    for (i, limb) in out.iter_mut().enumerate() {
        let start = 32 - 8 * (i + 1);
        let mut w = [0u8; 8];
        w.copy_from_slice(&b[start..start + 8]);
        *limb = u64::from_be_bytes(w);
    }
    out
}

fn geq(a: &U256, b: &U256) -> bool {
    for i in (0..4).rev() {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

fn sub_in_place(a: &mut U256, b: &U256) {
    let mut borrow = 0u64;
    for i in 0..4 {
        let (d1, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d1.overflowing_sub(borrow);
        a[i] = d2;
        borrow = (b1 || b2) as u64;
    }
}

fn mul_mod_p(a: &U256, b: &U256) -> U256 {
    let mut t = [0u64; 8];
    for i in 0..4 {
        let mut carry: u128 = 0;
        for j in 0..4 {
            let v = (t[i + j] as u128) + (a[i] as u128) * (b[j] as u128) + carry;
            t[i + j] = v as u64;
            carry = v >> 64;
        }
        t[i + 4] = carry as u64;
    }
    // Fold the high half: hi·2^256 ≡ hi·P_FOLD (mod p).
    let mut r = [0u64; 5];
    let mut carry: u128 = 0;
    for i in 0..4 {
        let v = (t[i] as u128) + (t[i + 4] as u128) * (P_FOLD as u128) + carry;
        r[i] = v as u64;
        carry = v >> 64;
    }
    r[4] = carry as u64;
    let mut out = [0u64; 4];
    let mut carry: u128 = (r[4] as u128) * (P_FOLD as u128);
    for i in 0..4 {
        let v = (r[i] as u128) + carry;
        out[i] = v as u64;
        carry = v >> 64;
    }
    if carry > 0 {
        let mut c: u128 = (carry as u64 as u128) * (P_FOLD as u128);
        for limb in out.iter_mut() {
            let v = (*limb as u128) + c;
            *limb = v as u64;
            c = v >> 64;
        }
    }
    while geq(&out, &P) {
        sub_in_place(&mut out, &P);
    }
    out
}

fn add_small_mod_p(a: &U256, s: u64) -> U256 {
    let mut out = *a;
    let mut carry = s as u128;
    for limb in out.iter_mut() {
        let v = (*limb as u128) + carry;
        *limb = v as u64;
        carry = v >> 64;
    }
    if carry > 0 {
        // wrapped past 2^256: add 2^256 mod p
        let mut c = P_FOLD as u128;
        for limb in out.iter_mut() {
            let v = (*limb as u128) + c;
            *limb = v as u64;
            c = v >> 64;
        }
    }
    while geq(&out, &P) {
        sub_in_place(&mut out, &P);
    }
    out
}

/// Verify that `y` is the Y coordinate of the compressed point `compressed`.
/// Returns the 64-byte uncompressed body (x ‖ y) on success.
pub fn verify_uncompressed(compressed: &[u8; 33], y: &[u8; 32]) -> DResult<[u8; 64]> {
    let prefix = compressed[0];
    if prefix != 0x02 && prefix != 0x03 {
        return Err(DigestError::InvalidPoint);
    }
    if (y[31] & 1) != (prefix & 1) {
        return Err(DigestError::InvalidPoint);
    }
    let mut xb = [0u8; 32];
    xb.copy_from_slice(&compressed[1..]);
    let x = from_be(&xb);
    let yv = from_be(y);
    if geq(&x, &P) || geq(&yv, &P) {
        return Err(DigestError::InvalidPoint);
    }
    let lhs = mul_mod_p(&yv, &yv);
    let x3 = mul_mod_p(&mul_mod_p(&x, &x), &x);
    let rhs = add_small_mod_p(&x3, 7);
    if lhs != rhs {
        return Err(DigestError::InvalidPoint);
    }
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&xb);
    out[32..].copy_from_slice(y);
    Ok(out)
}

// ── Bitcoin ──────────────────────────────────────────────────────────────

pub const BTC_TX_VERSION: u32 = 2;
pub const BTC_LOCKTIME: u32 = 0;
/// nSequence for dWallet-signed inputs: final-ish, RBF enabled, no relative lock.
pub const BTC_SEQUENCE: u32 = 0xFFFF_FFFD;
pub const SIGHASH_ALL: u32 = 1;
pub const BTC_DUST: u64 = 546;
pub const MAX_BTC_INPUTS: usize = 4;
pub const MAX_SCRIPT: usize = 34;

#[derive(Clone, Copy)]
pub struct BtcOutpoint {
    /// Transaction id in internal byte order (reverse of the displayed hex).
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
}

pub type WitnessScript = Buf<80>;

/// Minimal CScriptNum push for 1..=65535.
fn push_script_num<const N: usize>(buf: &mut Buf<N>, n: u16) -> DResult<()> {
    if n == 0 {
        return Err(DigestError::InvalidScriptNumber);
    }
    if n <= 16 {
        return buf.byte(0x50 + n as u8);
    }
    let le = n.to_le_bytes();
    let mut bytes = [0u8; 3];
    let mut len = if le[1] == 0 { 1 } else { 2 };
    bytes[..2].copy_from_slice(&le);
    if bytes[len - 1] & 0x80 != 0 {
        bytes[len] = 0x00;
        len += 1;
    }
    buf.byte(len as u8)?;
    buf.put(&bytes[..len])
}

/// `OP_IF <dwallet> OP_CHECKSIG OP_ELSE <csv> OP_CSV OP_DROP <recovery> OP_CHECKSIG OP_ENDIF`
pub fn recovery_witness_script(dwallet: &[u8; 33], csv_blocks: u16, recovery: &[u8; 33]) -> DResult<WitnessScript> {
    let mut s = WitnessScript::new();
    s.byte(0x63)?; // OP_IF
    s.byte(33)?;
    s.put(dwallet)?;
    s.byte(0xac)?; // OP_CHECKSIG
    s.byte(0x67)?; // OP_ELSE
    push_script_num(&mut s, csv_blocks)?;
    s.byte(0xb2)?; // OP_CHECKSEQUENCEVERIFY
    s.byte(0x75)?; // OP_DROP
    s.byte(33)?;
    s.put(recovery)?;
    s.byte(0xac)?; // OP_CHECKSIG
    s.byte(0x68)?; // OP_ENDIF
    Ok(s)
}

pub fn p2wpkh_script(pkh: &[u8; 20]) -> Buf<MAX_SCRIPT> {
    let mut s = Buf::new();
    // Infallible: 22 bytes into a 34-byte buffer.
    let _ = s.put(&[0x00, 0x14]);
    let _ = s.put(pkh);
    s
}

pub fn p2wsh_script(witness_script: &[u8]) -> Buf<MAX_SCRIPT> {
    let mut s = Buf::new();
    let _ = s.put(&[0x00, 0x20]);
    let _ = s.put(&sha256(&[witness_script]));
    s
}

/// BIP143 scriptCode (with its length prefix).
pub enum ScriptCode<'a> {
    P2wpkh(&'a [u8; 20]),
    P2wsh(&'a [u8]),
}

fn write_script_code<const N: usize>(buf: &mut Buf<N>, sc: &ScriptCode) -> DResult<()> {
    match sc {
        ScriptCode::P2wpkh(pkh) => {
            buf.put(&[0x19, 0x76, 0xa9, 0x14])?;
            buf.put(*pkh)?;
            buf.put(&[0x88, 0xac])
        }
        ScriptCode::P2wsh(ws) => {
            // Witness scripts here are < 0xfd bytes, so a one-byte varint.
            buf.byte(ws.len() as u8)?;
            buf.put(ws)
        }
    }
}

pub struct BtcOutput<'a> {
    pub value: u64,
    pub script: &'a [u8],
}

pub fn hash_outputs(outputs: &[BtcOutput]) -> DResult<[u8; 32]> {
    let mut b = Buf::<{ 2 * (8 + 1 + MAX_SCRIPT) }>::new();
    for o in outputs {
        b.put(&o.value.to_le_bytes())?;
        b.byte(o.script.len() as u8)?;
        b.put(o.script)?;
    }
    Ok(sha256d(b.as_slice()))
}

pub struct BtcSighashContext {
    pub hash_prevouts: [u8; 32],
    pub hash_sequence: [u8; 32],
    pub hash_outputs: [u8; 32],
}

pub fn btc_context(inputs: &[BtcOutpoint], outputs: &[BtcOutput]) -> DResult<BtcSighashContext> {
    let mut prev = Buf::<{ 36 * MAX_BTC_INPUTS }>::new();
    let mut seq = Buf::<{ 4 * MAX_BTC_INPUTS }>::new();
    for i in inputs {
        prev.put(&i.txid)?;
        prev.put(&i.vout.to_le_bytes())?;
        seq.put(&BTC_SEQUENCE.to_le_bytes())?;
    }
    Ok(BtcSighashContext {
        hash_prevouts: sha256d(prev.as_slice()),
        hash_sequence: sha256d(seq.as_slice()),
        hash_outputs: hash_outputs(outputs)?,
    })
}

pub fn bip143_preimage(ctx: &BtcSighashContext, input: &BtcOutpoint, script_code: &ScriptCode) -> DResult<Preimage> {
    let mut p = Preimage::new();
    p.put(&BTC_TX_VERSION.to_le_bytes())?;
    p.put(&ctx.hash_prevouts)?;
    p.put(&ctx.hash_sequence)?;
    p.put(&input.txid)?;
    p.put(&input.vout.to_le_bytes())?;
    write_script_code(&mut p, script_code)?;
    p.put(&input.value.to_le_bytes())?;
    p.put(&BTC_SEQUENCE.to_le_bytes())?;
    p.put(&ctx.hash_outputs)?;
    p.put(&BTC_LOCKTIME.to_le_bytes())?;
    p.put(&SIGHASH_ALL.to_le_bytes())?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rlp_known_vectors() {
        let mut b = Buf::<64>::new();
        rlp_uint(&mut b, 0).unwrap();
        rlp_uint(&mut b, 0x7f).unwrap();
        rlp_uint(&mut b, 0x80).unwrap();
        rlp_uint(&mut b, 1024).unwrap();
        assert_eq!(b.as_slice(), &[0x80, 0x7f, 0x81, 0x80, 0x82, 0x04, 0x00]);
    }

    #[test]
    fn script_numbers() {
        let enc = |n: u16| {
            let mut b = Buf::<8>::new();
            push_script_num(&mut b, n).unwrap();
            b.as_slice().to_vec()
        };
        assert_eq!(enc(6), vec![0x56]);
        assert_eq!(enc(16), vec![0x60]);
        assert_eq!(enc(17), vec![0x01, 0x11]);
        assert_eq!(enc(128), vec![0x02, 0x80, 0x00]);
        assert_eq!(enc(4320), vec![0x02, 0xe0, 0x10]);
        assert_eq!(enc(0xffff), vec![0x03, 0xff, 0xff, 0x00]);
    }

    #[test]
    fn point_check_against_generator() {
        // secp256k1 generator G
        let gx = hex_literal("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
        let gy = hex_literal("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8");
        let mut c = [0u8; 33];
        c[0] = 0x02; // gy is even
        c[1..].copy_from_slice(&gx);
        assert!(verify_uncompressed(&c, &gy).is_ok());
        c[0] = 0x03;
        assert!(verify_uncompressed(&c, &gy).is_err());
        let mut bad = gy;
        bad[0] ^= 1;
        c[0] = 0x02;
        assert!(verify_uncompressed(&c, &bad).is_err());
    }

    fn hex_literal(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }
}
