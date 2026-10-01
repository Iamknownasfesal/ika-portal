/**
 * Off-chain mirror of the program's BIP143 construction (digest.rs). The
 * transaction shape is fixed: version 2, locktime 0, nSequence 0xfffffffd,
 * outputs [recipient, change?] with change dropped below dust.
 */
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { scriptCode, outputScript, type BtcLock } from './scripts.js';

export const BTC_TX_VERSION = 2;
export const BTC_SEQUENCE = 0xfffffffd;
export const BTC_DUST = 546n;
export const SIGHASH_ALL = 1;

export interface Utxo {
  /** Display-order txid hex. */
  txid: string;
  vout: number;
  value: bigint;
  confirmations?: number;
}

export const txidToInternal = (txid: string) => Uint8Array.from(Buffer.from(txid, 'hex').reverse());

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export const sha256d = (b: Uint8Array) => sha256(sha256(b));

export interface BtcSpendPlan {
  inputs: Utxo[];
  outputs: { script: Uint8Array; value: bigint }[];
  fee: bigint;
}

/** Mirrors `btc_change` in the program: change below dust goes to the fee. */
export function planSpend(inputs: Utxo[], toScript: Uint8Array, amount: bigint, fee: bigint, lock: BtcLock): BtcSpendPlan {
  const total = inputs.reduce((s, i) => s + i.value, 0n);
  if (total < amount + fee) throw new Error(`inputs ${total} don't cover amount ${amount} + fee ${fee}`);
  const change = total - amount - fee;
  const outputs = [{ script: toScript, value: amount }];
  if (change >= BTC_DUST) outputs.push({ script: outputScript(lock), value: change });
  return { inputs, outputs, fee: change >= BTC_DUST ? fee : total - amount };
}

export function bip143Preimages(plan: BtcSpendPlan, lock: BtcLock): Uint8Array[] {
  const hashPrevouts = sha256d(cat(...plan.inputs.map((i) => cat(txidToInternal(i.txid), u32(i.vout)))));
  const hashSequence = sha256d(cat(...plan.inputs.map(() => u32(BTC_SEQUENCE))));
  const hashOutputs = sha256d(cat(...plan.outputs.map((o) => cat(u64(o.value), Uint8Array.of(o.script.length), o.script))));
  const sc = scriptCode(lock);
  return plan.inputs.map((i) =>
    cat(
      u32(BTC_TX_VERSION),
      hashPrevouts,
      hashSequence,
      txidToInternal(i.txid),
      u32(i.vout),
      Uint8Array.of(sc.length),
      sc,
      u64(i.value),
      u32(BTC_SEQUENCE),
      hashOutputs,
      u32(0),
      u32(SIGHASH_ALL),
    ),
  );
}

export interface BtcSignable {
  preimage: Uint8Array;
  /** keccak256(preimage): the Ika MessageApproval key. */
  approvalDigest: Uint8Array;
  /** sha256d(preimage): the BIP143 sighash that is signed. */
  sighash: Uint8Array;
}

export function btcSignables(plan: BtcSpendPlan, lock: BtcLock): BtcSignable[] {
  return bip143Preimages(plan, lock).map((preimage) => ({
    preimage,
    approvalDigest: keccak_256(preimage),
    sighash: sha256d(preimage),
  }));
}

export function unsignedTx(plan: BtcSpendPlan, sequence = BTC_SEQUENCE): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = BTC_TX_VERSION;
  tx.locktime = 0;
  for (const i of plan.inputs) tx.addInput(txidToInternal(i.txid), i.vout, sequence);
  for (const o of plan.outputs) tx.addOutput(o.script, o.value);
  return tx;
}
