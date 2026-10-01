import type { Utxo } from './sighash.js';
import { BTC_DUST } from './sighash.js';
import type { BtcLock } from './scripts.js';

/** Virtual sizes (vB) for fee estimation. */
const TX_OVERHEAD = 11;
const OUTPUT_VB = 43; // generous: covers P2WSH/P2TR outputs
const INPUT_VB: Record<BtcLock['type'], number> = { p2wpkh: 68, p2wsh: 82 };

export function estimateVsize(inputs: number, outputs: number, lock: BtcLock['type']): number {
  return TX_OVERHEAD + inputs * INPUT_VB[lock] + outputs * OUTPUT_VB;
}

export interface Selection {
  inputs: Utxo[];
  fee: bigint;
}

/**
 * Largest-first, at most `maxInputs`, fee from `feeRate` (sat/vB). Throws if
 * the amount can't be covered or the fee would exceed `maxFee`.
 */
export function selectCoins(
  utxos: Utxo[],
  amount: bigint,
  opts: { feeRate: number; maxInputs: number; maxFee: bigint; lock: BtcLock['type']; minConfirmations?: number },
): Selection {
  const pool = utxos
    .filter((u) => (u.confirmations ?? 0) >= (opts.minConfirmations ?? 0))
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const inputs: Utxo[] = [];
  let total = 0n;
  for (const u of pool) {
    if (inputs.length >= opts.maxInputs) break;
    inputs.push(u);
    total += u.value;
    const feeWithChange = BigInt(Math.ceil(estimateVsize(inputs.length, 2, opts.lock) * opts.feeRate));
    if (total >= amount + feeWithChange) {
      const change = total - amount - feeWithChange;
      const fee = change >= BTC_DUST ? feeWithChange : total - amount;
      if (fee > opts.maxFee) throw new Error(`BTC fee ${fee} sats exceeds policy cap ${opts.maxFee}`);
      // The program decides change the same way (planSpend / btc_change), so
      // pass the with-change fee; sub-dust change is absorbed into the fee.
      return { inputs, fee: feeWithChange };
    }
  }
  throw new Error(`insufficient BTC: need ${amount} + fee from at most ${opts.maxInputs} inputs, have ${total}`);
}
