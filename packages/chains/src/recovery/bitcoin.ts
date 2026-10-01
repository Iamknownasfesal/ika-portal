/**
 * Offline Bitcoin recovery for `enforced_recovery` accounts: spend the P2WSH
 * CSV branch with the user's recovery key. No Ika, no Solana.
 */
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { BitcoinNetworkName } from '../types.js';
import type { BitcoinBackend } from '../bitcoin/backend.js';
import { addressToScript, recoveryWitnessScript, outputScript } from '../bitcoin/scripts.js';
import { estimateVsize } from '../bitcoin/coinselect.js';
import { txidToInternal, type Utxo } from '../bitcoin/sighash.js';

export interface RecoveryAccountInfo {
  dwalletPubkey: Uint8Array;
  recoveryPubkey: Uint8Array;
  csvBlocks: number;
  network: BitcoinNetworkName;
}

export interface BuildRecoveryTxArgs {
  recoveryKey: Uint8Array; // 32-byte private key
  account: RecoveryAccountInfo;
  to: string;
  feeRate: number;
  backend: BitcoinBackend;
  /**
   * Minimum confirmations for a UTXO to be included (default csv_blocks).
   * Lowering it only lets you build a transaction consensus will reject.
   */
  minConfirmations?: number;
}

export async function buildRecoveryTx(args: BuildRecoveryTxArgs): Promise<{ hex: string; txid: string; inputs: Utxo[]; fee: bigint }> {
  const { account } = args;
  const pub = secp256k1.getPublicKey(args.recoveryKey, true);
  if (Buffer.compare(Buffer.from(pub), Buffer.from(account.recoveryPubkey)) !== 0) {
    throw new Error('recovery key does not match the account recovery pubkey');
  }
  const ws = recoveryWitnessScript(account.dwalletPubkey, account.csvBlocks, account.recoveryPubkey);
  const lock = { type: 'p2wsh' as const, dwalletPubkey: account.dwalletPubkey, recoveryPubkey: account.recoveryPubkey, csvBlocks: account.csvBlocks };
  const address = bitcoin.address.fromOutputScript(outputScript(lock), networkFor(account.network));
  // Each UTXO becomes spendable csv_blocks after it confirms.
  const all = await args.backend.utxos(address);
  const minConf = args.minConfirmations ?? account.csvBlocks;
  const inputs = all.filter((u) => (u.confirmations ?? 0) >= minConf && (u.confirmations ?? 0) > 0);
  if (!inputs.length) {
    throw new Error(`no UTXOs at ${address} with >= ${account.csvBlocks} confirmations (found ${all.length} total)`);
  }
  const total = inputs.reduce((s, u) => s + u.value, 0n);
  const fee = BigInt(Math.ceil(estimateVsize(inputs.length, 1, 'p2wsh') * args.feeRate)) + 20n;
  if (total <= fee + 546n) throw new Error(`recoverable balance ${total} too small for fee ${fee}`);

  const tx = new bitcoin.Transaction();
  tx.version = 2; // BIP68 relative locks need version >= 2
  for (const u of inputs) tx.addInput(txidToInternal(u.txid), u.vout, account.csvBlocks);
  tx.addOutput(addressToScript(args.to, account.network), total - fee);
  inputs.forEach((u, i) => {
    const sighash = tx.hashForWitnessV0(i, ws, u.value, bitcoin.Transaction.SIGHASH_ALL);
    const sig = secp256k1.sign(sighash, args.recoveryKey, { prehash: false, lowS: true });
    const der = Uint8Array.from([...secp256k1.Signature.fromBytes(sig, 'compact').toBytes('der'), bitcoin.Transaction.SIGHASH_ALL]);
    tx.setWitness(i, [der, new Uint8Array(0), ws]);
  });
  return { hex: tx.toHex(), txid: tx.getId(), inputs, fee };
}

function networkFor(n: BitcoinNetworkName) {
  return n === 'mainnet' ? bitcoin.networks.bitcoin : n === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet;
}
