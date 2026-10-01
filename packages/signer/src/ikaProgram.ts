/**
 * Ika dWallet program: PDAs, instruction builders and account readers for the
 * subset Ika Portal uses. Layouts follow the pre-alpha account reference
 * (https://solana-pre-alpha.ika.xyz/reference/accounts.html); the npm client
 * (`@ika.xyz/pre-alpha-solana-client`) ships gRPC/BCS types but no Solana
 * account readers, so these mirror the documented offsets exactly.
 */
import { Buffer } from 'buffer';
import { PublicKey, TransactionInstruction, type Connection } from '@solana/web3.js';
import { SignerError } from './types.js';

export const IKA_DEVNET_PROGRAM_ID = new PublicKey('87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY');
export const IKA_DEVNET_GRPC = 'pre-alpha-dev-1.ika.ika-network.net:443';
export const CPI_AUTHORITY_SEED = Buffer.from('__ika_cpi_authority');
export const CURVE_SECP256K1 = 0;

const enc = (s: string) => Buffer.from(s);

export function dwalletSeeds(curve: number, publicKey: Uint8Array): Buffer[] {
  const payload = Buffer.alloc(2 + publicKey.length);
  payload.writeUInt16LE(curve, 0);
  Buffer.from(publicKey).copy(payload, 2);
  const seeds = [enc('dwallet')];
  for (let i = 0; i < payload.length; i += 32) seeds.push(payload.subarray(i, Math.min(i + 32, payload.length)));
  return seeds;
}

export const dwalletPda = (programId: PublicKey, publicKey: Uint8Array, curve = CURVE_SECP256K1) =>
  PublicKey.findProgramAddressSync(dwalletSeeds(curve, publicKey), programId)[0];

export function messageApprovalPda(programId: PublicKey, publicKey: Uint8Array, scheme: number, messageDigest: Uint8Array, curve = CURVE_SECP256K1) {
  const s = Buffer.alloc(2);
  s.writeUInt16LE(scheme, 0);
  return PublicKey.findProgramAddressSync([...dwalletSeeds(curve, publicKey), enc('message_approval'), s, Buffer.from(messageDigest)], programId)[0];
}

export const coordinatorPda = (programId: PublicKey) => PublicKey.findProgramAddressSync([enc('dwallet_coordinator')], programId)[0];
export const gasDepositPda = (programId: PublicKey, user: PublicKey) =>
  PublicKey.findProgramAddressSync([enc('gas_deposit'), user.toBuffer()], programId)[0];
export const cpiAuthorityPda = (callerProgram: PublicKey) => PublicKey.findProgramAddressSync([CPI_AUTHORITY_SEED], callerProgram)[0];

/** `transfer_ownership` (disc 24), signer path. */
export function transferOwnershipIx(programId: PublicKey, currentAuthority: PublicKey, dwallet: PublicKey, newAuthority: PublicKey) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: currentAuthority, isSigner: true, isWritable: false },
      { pubkey: dwallet, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from([24]), newAuthority.toBuffer()]),
  });
}

export interface DWalletAccount {
  authority: PublicKey;
  curve: number;
  state: 'dkg' | 'active' | 'frozen';
  publicKey: Uint8Array;
  imported: boolean;
}

export function parseDWallet(data: Uint8Array): DWalletAccount {
  const d = Buffer.from(data);
  if (d.length < 153 || d[0] !== 2) throw new Error('not a DWallet account');
  const len = d[37]!;
  return {
    authority: new PublicKey(d.subarray(2, 34)),
    curve: d.readUInt16LE(34),
    state: (['dkg', 'active', 'frozen'] as const)[d[36]!] ?? 'frozen',
    publicKey: new Uint8Array(d.subarray(38, 38 + len)),
    imported: d[143] === 1,
  };
}

export interface MessageApprovalAccount {
  dwallet: PublicKey;
  messageDigest: Uint8Array;
  metadataDigest: Uint8Array;
  approver: PublicKey;
  userPubkey: PublicKey;
  scheme: number;
  epoch: bigint;
  status: 'pending' | 'signed';
  signature: Uint8Array | null;
}

export function parseMessageApproval(data: Uint8Array): MessageApprovalAccount {
  const d = Buffer.from(data);
  if (d.length < 312 || d[0] !== 14) throw new Error('not a MessageApproval account');
  const sigLen = d.readUInt16LE(173);
  return {
    dwallet: new PublicKey(d.subarray(2, 34)),
    messageDigest: new Uint8Array(d.subarray(34, 66)),
    metadataDigest: new Uint8Array(d.subarray(66, 98)),
    approver: new PublicKey(d.subarray(98, 130)),
    userPubkey: new PublicKey(d.subarray(130, 162)),
    scheme: d.readUInt16LE(162),
    epoch: d.readBigUInt64LE(164),
    status: d[172] === 1 ? 'signed' : 'pending',
    signature: d[172] === 1 ? new Uint8Array(d.subarray(175, 175 + sigLen)) : null,
  };
}

export async function readEpoch(connection: Connection, programId: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(coordinatorPda(programId));
  if (!info || info.data.length < 42 || info.data[0] !== 1) return 1n;
  return Buffer.from(info.data).readBigUInt64LE(34);
}

export async function fetchDWallet(connection: Connection, address: PublicKey): Promise<DWalletAccount> {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new SignerError('DWalletNotFound', `dWallet ${address.toBase58()} not found (pre-alpha devnet state may have been wiped)`);
  return parseDWallet(info.data);
}

export async function pollAccount(connection: Connection, address: PublicKey, check: (d: Buffer) => boolean, timeoutMs = 60_000, intervalMs = 750): Promise<Buffer> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await connection.getAccountInfo(address, 'confirmed').catch(() => null);
    if (info && check(Buffer.from(info.data))) return Buffer.from(info.data);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${address.toBase58()}`);
}
