//! Reading Ika dWallet accounts and deriving Ika PDAs.
//! Layouts follow the pre-alpha account reference (disc | version | fields).

use anchor_lang::prelude::*;

use crate::error::IkaError;

pub const DWALLET_DISC: u8 = 2;
pub const DWALLET_LEN: usize = 153;
pub const CURVE_SECP256K1: u16 = 0;
pub const STATE_ACTIVE: u8 = 1;

pub struct DWalletInfo {
    pub authority: Pubkey,
    pub curve: u16,
    pub pubkey: [u8; 33],
}

pub fn parse(ai: &AccountInfo, dwallet_program: &Pubkey) -> Result<DWalletInfo> {
    require_keys_eq!(*ai.owner, *dwallet_program, IkaError::InvalidDWallet);
    let data = ai.try_borrow_data()?;
    require!(data.len() >= DWALLET_LEN && data[0] == DWALLET_DISC, IkaError::InvalidDWallet);
    let authority = Pubkey::new_from_array(data[2..34].try_into().unwrap());
    let curve = u16::from_le_bytes([data[34], data[35]]);
    require!(curve == CURVE_SECP256K1, IkaError::WrongCurve);
    require!(data[36] == STATE_ACTIVE, IkaError::DWalletNotActive);
    require!(data[37] == 33, IkaError::InvalidDWallet);
    let mut pubkey = [0u8; 33];
    pubkey.copy_from_slice(&data[38..71]);
    Ok(DWalletInfo { authority, curve, pubkey })
}

/// `curve_u16_le ‖ pubkey` split into 32-byte chunks (33-byte key → [32, 3]).
pub fn dwallet_payload(curve: u16, pubkey: &[u8; 33]) -> [u8; 35] {
    let mut p = [0u8; 35];
    p[..2].copy_from_slice(&curve.to_le_bytes());
    p[2..].copy_from_slice(pubkey);
    p
}

pub fn find_message_approval(
    dwallet_program: &Pubkey,
    curve: u16,
    pubkey: &[u8; 33],
    scheme: u16,
    message_digest: &[u8; 32],
) -> (Pubkey, u8) {
    let payload = dwallet_payload(curve, pubkey);
    let scheme_le = scheme.to_le_bytes();
    Pubkey::find_program_address(
        &[b"dwallet", &payload[..32], &payload[32..], b"message_approval", &scheme_le, message_digest],
        dwallet_program,
    )
}
