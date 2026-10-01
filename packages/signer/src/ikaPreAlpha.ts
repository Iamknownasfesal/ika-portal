/**
 * IkaPreAlphaSigner: creates secp256k1 dWallets and signs approved messages on
 * the Ika Solana pre-alpha (devnet) via gRPC.
 *
 * Pre-alpha realities (see docs/security.md): signing is a single mock signer, not
 * real 2PC-MPC; the network does not verify the user's share material, so
 * "encrypted" is enforced client-side by requiring the unlocker to decrypt the
 * locally held share before any Sign request.
 */
import { Buffer } from 'buffer';
import { defineBcsTypes } from '@ika.xyz/pre-alpha-solana-client/grpc-web';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { Keypair, PublicKey, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { createIkaGrpc, createIkaGrpcWeb, type IkaGrpc } from './grpcTransport.js';
import { approvalDigest } from './hashing.js';
import {
  IKA_DEVNET_GRPC,
  IKA_DEVNET_PROGRAM_ID,
  dwalletPda,
  fetchDWallet,
  gasDepositPda,
  messageApprovalPda,
  parseMessageApproval,
  pollAccount,
  readEpoch,
  transferOwnershipIx,
} from './ikaProgram.js';
import { decryptShare, encryptShare } from './share.js';
import { SignerError, type CreateOptions, type Curve, type DWalletRef, type ShareUnlocker, type SignRequest, type SignerBackend, type UserShareMode } from './types.js';

type Bcs = ReturnType<typeof defineBcsTypes>;
const arr = (b: Uint8Array) => Array.from(b);
const b64 = (b: Uint8Array | number[]) => Buffer.from(Uint8Array.from(b)).toString('base64');
const unb64 = (s: string) => Array.from(Buffer.from(s, 'base64'));

export interface IkaPreAlphaSignerOptions {
  connection: Connection;
  /** Ed25519 identity for gRPC requests (also pays for transfer_ownership when used). */
  identity: Keypair;
  grpcUrl?: string;
  programId?: PublicKey;
  /** `web` (gRPC-web over fetch, works in browsers) or `node` (HTTP/2). Default: web in browsers, node otherwise. */
  transport?: 'node' | 'web';
  /** How long to wait for the NOA to commit a dWallet on-chain. */
  commitTimeoutMs?: number;
}

export class IkaPreAlphaSigner implements SignerBackend {
  readonly kind = 'ika-pre-alpha' as const;
  readonly dwalletProgramId: PublicKey;
  readonly identity: PublicKey;
  private readonly bcs: Bcs = defineBcsTypes();
  private grpc: IkaGrpc | null = null;

  constructor(private readonly opts: IkaPreAlphaSignerOptions) {
    this.dwalletProgramId = opts.programId ?? IKA_DEVNET_PROGRAM_ID;
    this.identity = opts.identity.publicKey;
  }

  private client(): IkaGrpc {
    const url = this.opts.grpcUrl ?? IKA_DEVNET_GRPC;
    const web = (this.opts.transport ?? (typeof window !== 'undefined' ? 'web' : 'node')) === 'web';
    return (this.grpc ??= web ? createIkaGrpcWeb(url) : createIkaGrpc(url));
  }

  close() {
    this.grpc?.close();
    this.grpc = null;
  }

  /** GasDeposit PDA for this identity (IKA + SOL balances for dWallet ops). */
  gasDepositAddress(): PublicKey {
    return gasDepositPda(this.dwalletProgramId, this.identity);
  }

  async gasDeposit(): Promise<{ address: PublicKey; exists: boolean; ika: bigint; sol: bigint }> {
    const address = this.gasDepositAddress();
    const info = await this.opts.connection.getAccountInfo(address);
    if (!info || info.data.length < 50) return { address, exists: false, ika: 0n, sol: 0n };
    const d = Buffer.from(info.data);
    return { address, exists: true, ika: d.readBigUInt64LE(34), sol: d.readBigUInt64LE(42) };
  }

  /**
   * The pre-alpha docs list CreateDeposit (36) / TopUp (37) but publish no
   * instruction layout, and devnet signing works without a deposit today.
   */
  async fundGasDeposit(_ika: bigint, _sol: bigint): Promise<never> {
    throw new SignerError('Unsupported', 'GasDeposit CreateDeposit/TopUp layouts are not published for the pre-alpha; devnet signing currently works without a deposit');
  }

  private async submit(request: unknown, sender: PublicKey, session: Uint8Array = randomBytes(32)): Promise<ReturnType<Bcs['TransactionResponseData']['parse']>> {
    const epoch = await readEpoch(this.opts.connection, this.dwalletProgramId);
    const data = this.bcs.SignedRequestData.serialize({
      session_identifier_preimage: arr(session),
      epoch,
      chain_id: { Solana: true },
      intended_chain_sender: arr(sender.toBytes()),
      request: request as never,
    }).toBytes();
    const signature = ed25519.sign(data, this.opts.identity.secretKey.slice(0, 32));
    const userSig = this.bcs.UserSignature.serialize({
      Ed25519: { signature: arr(signature), public_key: arr(this.identity.toBytes()) },
    }).toBytes();
    let raw: Uint8Array;
    try {
      raw = await this.client().submit(userSig, data);
    } catch (e) {
      throw new SignerError('IkaError', `Ika gRPC failed: ${(e as Error).message}`);
    }
    const resp = this.bcs.TransactionResponseData.parse(raw);
    if (resp.Error) throw new SignerError('IkaError', `Ika: ${resp.Error.message}`);
    return resp;
  }

  private async userShare(userShare: UserShareMode, opts: CreateOptions): Promise<{ wire: unknown; encryptedShare?: string }> {
    // Pre-alpha: the network doesn't run real 2PC-MPC, so the share is a
    // placeholder secret. We still keep it encrypted under the unlocker so
    // signing needs the user's device (enforced client-side).
    const share = randomBytes(32);
    try {
      if (userShare === 'public') return { wire: { Public: { public_user_secret_key_share: arr(share) } } };
      if (!opts.unlock || !opts.domain) throw new SignerError('ShareLocked', 'encrypted user share requires an unlocker and domain');
      const encryptedShare = await encryptShare(share, opts.unlock, opts.domain);
      const key = await opts.unlock.deriveKey(opts.domain);
      const encryptionKey = x25519.getPublicKey(key);
      key.fill(0);
      return {
        encryptedShare,
        wire: {
          Encrypted: {
            encrypted_centralized_secret_share_and_proof: unb64(encryptedShare),
            encryption_key: arr(encryptionKey),
            signer_public_key: arr(this.identity.toBytes()),
          },
        },
      };
    } finally {
      share.fill(0);
    }
  }

  private async finishCreate(resp: Awaited<ReturnType<IkaPreAlphaSigner['submit']>>, session: Uint8Array, imported: boolean, userShare: UserShareMode, opts: CreateOptions, encryptedShare?: string): Promise<DWalletRef> {
    if (!resp.Attestation) throw new SignerError('IkaError', `unexpected Ika response: ${JSON.stringify(resp)}`);
    const att = resp.Attestation;
    const payload = this.bcs.VersionedDWalletDataAttestation.parse(Uint8Array.from(att.attestation_data));
    const publicKey = Uint8Array.from(payload.V1!.public_key);
    const address = dwalletPda(this.dwalletProgramId, publicKey);
    // The NOA commits the dWallet with authority = intended_chain_sender.
    await pollAccount(this.opts.connection, address, (d) => d.length >= 153 && d[0] === 2, this.opts.commitTimeoutMs ?? 90_000);
    const onchain = await fetchDWallet(this.opts.connection, address);
    if (!onchain.authority.equals(opts.authority)) {
      throw new SignerError('IkaError', `dWallet authority is ${onchain.authority.toBase58()}, expected ${opts.authority.toBase58()}`);
    }
    return {
      address: address.toBase58(),
      publicKey: bytesToHex(publicKey),
      curve: 'secp256k1',
      imported,
      userShare,
      backend: 'ika-pre-alpha',
      session: b64(session),
      attestation: {
        data: b64(att.attestation_data),
        networkSignature: b64(att.network_signature),
        networkPubkey: b64(att.network_pubkey),
        epoch: String(att.epoch),
      },
      encryptedShare,
      shareDomain: encryptedShare ? opts.domain : undefined,
    };
  }

  async createDkgDwallet(_curve: Curve, userShare: UserShareMode, opts: CreateOptions): Promise<DWalletRef> {
    const share = await this.userShare(userShare, opts);
    const session = randomBytes(32);
    const resp = await this.submit(
      {
        DKG: {
          dwallet_network_encryption_public_key: arr(new Uint8Array(32)),
          curve: { Secp256k1: true },
          centralized_public_key_share_and_proof: arr(new Uint8Array(32)),
          user_secret_key_share: share.wire,
          user_public_output: arr(new Uint8Array(32)),
          sign_during_dkg_request: null,
        },
      },
      opts.authority,
      session,
    );
    return this.finishCreate(resp, session, false, userShare, opts, share.encryptedShare);
  }

  /**
   * The pre-alpha `ImportedKeyVerification` mock does not take the key
   * material: it creates an imported-flagged dWallet with a network-chosen
   * key. So a BIP39-derived key can't be imported yet.
   */
  async importKeyDwallet(_privateKey: Uint8Array, _curve: Curve, _userShare: UserShareMode, _opts: CreateOptions): Promise<DWalletRef> {
    throw new SignerError(
      'Unsupported',
      'Ika pre-alpha ImportedKeyVerification ignores the supplied key, so recoverable (imported-key) accounts only work with LocalMockSigner for now',
    );
  }

  async transferOwnership(dwallet: DWalletRef, newAuthority: PublicKey): Promise<void> {
    const tx = new Transaction().add(transferOwnershipIx(this.dwalletProgramId, this.identity, new PublicKey(dwallet.address), newAuthority));
    tx.feePayer = this.identity;
    tx.recentBlockhash = (await this.opts.connection.getLatestBlockhash()).blockhash;
    tx.sign(this.opts.identity);
    const sig = await this.opts.connection.sendRawTransaction(tx.serialize());
    await this.opts.connection.confirmTransaction(sig, 'confirmed');
  }

  async publicKey(dwallet: DWalletRef): Promise<Uint8Array> {
    return (await fetchDWallet(this.opts.connection, new PublicKey(dwallet.address))).publicKey;
  }

  private attestation(dwallet: DWalletRef) {
    const a = dwallet.attestation;
    if (!a) throw new SignerError('DWalletNotFound', 'dWallet has no Ika attestation (was it created by IkaPreAlphaSigner?)');
    return { attestation_data: unb64(a.data), network_signature: unb64(a.networkSignature), network_pubkey: unb64(a.networkPubkey), epoch: BigInt(a.epoch) };
  }

  async sign(dwallet: DWalletRef, req: SignRequest, unlock?: ShareUnlocker): Promise<Uint8Array> {
    // Fail clearly if devnet was wiped.
    await fetchDWallet(this.opts.connection, new PublicKey(dwallet.address));
    const pk = Uint8Array.from(Buffer.from(dwallet.publicKey, 'hex'));
    const expected = messageApprovalPda(this.dwalletProgramId, pk, req.scheme, approvalDigest(req.message));
    if (!expected.equals(req.approval)) throw new SignerError('ApprovalMismatch', 'approval PDA does not match message/scheme');
    const maInfo = await this.opts.connection.getAccountInfo(req.approval, 'confirmed');
    if (!maInfo) throw new SignerError('ApprovalMissing', `no MessageApproval at ${req.approval.toBase58()}`);
    const ma = parseMessageApproval(maInfo.data);
    if (ma.status === 'signed' && ma.signature) return ma.signature;

    if (!dwallet.session) throw new SignerError('DWalletNotFound', 'dWallet ref has no Ika DKG session (persist the refs returned by createAccount)');
    const session = Uint8Array.from(Buffer.from(dwallet.session, 'base64'));
    let share: Uint8Array | null = null;
    if (dwallet.userShare === 'encrypted') share = await decryptShare(dwallet.encryptedShare!, unlock, dwallet.shareDomain!);
    try {
      const presignResp = await this.submit(
        dwallet.imported
          ? {
              PresignForDWallet: {
                dwallet_network_encryption_public_key: arr(new Uint8Array(32)),
                dwallet_public_key: arr(pk),
                dwallet_attestation: this.attestation(dwallet),
                curve: { Secp256k1: true },
                signature_algorithm: { ECDSASecp256k1: true },
              },
            }
          : {
              Presign: {
                dwallet_network_encryption_public_key: arr(new Uint8Array(32)),
                curve: { Secp256k1: true },
                signature_algorithm: { ECDSASecp256k1: true },
              },
            },
        this.identity,
        session,
      );
      const presign = this.bcs.VersionedPresignDataAttestation.parse(Uint8Array.from(presignResp.Attestation!.attestation_data));
      const slot = BigInt(req.approvalSlot ?? (await this.opts.connection.getTransaction(req.approvalTx, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }))?.slot ?? 0);
      const signReq = {
        message: arr(req.message),
        message_metadata: [],
        presign_session_identifier: presign.V1!.presign_session_identifier,
        // Pre-alpha: the mock network doesn't verify the centralized party's
        // partial signature; real 2PC-MPC will derive it from `share`.
        message_centralized_signature: arr(new Uint8Array(64)),
        dwallet_attestation: this.attestation(dwallet),
        approval_proof: { Solana: { transaction_signature: arr(bs58.decode(req.approvalTx)), slot } },
      };
      const resp = await this.submit(dwallet.imported ? { ImportedKeySign: signReq } : { Sign: signReq }, this.identity, session);
      if (!resp.Signature) throw new SignerError('IkaError', `unexpected Ika sign response: ${JSON.stringify(resp)}`);
      return Uint8Array.from(resp.Signature.signature);
    } finally {
      share?.fill(0);
    }
  }
}
