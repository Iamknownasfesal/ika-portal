import { Buffer } from 'buffer';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { SignerError, type ShareDomain, type ShareUnlocker } from './types.js';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export function domainMessage(d: ShareDomain): string {
  return `ika-portal/user-share/v1\nprogram:${d.programId}\naccount:${d.account}\nslot:${d.slot}`;
}

export async function encryptShare(share: Uint8Array, unlock: ShareUnlocker, domain: ShareDomain): Promise<string> {
  const key = await unlock.deriveKey(domain);
  try {
    const nonce = randomBytes(24);
    const aad = new TextEncoder().encode(domainMessage(domain));
    const ct = xchacha20poly1305(key, nonce, aad).encrypt(share);
    return b64(new Uint8Array([...nonce, ...ct]));
  } finally {
    key.fill(0);
  }
}

/** Decrypts into a fresh buffer the caller must zero after use. */
export async function decryptShare(blob: string, unlock: ShareUnlocker | undefined, domain: ShareDomain): Promise<Uint8Array> {
  if (!unlock) throw new SignerError('ShareLocked', 'this dWallet uses an encrypted user share: an unlocker is required to sign');
  const key = await unlock.deriveKey(domain);
  try {
    const raw = unb64(blob);
    const aad = new TextEncoder().encode(domainMessage(domain));
    return xchacha20poly1305(key, raw.slice(0, 24), aad).decrypt(raw.slice(24));
  } catch (e) {
    throw new SignerError('ShareLocked', `failed to unlock user share: ${(e as Error).message}`);
  } finally {
    key.fill(0);
  }
}
