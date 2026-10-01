import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as bitcoin from 'bitcoinjs-lib';
import { witnessScript, type BtcLock } from './scripts.js';
import type { BtcSpendPlan } from './sighash.js';
import { unsignedTx } from './sighash.js';

const N = secp256k1.Point.CURVE().n;

/** DER-encode with low-S and append SIGHASH_ALL. Accepts 64-byte compact or DER input. */
export function toBitcoinSignature(sig: Uint8Array, sighash: Uint8Array, pubkey: Uint8Array): Uint8Array {
  let s = sig.length === 64 || sig.length === 65 ? secp256k1.Signature.fromBytes(sig.slice(0, 64), 'compact') : secp256k1.Signature.fromBytes(sig, 'der');
  if (s.s > N >> 1n) s = new secp256k1.Signature(s.r, N - s.s);
  if (!secp256k1.verify(s.toBytes('compact'), sighash, pubkey, { prehash: false })) {
    throw new Error(`signature does not verify for pubkey ${bytesToHex(pubkey)}`);
  }
  return Uint8Array.from([...s.toBytes('der'), bitcoin.Transaction.SIGHASH_ALL]);
}

/** Assemble witnesses for the dWallet branch and return the raw tx hex. */
export function finalizeTx(plan: BtcSpendPlan, lock: BtcLock, derSigs: Uint8Array[]): { hex: string; txid: string } {
  const tx = unsignedTx(plan);
  derSigs.forEach((sig, i) => {
    if (lock.type === 'p2wpkh') tx.setWitness(i, [sig, lock.pubkey]);
    else tx.setWitness(i, [sig, Uint8Array.of(1), witnessScript(lock)!]);
  });
  return { hex: tx.toHex(), txid: tx.getId() };
}
