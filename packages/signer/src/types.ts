import type { PublicKey } from '@solana/web3.js';

export type UserShareMode = 'public' | 'encrypted';
export type Curve = 'secp256k1';

/** Ika `DWalletSignatureScheme` values used by Ika Portal. */
export const SCHEME = { EcdsaKeccak256: 0, EcdsaDoubleSha256: 2 } as const;
export type Scheme = (typeof SCHEME)[keyof typeof SCHEME];

/** Serializable reference to a dWallet. Safe to persist (holds no plaintext secrets). */
export interface DWalletRef {
  /** dWallet account (PDA of the dWallet program), base58. */
  address: string;
  /** 33-byte compressed secp256k1 public key, hex. */
  publicKey: string;
  curve: Curve;
  imported: boolean;
  userShare: UserShareMode;
  backend: 'local-mock' | 'ika-pre-alpha';
  /** Ika DKG/import attestation (base64 fields), needed for gRPC Sign. */
  attestation?: { data: string; networkSignature: string; networkPubkey: string; epoch: string };
  /**
   * Ika pre-alpha: the DKG request's `session_identifier_preimage` (base64).
   * The network keys the dWallet's secret by it, so Presign/Sign must reuse it.
   */
  session?: string;
  /** Encrypted user share (base64 nonce ‖ ciphertext) for `encrypted` accounts. */
  encryptedShare?: string;
  /** Unlock domain the share was encrypted under. */
  shareDomain?: ShareDomain;
}

/**
 * Deterministic, domain-separated context for the share key. The dWallet
 * address isn't known before DKG, so the domain uses the account PDA and the
 * dWallet's role slot instead.
 */
export interface ShareDomain {
  programId: string;
  account: string;
  slot: 'both' | 'btc' | 'evm';
}

export interface ShareUnlocker {
  /** 32-byte secret used to encrypt/decrypt the user share. Must be deterministic per domain. */
  deriveKey(domain: ShareDomain): Promise<Uint8Array>;
}

export interface SignRequest {
  /** MessageApproval PDA created by `approve_intent`. */
  approval: PublicKey;
  /** The preimage; the scheme's hash is applied by the signer (Ika semantics). */
  message: Uint8Array;
  scheme: Scheme;
  /** Signature of the Solana transaction that created the approval (base58). */
  approvalTx: string;
  approvalSlot?: number;
}

export interface CreateOptions {
  /** Initial dWallet authority (the account owner); it then transfers to the program's CPI PDA. */
  authority: PublicKey;
  unlock?: ShareUnlocker;
  domain?: ShareDomain;
}

export interface SignerBackend {
  readonly kind: DWalletRef['backend'];
  /** dWallet program this backend talks to (Ika or mock_dwallet). */
  readonly dwalletProgramId: PublicKey;
  /** Ed25519 identity used for Ika gRPC requests; stored as the account's `ika_user`. */
  readonly identity: PublicKey;
  createDkgDwallet(curve: Curve, userShare: UserShareMode, opts: CreateOptions): Promise<DWalletRef>;
  importKeyDwallet(privateKey: Uint8Array, curve: Curve, userShare: UserShareMode, opts: CreateOptions): Promise<DWalletRef>;
  /** Transfer authority when the backend's identity is the current authority. */
  transferOwnership(dwallet: DWalletRef, newAuthority: PublicKey): Promise<void>;
  publicKey(dwallet: DWalletRef): Promise<Uint8Array>;
  /** Returns a 64-byte r‖s ECDSA signature over hash_scheme(message). Requires `unlock` for encrypted shares. */
  sign(dwallet: DWalletRef, req: SignRequest, unlock?: ShareUnlocker): Promise<Uint8Array>;
}

export class SignerError extends Error {
  constructor(
    public readonly code: 'DWalletNotFound' | 'ShareLocked' | 'ApprovalMissing' | 'ApprovalMismatch' | 'IkaError' | 'Unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}
