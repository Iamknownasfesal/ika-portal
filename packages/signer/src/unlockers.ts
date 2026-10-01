import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { domainMessage } from './share.js';
import type { ShareDomain, ShareUnlocker } from './types.js';

const enc = new TextEncoder();
const SALT = enc.encode('ika-portal/share-key');

/**
 * Derives the share key from an Ed25519 signature over a fixed,
 * domain-separated message. Ed25519 signatures are deterministic, so the same
 * Solana key always re-derives the same secret. Works with wallet-adapter
 * `signMessage` or a local Keypair.
 */
export class SolanaSignatureUnlocker implements ShareUnlocker {
  constructor(private readonly signMessage: (message: Uint8Array) => Promise<Uint8Array>) {}

  async deriveKey(domain: ShareDomain): Promise<Uint8Array> {
    const msg = enc.encode(domainMessage(domain));
    const sig = await this.signMessage(msg);
    if (sig.length !== 64) throw new Error('expected a 64-byte Ed25519 signature');
    const key = hkdf(sha256, sig, SALT, msg, 32);
    sig.fill(0);
    return key;
  }
}

export interface PasskeyUnlockerOptions {
  /** WebAuthn credential id (from registration). */
  credentialId: Uint8Array;
  rpId?: string;
  /** Override for tests / non-browser environments: returns the PRF output for a salt. */
  evaluatePrf?: (salt: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Derives the share key from the WebAuthn PRF extension (hmac-secret) with a
 * salt bound to the domain. Experimental: requires an
 * authenticator with PRF support.
 */
export class PasskeyUnlocker implements ShareUnlocker {
  constructor(private readonly opts: PasskeyUnlockerOptions) {}

  private async prf(salt: Uint8Array): Promise<Uint8Array> {
    if (this.opts.evaluatePrf) return this.opts.evaluatePrf(salt);
    const nav = (globalThis as { navigator?: { credentials?: CredentialsContainer } }).navigator;
    if (!nav?.credentials) throw new Error('PasskeyUnlocker needs WebAuthn (browser) or an evaluatePrf override');
    const cred = (await nav.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: this.opts.rpId,
        allowCredentials: [{ type: 'public-key', id: this.opts.credentialId as BufferSource }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const out = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } })?.prf?.results?.first;
    if (!out) throw new Error('authenticator did not return a PRF result (PRF extension unsupported?)');
    return new Uint8Array(out);
  }

  async deriveKey(domain: ShareDomain): Promise<Uint8Array> {
    const msg = enc.encode(domainMessage(domain));
    const out = await this.prf(sha256(msg));
    const key = hkdf(sha256, out, SALT, msg, 32);
    out.fill(0);
    return key;
  }
}
