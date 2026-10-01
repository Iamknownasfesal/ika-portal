import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { evm } from '@ika-portal/chains';
import { transferOwnershipIx, type DWalletRef, type ShareDomain } from '@ika-portal/signer';
import { encMode, encPolicy, encShare, hexToBytes } from './codec.js';
import { Ctx } from './context.js';
import { IkaAccountHandle } from './account.js';
import { newRecoverableKeys, newRecoveryKey, type RecoveryKey } from './keys.js';
import { IkaPortalError } from './program.js';
import { sendInstructions } from './tx.js';
import type { CreateAccountArgs, IkaPortalOptions } from './types.js';

export interface CreatedAccount {
  account: IkaAccountHandle;
  /** `recoverable` only. Shown once; the SDK never stores it. */
  mnemonic?: string;
  /** `enforced_recovery` only. Shown once; the SDK never stores it. */
  recoveryKey?: RecoveryKey;
  /** Persist these with the account: signer backends may need them to sign. */
  dwallets: DWalletRef[];
}

export interface PreparedAccount {
  account: PublicKey;
  mnemonic?: string;
  recoveryKey?: RecoveryKey;
  dwallets: DWalletRef[];
  /** Transactions to run from the owner, in order (each inner array is one transaction). */
  transactions: TransactionInstruction[][];
}

const DEFAULT_CSV = { mainnet: 4320, testnet: 6, regtest: 6 } as const;

export class IkaPortal {
  private readonly ctx: Ctx;
  private ready: Promise<unknown> | null = null;

  constructor(opts: IkaPortalOptions) {
    this.ctx = new Ctx(opts);
  }

  get programId() {
    return this.ctx.program.programId;
  }
  get program() {
    return this.ctx.program;
  }

  /** Load the program Config (chains, tokens, dWallet program). Called lazily. */
  async init() {
    this.ready ??= this.ctx.loadConfig();
    await this.ready;
    return this.ctx.config;
  }

  accountAddress(owner: PublicKey, index = 0) {
    return this.ctx.program.accountPda(owner, index);
  }

  /**
   * Create the dWallets and build the owner's transactions. dWallets start
   * with authority = owner; each `transfer_ownership` is paired with its
   * `register_dwallet` in one transaction so the claim can't be front-run.
   */
  async prepareAccount(args: CreateAccountArgs): Promise<PreparedAccount> {
    await this.init();
    const { ctx } = this;
    const { signer, unlocker } = ctx.opts;
    const index = args.index ?? 0;
    const isPda = !PublicKey.isOnCurve(args.owner.toBytes());
    if (isPda && args.userShare === 'encrypted') {
      throw new IkaPortalError('PdaOwnerRequiresPublicShare', 'a PDA owner (Squads vault, program) must use userShare: public');
    }
    if (args.userShare === 'encrypted' && !unlocker) throw new IkaPortalError('ShareLocked', 'encrypted accounts need an `unlocker`');

    const account = ctx.program.accountPda(args.owner, index);
    const domain = (slot: ShareDomain['slot']): ShareDomain => ({ programId: ctx.program.programId.toBase58(), account: account.toBase58(), slot });
    const opts = (slot: ShareDomain['slot']) => ({ authority: args.owner, unlock: unlocker, domain: domain(slot) });

    let mnemonic: string | undefined;
    let recoveryKey: RecoveryKey | undefined;
    const created: { ref: DWalletRef; role: 'btc' | 'evm' | 'both' }[] = [];
    if (args.mode === 'recoverable') {
      const keys = newRecoverableKeys(ctx.codec.btcNetwork);
      try {
        created.push({ ref: await signer.importKeyDwallet(keys.btc, 'secp256k1', args.userShare, opts('btc')), role: 'btc' });
        created.push({ ref: await signer.importKeyDwallet(keys.evm, 'secp256k1', args.userShare, opts('evm')), role: 'evm' });
        mnemonic = keys.mnemonic;
      } finally {
        keys.btc.fill(0);
        keys.evm.fill(0);
      }
    } else {
      created.push({ ref: await signer.createDkgDwallet('secp256k1', args.userShare, opts('both')), role: 'both' });
    }

    await args.onDWalletsCreated?.(created.map((c) => c.ref));

    let recovery = null;
    if (args.mode === 'enforced_recovery') {
      recoveryKey = newRecoveryKey();
      const pub = hexToBytes(recoveryKey.publicKey);
      recovery = {
        pubkey: Array.from(pub),
        pubkeyY: Array.from(evm.evmKeyInfo(pub).y),
        csvBlocks: args.recovery?.csvBlocks ?? DEFAULT_CSV[ctx.codec.btcNetwork],
        recoveryDelayS: args.recovery?.evmDelayS ?? 7 * 86_400,
      };
    }

    const payer = ctx.canSignAs(args.owner) ? ctx.feePayer().publicKey : args.owner;
    const create = await ctx.program.createAccount(args.owner, payer, {
      index,
      mode: encMode(args.mode),
      userShare: encShare(args.userShare),
      ikaUser: signer.identity,
      policy: encPolicy(ctx.codec, args.policy),
      recovery,
    });
    const transactions: TransactionInstruction[][] = [[create]];
    for (const { ref, role } of created) {
      const pk = hexToBytes(ref.publicKey);
      const dwallet = new PublicKey(ref.address);
      transactions.push([
        transferOwnershipIx(ctx.config.dwalletProgram, args.owner, dwallet, ctx.program.cpiAuthority()),
        await ctx.program.registerDwallet(args.owner, account, dwallet, role, role === 'btc' ? new Uint8Array(32) : evm.evmKeyInfo(pk).y, payer),
      ]);
    }
    return { account, mnemonic, recoveryKey, dwallets: created.map((c) => c.ref), transactions };
  }

  /** Create an account owned by the connected wallet. For PDA owners use `prepareAccount`. */
  async createAccount(args: CreateAccountArgs): Promise<CreatedAccount> {
    if (!this.ctx.canSignAs(args.owner)) {
      throw new IkaPortalError('OwnerNotWallet', 'owner is not the connected wallet: use prepareAccount() and execute its transactions from the owner');
    }
    const p = await this.prepareAccount(args);
    for (const ixs of p.transactions) await sendInstructions(this.ctx.connection, ixs, this.ctx.feePayer(), [this.ctx.opts.wallet!]);
    const account = await this.loadAccount({ owner: args.owner, index: args.index ?? 0, dwallets: p.dwallets });
    return { account, mnemonic: p.mnemonic, recoveryKey: p.recoveryKey, dwallets: p.dwallets };
  }

  async loadAccount(args: { owner: PublicKey; index?: number; dwallets?: DWalletRef[] }): Promise<IkaAccountHandle> {
    await this.init();
    const address = this.ctx.program.accountPda(args.owner, args.index ?? 0);
    const raw = await this.ctx.program.fetchAccount(address);
    if (!raw) throw new IkaPortalError('AccountNotFound', `no account at ${address.toBase58()}`);
    const view = this.ctx.decodeAccount(address, raw);
    // Fail clearly if pre-alpha devnet state was wiped under us.
    for (const d of view.dwallets) {
      if (!(await this.ctx.connection.getAccountInfo(d.address))) {
        throw new IkaPortalError('DWalletNotFound', `dWallet ${d.address.toBase58()} no longer exists (Ika pre-alpha devnet is wiped periodically)`);
      }
    }
    return new IkaAccountHandle(this.ctx, view, args.dwallets ?? []);
  }

  /** Wait until an account created by a PDA owner (e.g. Squads) exists and is registered. */
  async waitForAccount(args: { owner: PublicKey; index?: number; dwallets?: DWalletRef[]; timeoutMs?: number }) {
    const start = Date.now();
    for (;;) {
      try {
        const a = await this.loadAccount(args);
        if (a.view.dwallets.length) return a;
      } catch (e) {
        if ((e as IkaPortalError).code !== 'AccountNotFound') throw e;
      }
      if (Date.now() - start > (args.timeoutMs ?? 300_000)) throw new IkaPortalError('Timeout', 'account did not appear');
      await new Promise((r) => setTimeout(r, this.ctx.pollMs));
    }
  }
}
