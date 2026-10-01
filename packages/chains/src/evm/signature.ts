import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, recoverAddress, type Address, type Hex } from 'viem';

const N = secp256k1.Point.CURVE().n;
const HALF_N = N >> 1n;

export interface EvmSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
  /** 65-byte r‖s‖v with v ∈ {27, 28}, as `IkaAccount` expects. */
  serialized: Hex;
}

function parseRS(sig: Uint8Array): { r: bigint; s: bigint } {
  if (sig.length === 64 || sig.length === 65) {
    return { r: BigInt(bytesToHex(sig.slice(0, 32))), s: BigInt(bytesToHex(sig.slice(32, 64))) };
  }
  if (sig[0] === 0x30) {
    const s = secp256k1.Signature.fromBytes(sig, 'der');
    return { r: s.r, s: s.s };
  }
  throw new Error(`unrecognized ECDSA signature encoding (${sig.length} bytes)`);
}

const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/**
 * Normalize an Ika ECDSA signature to low-S and find the recovery id by
 * trying both against the known signer address.
 */
export async function toEvmSignature(sig: Uint8Array, digest: Hex, signer: Address): Promise<EvmSignature> {
  let { r, s } = parseRS(sig);
  if (s > HALF_N) s = N - s;
  for (const yParity of [0, 1] as const) {
    const candidate = { r: word(r), s: word(s), yParity };
    const recovered = await recoverAddress({ hash: digest, signature: candidate });
    if (recovered.toLowerCase() === signer.toLowerCase()) {
      const v = (27 + yParity).toString(16);
      return { ...candidate, serialized: `0x${word(r).slice(2)}${word(s).slice(2)}${v}` };
    }
  }
  throw new Error(`signature does not recover to ${signer}`);
}
