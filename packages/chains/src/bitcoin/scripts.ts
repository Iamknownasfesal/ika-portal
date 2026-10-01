import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import type { BitcoinNetworkName } from '../types.js';

export const networkOf = (n: BitcoinNetworkName): bitcoin.Network =>
  n === 'mainnet' ? bitcoin.networks.bitcoin : n === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet;

export const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

/** How the account's Bitcoin coins are locked. */
export type BtcLock =
  | { type: 'p2wpkh'; pubkey: Uint8Array }
  | { type: 'p2wsh'; dwalletPubkey: Uint8Array; recoveryPubkey: Uint8Array; csvBlocks: number };

/** `OP_IF <dwallet> OP_CHECKSIG OP_ELSE <csv> OP_CSV OP_DROP <recovery> OP_CHECKSIG OP_ENDIF` */
export function recoveryWitnessScript(dwalletPubkey: Uint8Array, csvBlocks: number, recoveryPubkey: Uint8Array): Uint8Array {
  const o = bitcoin.opcodes;
  return bitcoin.script.compile([
    o.OP_IF,
    dwalletPubkey,
    o.OP_CHECKSIG,
    o.OP_ELSE,
    bitcoin.script.number.encode(csvBlocks),
    o.OP_CHECKSEQUENCEVERIFY,
    o.OP_DROP,
    recoveryPubkey,
    o.OP_CHECKSIG,
    o.OP_ENDIF,
  ]);
}

export function witnessScript(lock: BtcLock): Uint8Array | null {
  return lock.type === 'p2wsh' ? recoveryWitnessScript(lock.dwalletPubkey, lock.csvBlocks, lock.recoveryPubkey) : null;
}

export function outputScript(lock: BtcLock): Uint8Array {
  if (lock.type === 'p2wpkh') return Uint8Array.from([0x00, 0x14, ...hash160(lock.pubkey)]);
  return Uint8Array.from([0x00, 0x20, ...sha256(witnessScript(lock)!)]);
}

/** BIP143 scriptCode (without the length prefix). */
export function scriptCode(lock: BtcLock): Uint8Array {
  if (lock.type === 'p2wpkh') return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(lock.pubkey), 0x88, 0xac]);
  return witnessScript(lock)!;
}

export function lockAddress(lock: BtcLock, network: BitcoinNetworkName): string {
  return bitcoin.address.fromOutputScript(outputScript(lock), networkOf(network));
}

export function addressToScript(address: string, network: BitcoinNetworkName): Uint8Array {
  return bitcoin.address.toOutputScript(address, networkOf(network));
}

export function scriptToAddress(script: Uint8Array, network: BitcoinNetworkName): string {
  return bitcoin.address.fromOutputScript(script, networkOf(network));
}
