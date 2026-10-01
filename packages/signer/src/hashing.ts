import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { SCHEME, type Scheme } from './types.js';

/** The hash Ika applies to a message for a given scheme before ECDSA signing. */
export function schemeHash(scheme: Scheme, message: Uint8Array): Uint8Array {
  if (scheme === SCHEME.EcdsaKeccak256) return keccak_256(message);
  if (scheme === SCHEME.EcdsaDoubleSha256) return sha256(sha256(message));
  throw new Error(`unsupported scheme ${scheme}`);
}

/** MessageApproval key: always keccak256(message) (Ika pre-alpha convention). */
export const approvalDigest = (message: Uint8Array) => keccak_256(message);
