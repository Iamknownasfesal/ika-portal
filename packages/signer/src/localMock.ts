/**
 * LocalMockSigner: keeps dWallet private keys in memory and signs only what
 * `mock_dwallet` has approved on-chain, so policy enforcement is testable
 * without Ika. Mirrors the Ika flow: DKG → authority = requester, sign reads
 * the MessageApproval, and the signature is committed back on-chain.
 */
import { Buffer } from 'buffer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import { approvalDigest, schemeHash } from './hashing.js';
import { dwalletPda, messageApprovalPda, parseMessageApproval, transferOwnershipIx, fetchDWallet } from './ikaProgram.js';
import { decryptShare, encryptShare } from './share.js';
import { SignerError, type CreateOptions, type Curve, type DWalletRef, type ShareUnlocker, type SignRequest, type SignerBackend, type UserShareMode } from './types.js';

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export const MOCK_DWALLET_PROGRAM_ID = new PublicKey('6sewJoZnLJN1hMzaYLySG61VSLiPoFzbA8Cyd7KJkwv');

/** Optional persistence for mock keys (e.g. localStorage in the demo app). */
export interface MockKeyStore {
  get(address: string): string | undefined | Promise<string | undefined>;
  set(address: string, value: string): void | Promise<void>;
}

export class MemoryKeyStore implements MockKeyStore {
  private m = new Map<string, string>();
  get(a: string) {
    return this.m.get(a);
  }
  set(a: string, v: string) {
    this.m.set(a, v);
  }
}

export interface LocalMockSignerOptions {
  connection: Connection;
  /** Pays for mock dWallet creation and signature commits; also the gRPC-style identity. */
  payer: Keypair;
  programId?: PublicKey;
  store?: MockKeyStore;
  /** Write signatures back into the MessageApproval like the Ika network does. Default true. */
  commitSignatures?: boolean;
}

export class LocalMockSigner implements SignerBackend {
  readonly kind = 'local-mock' as const;
  readonly dwalletProgramId: PublicKey;
  readonly identity: PublicKey;
  private readonly store: MockKeyStore;

  constructor(private readonly opts: LocalMockSignerOptions) {
    this.dwalletProgramId = opts.programId ?? MOCK_DWALLET_PROGRAM_ID;
    this.identity = opts.payer.publicKey;
    this.store = opts.store ?? new MemoryKeyStore();
  }

  private async send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = this.opts.payer.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.opts.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(this.opts.payer, ...signers);
    const sig = await this.opts.connection.sendRawTransaction(tx.serialize());
    await this.opts.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }

  /** Test-only: create the mock coordinator PDA if missing. */
  async ensureInitialized(): Promise<void> {
    const coordinator = PublicKey.findProgramAddressSync([Buffer.from('dwallet_coordinator')], this.dwalletProgramId)[0];
    if (await this.opts.connection.getAccountInfo(coordinator)) return;
    await this.send([
      new TransactionInstruction({
        programId: this.dwalletProgramId,
        keys: [
          { pubkey: coordinator, isSigner: false, isWritable: true },
          { pubkey: this.opts.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([200]),
      }),
    ]);
  }

  private async create(secret: Uint8Array, imported: boolean, userShare: UserShareMode, opts: CreateOptions): Promise<DWalletRef> {
    if (userShare === 'encrypted' && (!opts.unlock || !opts.domain)) {
      throw new SignerError('ShareLocked', 'encrypted user share requires an unlocker and domain at creation');
    }
    const publicKey = secp256k1.getPublicKey(secret, true);
    const address = dwalletPda(this.dwalletProgramId, publicKey);
    await this.send([
      new TransactionInstruction({
        programId: this.dwalletProgramId,
        keys: [
          { pubkey: address, isSigner: false, isWritable: true },
          { pubkey: this.opts.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([201]), Buffer.from(publicKey), opts.authority.toBuffer(), Buffer.from([imported ? 1 : 0])]),
      }),
    ]);
    const ref: DWalletRef = {
      address: address.toBase58(),
      publicKey: bytesToHex(publicKey),
      curve: 'secp256k1',
      imported,
      userShare,
      backend: 'local-mock',
    };
    if (userShare === 'encrypted') {
      // The mock holds the whole key; encrypting it under the unlocker's key
      // makes "no signature without the user's device" hold locally too.
      ref.encryptedShare = await encryptShare(secret, opts.unlock!, opts.domain!);
      ref.shareDomain = opts.domain;
      await this.store.set(ref.address, `enc:${ref.encryptedShare}`);
    } else {
      await this.store.set(ref.address, `hex:${bytesToHex(secret)}`);
    }
    return ref;
  }

  createDkgDwallet(_curve: Curve, userShare: UserShareMode, opts: CreateOptions): Promise<DWalletRef> {
    return this.create(secp256k1.utils.randomSecretKey(), false, userShare, opts);
  }

  importKeyDwallet(privateKey: Uint8Array, _curve: Curve, userShare: UserShareMode, opts: CreateOptions): Promise<DWalletRef> {
    return this.create(privateKey, true, userShare, opts);
  }

  async transferOwnership(dwallet: DWalletRef, newAuthority: PublicKey): Promise<void> {
    await this.send([transferOwnershipIx(this.dwalletProgramId, this.identity, new PublicKey(dwallet.address), newAuthority)]);
  }

  async publicKey(dwallet: DWalletRef): Promise<Uint8Array> {
    const d = await fetchDWallet(this.opts.connection, new PublicKey(dwallet.address));
    return d.publicKey;
  }

  private async secret(dwallet: DWalletRef, unlock?: ShareUnlocker): Promise<Uint8Array> {
    const stored = await this.store.get(dwallet.address);
    if (!stored) throw new SignerError('DWalletNotFound', `LocalMockSigner has no key for ${dwallet.address}`);
    if (stored.startsWith('hex:')) return Uint8Array.from(Buffer.from(stored.slice(4), 'hex'));
    return decryptShare(stored.slice(4), unlock, dwallet.shareDomain!);
  }

  async sign(dwallet: DWalletRef, req: SignRequest, unlock?: ShareUnlocker): Promise<Uint8Array> {
    const info = await this.opts.connection.getAccountInfo(req.approval, 'confirmed');
    if (!info) throw new SignerError('ApprovalMissing', `no MessageApproval at ${req.approval.toBase58()}`);
    const ma = parseMessageApproval(info.data);
    const pk = Uint8Array.from(Buffer.from(dwallet.publicKey, 'hex'));
    const expectedPda = messageApprovalPda(this.dwalletProgramId, pk, req.scheme, approvalDigest(req.message));
    if (
      !info.owner.equals(this.dwalletProgramId) ||
      !expectedPda.equals(req.approval) ||
      ma.dwallet.toBase58() !== dwallet.address ||
      ma.scheme !== req.scheme ||
      !equalBytes(ma.messageDigest, approvalDigest(req.message))
    ) {
      throw new SignerError('ApprovalMismatch', 'MessageApproval does not match this dWallet / message / scheme');
    }
    const secret = await this.secret(dwallet, unlock);
    try {
      const sig = secp256k1.sign(schemeHash(req.scheme, req.message), secret, { prehash: false, lowS: true });
      if (this.opts.commitSignatures !== false && ma.status === 'pending') {
        const len = Buffer.alloc(4);
        len.writeUInt32LE(sig.length, 0);
        await this.send([
          new TransactionInstruction({
            programId: this.dwalletProgramId,
            keys: [
              { pubkey: req.approval, isSigner: false, isWritable: true },
              { pubkey: this.opts.payer.publicKey, isSigner: true, isWritable: false },
            ],
            data: Buffer.concat([Buffer.from([43]), len, Buffer.from(sig)]),
          }),
        ]);
      }
      return sig;
    } finally {
      secret.fill(0);
    }
  }
}
