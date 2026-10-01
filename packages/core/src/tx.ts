import { Keypair, Transaction, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { decodeProgramError } from './program.js';
import type { TxSigner } from './types.js';

export function keypairSigner(kp: Keypair): TxSigner {
  return {
    publicKey: kp.publicKey,
    async signTransaction(tx) {
      if (tx instanceof Transaction) tx.partialSign(kp);
      else tx.sign([kp]);
      return tx;
    },
  };
}

/** Sign with every distinct signer (fee payer first), send, confirm. Program errors come back typed. */
export async function sendInstructions(
  connection: Connection,
  ixs: TransactionInstruction[],
  feePayer: TxSigner,
  signers: TxSigner[] = [],
): Promise<{ signature: string; slot: number }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  let tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const seen = new Set<string>();
  for (const s of [feePayer, ...signers]) {
    const k = s.publicKey.toBase58();
    if (seen.has(k)) continue;
    seen.add(k);
    tx = await s.signTransaction(tx);
  }
  try {
    const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) {
      const t = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      throw decodeProgramError({ message: JSON.stringify(res.value.err), logs: t?.meta?.logMessages ?? [] });
    }
    return { signature, slot: res.context.slot };
  } catch (e) {
    throw decodeProgramError(e);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
