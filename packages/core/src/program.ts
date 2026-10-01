import { Buffer } from 'buffer';
import { Program, type Provider } from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountMeta,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { cpiAuthorityPda, coordinatorPda } from '@ika-portal/signer';
import idlJson from './idl/ika_account.json' with { type: 'json' };
import type { IkaAccountIdl } from './idl/ika_account.js';
import BN from 'bn.js';
import { bn, big } from './codec.js';

export const IKA_ACCOUNT_PROGRAM_ID = new PublicKey(idlJson.address);

const seed = (s: string) => Buffer.from(s);
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export interface ApprovalRaw {
  messageDigest: Uint8Array;
  finalDigest: Uint8Array;
  scheme: number;
  messageApproval: PublicKey;
}

/** Thin, typed wrapper over the Anchor client for `ika_account`. */
export class IkaProgram {
  readonly program: Program<IkaAccountIdl>;

  constructor(
    readonly connection: Connection,
    readonly programId: PublicKey = IKA_ACCOUNT_PROGRAM_ID,
  ) {
    const idl = { ...(idlJson as object), address: programId.toBase58() } as IkaAccountIdl;
    this.program = new Program<IkaAccountIdl>(idl, { connection } as Provider);
  }

  // ── PDAs ──
  configPda() {
    return PublicKey.findProgramAddressSync([seed('config')], this.programId)[0];
  }
  accountPda(owner: PublicKey, index: number) {
    return PublicKey.findProgramAddressSync([seed('account'), owner.toBuffer(), u16le(index)], this.programId)[0];
  }
  intentPda(account: PublicKey, nonce: bigint) {
    return PublicKey.findProgramAddressSync([seed('intent'), account.toBuffer(), u64le(nonce)], this.programId)[0];
  }
  claimPda(dwallet: PublicKey) {
    return PublicKey.findProgramAddressSync([seed('claim'), dwallet.toBuffer()], this.programId)[0];
  }
  cpiAuthority() {
    return cpiAuthorityPda(this.programId);
  }

  // ── Fetch ──
  async fetchConfig(): Promise<Raw> {
    return this.program.account.config.fetch(this.configPda());
  }
  async fetchAccount(address: PublicKey): Promise<Raw | null> {
    return this.program.account.ikaAccount.fetchNullable(address, 'confirmed');
  }
  async fetchIntent(address: PublicKey): Promise<Raw | null> {
    return this.program.account.intent.fetchNullable(address, 'confirmed');
  }
  async intentsOf(account: PublicKey): Promise<{ publicKey: PublicKey; account: Raw }[]> {
    return this.program.account.intent.all([{ memcmp: { offset: 8, bytes: account.toBase58() } }]);
  }

  // ── Instructions ──
  initializeConfig(admin: PublicKey, args: Raw) {
    return this.program.methods
      .initializeConfig(args)
      .accountsStrict({ config: this.configPda(), admin, systemProgram: SystemProgram.programId })
      .instruction();
  }

  updateConfig(admin: PublicKey, args: Raw) {
    return this.program.methods.updateConfig(args).accountsStrict({ config: this.configPda(), admin }).instruction();
  }

  createAccount(owner: PublicKey, payer: PublicKey, args: Raw) {
    return this.program.methods
      .createAccount(args)
      .accountsStrict({ account: this.accountPda(owner, args.index), owner, payer, systemProgram: SystemProgram.programId })
      .instruction();
  }

  registerDwallet(owner: PublicKey, account: PublicKey, dwallet: PublicKey, role: 'btc' | 'evm' | 'both', evmY: Uint8Array, payer = owner) {
    return this.program.methods
      .registerDwallet({ [role]: {} } as never, Array.from(evmY))
      .accountsStrict({
        account,
        owner,
        config: this.configPda(),
        dwallet,
        cpiAuthority: this.cpiAuthority(),
        claim: this.claimPda(dwallet),
        payer,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  proposeIntent(owner: PublicKey, payer: PublicKey, account: PublicKey, intentNonce: bigint, params: Raw) {
    return this.program.methods
      .proposeIntent(params)
      .accountsStrict({
        account,
        owner,
        config: this.configPda(),
        intent: this.intentPda(account, intentNonce),
        payer,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  cancelIntent(owner: PublicKey, account: PublicKey, intent: PublicKey) {
    return this.program.methods.cancelIntent().accountsStrict({ account, owner, intent }).instruction();
  }

  async approveIntent(args: {
    account: PublicKey;
    intent: PublicKey;
    dwallet: PublicKey;
    dwalletProgram: PublicKey;
    payer: PublicKey;
    messageApprovals: PublicKey[];
  }): Promise<TransactionInstruction[]> {
    const remaining: AccountMeta[] = args.messageApprovals.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
    const ix = await this.program.methods
      .approveIntent()
      .accountsStrict({
        account: args.account,
        config: this.configPda(),
        intent: args.intent,
        dwallet: args.dwallet,
        coordinator: coordinatorPda(args.dwalletProgram),
        cpiAuthority: this.cpiAuthority(),
        callerProgram: this.programId,
        dwalletProgram: args.dwalletProgram,
        payer: args.payer,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remaining)
      .instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix];
  }

  /** Simulate `preview_digests` and return what the program would approve (read-only). */
  async previewDigests(account: PublicKey, params: Raw, evmNonce: bigint, payer: PublicKey): Promise<{ messageDigest: Uint8Array; finalDigest: Uint8Array; scheme: number }[]> {
    const ix = await this.program.methods.previewDigests(params, bn(evmNonce)).accountsStrict({ account, config: this.configPda() }).instruction();
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
    tx.feePayer = payer;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    const sim = await this.connection.simulateTransaction(tx);
    if (sim.value.err) throw decodeProgramError({ message: JSON.stringify(sim.value.err), logs: sim.value.logs ?? [] });
    const data = Buffer.from(sim.value.returnData?.data?.[0] ?? '', 'base64');
    const n = data.length >= 4 ? data.readUInt32LE(0) : 0;
    const out = [];
    for (let i = 0, o = 4; i < n; i++, o += 66) {
      out.push({
        messageDigest: new Uint8Array(data.subarray(o, o + 32)),
        finalDigest: new Uint8Array(data.subarray(o + 32, o + 64)),
        scheme: data.readUInt16LE(o + 64),
      });
    }
    return out;
  }

  proposePolicy(owner: PublicKey, account: PublicKey, next: Raw) {
    return this.program.methods.proposePolicy(next).accountsStrict({ account, owner }).instruction();
  }
  applyPolicy(account: PublicKey) {
    return this.program.methods.applyPolicy().accountsStrict({ account }).instruction();
  }
  cancelPolicy(owner: PublicKey, account: PublicKey) {
    return this.program.methods.cancelPolicy().accountsStrict({ account, owner }).instruction();
  }
  setEvmNonce(owner: PublicKey, account: PublicKey, chainId: number, nonce: bigint) {
    return this.program.methods.setEvmNonce(bn(chainId), bn(nonce)).accountsStrict({ account, owner }).instruction();
  }

  static approvals(intent: Raw): ApprovalRaw[] {
    return (intent.approvals as Raw[]).map((a) => ({
      messageDigest: Uint8Array.from(a.messageDigest),
      finalDigest: Uint8Array.from(a.finalDigest),
      scheme: a.scheme,
      messageApproval: a.messageApproval as PublicKey,
    }));
  }

  static num = big;
  static bn = () => BN;
}

// ── Errors ──

const ERRORS = new Map<number, { name: string; msg: string }>(
  (idlJson.errors as { code: number; name: string; msg: string }[]).map((e) => [e.code, { name: e.name, msg: e.msg }]),
);

export type ProgramErrorName = (typeof idlJson.errors)[number]['name'];

export class IkaPortalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly logs?: string[],
  ) {
    super(message);
    this.name = 'IkaPortalError';
  }
}

/** Map a failed transaction/simulation to the program's typed error (e.g. `LimitExceeded`). */
export function decodeProgramError(e: unknown): IkaPortalError {
  const err = e as { logs?: string[]; message?: string; transactionLogs?: string[]; getLogs?: () => string[] };
  const logs = err.logs ?? err.transactionLogs ?? [];
  const text = `${err.message ?? String(e)}\n${logs.join('\n')}`;
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i);
  const dec = text.match(/Error Number: (\d+)/) ?? text.match(/"Custom":\s*(\d+)/);
  const code = hex ? parseInt(hex[1]!, 16) : dec ? Number(dec[1]) : null;
  if (code !== null && ERRORS.has(code)) {
    const { name, msg } = ERRORS.get(code)!;
    return new IkaPortalError(name, msg, logs);
  }
  if (e instanceof IkaPortalError) return e;
  return new IkaPortalError('TransactionFailed', err.message ?? String(e), logs);
}

export const programErrors = () => [...ERRORS.entries()].map(([code, v]) => ({ code, ...v }));
