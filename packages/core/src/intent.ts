/**
 * Intent lifecycle: proposed → (delayed) → approved → signed → broadcast → confirmed.
 *
 * The SDK rebuilds every preimage from the on-chain Intent (never from local
 * state) and refuses to request a signature unless keccak256(preimage) equals
 * the digest the program approved.
 */
import { Buffer } from 'buffer';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type TransactionInstruction } from '@solana/web3.js';
import { btc, evm, type EvmChain } from '@ika-portal/chains';
import { approvalDigest, messageApprovalPda as messageApprovalPdaFor, type DWalletRef, type Scheme } from '@ika-portal/signer';
import { getAddress, keccak256, serializeTransaction, type Address, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { bytesHex, big, decChain, decKind, decStatus } from './codec.js';
import type { AccountView, Ctx } from './context.js';
import { IkaPortalError, IkaProgram } from './program.js';
import { sendInstructions, sleep } from './tx.js';
import type { ProgressEvent } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

type Assembly =
  | { kind: 'evm-direct'; chain: EvmChain; tx: TransactionSerializableEIP1559 }
  | { kind: 'evm-execute'; chain: EvmChain; call: evm.EvmCall; deadline: bigint }
  | { kind: 'evm-setup'; chain: EvmChain; implementation: Address; eoaNonce: number; recoveryKey: Address; recoveryDelay: bigint }
  | { kind: 'evm-cancel'; chain: EvmChain; deadline: bigint }
  | { kind: 'btc'; plan: btc.BtcSpendPlan; lock: btc.BtcLock };

interface Built {
  preimages: Uint8Array[];
  schemes: Scheme[];
  assembly: Assembly;
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** Solana cluster unix time (Clock sysvar). */
export async function chainNow(ctx: Ctx): Promise<number> {
  const info = await ctx.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  return info ? Number(Buffer.from(info.data).readBigInt64LE(32)) : Math.floor(Date.now() / 1000);
}
const isZero = (b: number[]) => b.every((x) => x === 0);

/** Rebuild preimages for an on-chain intent exactly as the program does. */
export function buildFromIntent(ctx: Ctx, acct: AccountView, intent: Raw): Built {
  const p = intent.params;
  const chain = decChain(p.chain);
  const amount = big(p.amount);
  if (chain === 'bitcoin') {
    const lock = ctx.btcLock(acct);
    const inputs: btc.Utxo[] = p.btc.inputs.map((i: Raw) => ({
      txid: Buffer.from(Uint8Array.from(i.txid)).reverse().toString('hex'),
      vout: i.vout,
      value: big(i.value),
    }));
    const plan = btc.planSpend(inputs, Uint8Array.from(p.to), amount, big(p.btc.fee), lock);
    const preimages = btc.bip143Preimages(plan, lock);
    return { preimages, schemes: preimages.map(() => 2 as Scheme), assembly: { kind: 'btc', plan, lock } };
  }
  const ec = ctx.evmChain(chain);
  const account = acct.evmAddress!;
  const e = p.evm;
  const variant = Object.keys(e)[0]!;
  const v = e[variant];
  const call = () => evm.evmCall(isZero(p.asset) ? null : getAddress(`0x${bytesHex(p.asset)}`), getAddress(`0x${bytesHex(p.to)}`), amount);
  const one = (s: evm.EvmSignable) => [s.preimage];
  switch (variant) {
    case 'direct': {
      const tx = evm.eip1559Tx(
        { chainId: ec.chainId, nonce: Number(v.nonce), gas: big(v.gasLimit), maxFeePerGas: big(v.maxFeePerGas), maxPriorityFeePerGas: big(v.maxPriorityFeePerGas) },
        call(),
      );
      return { preimages: one(evm.eip1559Signable(tx)), schemes: [0], assembly: { kind: 'evm-direct', chain, tx } };
    }
    case 'delegated': {
      const c = call();
      const deadline = big(v.deadline);
      return {
        preimages: one(evm.executeSignable(ec.chainId, account, c, big(intent.evmNonce), deadline)),
        schemes: [0],
        assembly: { kind: 'evm-execute', chain, call: c, deadline },
      };
    }
    case 'setup': {
      const recoveryKey = acct.mode === 'enforced_recovery' ? acct.recoveryEvmAddress! : ZERO;
      const recoveryDelay = acct.mode === 'enforced_recovery' ? BigInt(acct.recoveryDelayS) : 0n;
      const eoaNonce = Number(v.eoaNonce);
      return {
        preimages: [
          evm.authorizationSignable(ec.chainId, ec.implementation, eoaNonce).preimage,
          evm.initSignable(ec.chainId, account, recoveryKey, recoveryDelay).preimage,
        ],
        schemes: [0, 0],
        assembly: { kind: 'evm-setup', chain, implementation: ec.implementation, eoaNonce, recoveryKey, recoveryDelay },
      };
    }
    case 'cancelRecovery': {
      const deadline = big(v.deadline);
      return {
        preimages: one(evm.cancelRecoverySignable(ec.chainId, account, big(intent.evmNonce), deadline)),
        schemes: [0],
        assembly: { kind: 'evm-cancel', chain, deadline },
      };
    }
  }
  throw new IkaPortalError('InvalidIntentParams', `unknown EVM params ${variant}`);
}

class Channel<T> {
  private buf: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private done = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
  }
  close() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  async *iterate(): AsyncGenerator<T> {
    for (;;) {
      if (this.buf.length) {
        yield this.buf.shift()!;
        continue;
      }
      if (this.done) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

export interface IntentSource {
  /** Instructions that propose the intent (owner-signed). */
  proposeIxs: TransactionInstruction[];
  /** Intent PDA the proposal creates. */
  intent: PublicKey;
  owner: PublicKey;
}

export interface IntentResult {
  intent: PublicKey;
  solanaTx?: string;
  destinationTx?: string;
  destinationTxUrl?: string;
}

export interface SignedIntent {
  intent: PublicKey;
  solanaTx?: string;
  /** The preimages Ika signed and the 32-byte digests (hash per scheme). */
  preimages: Uint8Array[];
  digests: Uint8Array[];
  /** Raw 64-byte r‖s signatures as returned by the signer. */
  signatures: Uint8Array[];
  /** Ready-to-broadcast transaction for BTC and EVM direct mode (hex). */
  rawTransaction?: string;
}

/** Handle for one intent. Iterate `progress()` for updates or `await wait()`. */
export class IntentHandle {
  readonly intent: PublicKey;
  private channel = new Channel<ProgressEvent>();
  private started: Promise<IntentResult> | null = null;
  private last: ProgressEvent | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly accountAddress: PublicKey,
    private readonly dwalletRefs: () => DWalletRef[],
    private readonly source: IntentSource | { intent: PublicKey; owner: PublicKey; proposeIxs?: undefined },
    private readonly hooks: { onBroadcast?: (txHash: string) => Promise<void> } = {},
  ) {
    this.intent = source.intent;
  }

  private emit(e: ProgressEvent) {
    this.last = e;
    this.channel.push({ intent: this.intent, ...e });
  }

  private start(): Promise<IntentResult> {
    this.started ??= this.run().then(
      (r) => {
        this.channel.close();
        return r;
      },
      (err: Error) => {
        this.emit({ status: 'failed', error: err });
        this.channel.close();
        throw err;
      },
    );
    return this.started;
  }

  progress(): AsyncGenerator<ProgressEvent> {
    void this.start().catch(() => undefined);
    return this.channel.iterate();
  }

  wait(): Promise<IntentResult> {
    return this.start();
  }

  get status() {
    return this.last?.status;
  }

  private async fetchIntent() {
    return this.ctx.program.fetchIntent(this.intent);
  }

  /**
   * Propose/approve/sign but do not broadcast: returns signatures and, where
   * applicable, the raw transaction so the wallet can broadcast it itself.
   */
  async signOnly(): Promise<SignedIntent> {
    let signed: SignedIntent | undefined;
    await this.run((s) => {
      signed = s;
      return false;
    });
    return signed!;
  }

  private async run(onSigned?: (s: SignedIntent) => boolean): Promise<IntentResult> {
    const { ctx } = this;
    let raw = await this.fetchIntent();

    // 1. Propose (or wait for the owner, e.g. a Squads vault transaction).
    if (!raw) {
      if (this.source.proposeIxs && ctx.canSignAs(this.source.owner)) {
        this.emit({ status: 'building' });
        await sendInstructions(ctx.connection, this.source.proposeIxs, ctx.feePayer(), [ctx.opts.wallet!]);
      } else {
        this.emit({ status: 'awaiting_owner', instructions: this.source.proposeIxs });
      }
      while (!(raw = await this.fetchIntent())) await sleep(ctx.pollMs);
    }
    const status = decStatus(raw.status);
    if (status === 'cancelled') {
      this.emit({ status: 'cancelled' });
      return { intent: this.intent };
    }
    this.emit({ status: 'proposed', executableAt: Number(raw.executableAt) });

    const acctRaw = await ctx.program.fetchAccount(this.accountAddress);
    const acct = ctx.decodeAccount(this.accountAddress, acctRaw);
    const chain = decChain(raw.params.chain);
    const entry = acct.dwallets.find((d) => d.role === 'both' || (chain === 'bitcoin' ? d.role === 'btc' : d.role === 'evm'));
    if (!entry) throw new IkaPortalError('AccountNotReady', `no dWallet for ${chain}`);

    // 2. Approve (permissionless) once executable.
    let solanaTx: string | undefined;
    let slot: number | undefined;
    if (status === 'proposed') {
      // Delays are measured on the Solana clock, which can differ from wall time.
      const execAt = Number(raw.executableAt);
      if (execAt > Number(raw.createdAt) || execAt > (await chainNow(ctx))) {
        this.emit({ status: 'delayed', executableAt: execAt });
        while ((await chainNow(ctx)) < execAt) await sleep(ctx.pollMs);
      }
      const preview = buildFromIntent(ctx, acct, { ...raw, evmNonce: this.predictEvmNonce(acct, raw) });
      const maPdas = preview.preimages.map((m, i) =>
        this.maPda(entry.publicKey, preview.schemes[i]!, m),
      );
      const ixs = await ctx.program.approveIntent({
        account: this.accountAddress,
        intent: this.intent,
        dwallet: entry.address,
        dwalletProgram: ctx.config.dwalletProgram,
        payer: ctx.feePayer().publicKey,
        messageApprovals: maPdas,
      });
      for (let attempt = 0; ; attempt++) {
        try {
          ({ signature: solanaTx, slot } = await sendInstructions(ctx.connection, ixs, ctx.feePayer()));
          break;
        } catch (e) {
          // Validator clock can trail wall time by a few seconds.
          if ((e as IkaPortalError).code === 'NotExecutableYet' && attempt < 30) {
            await sleep(1000);
            continue;
          }
          throw e;
        }
      }
      raw = (await this.fetchIntent())!;
    } else {
      solanaTx = (await ctx.connection.getSignaturesForAddress(this.intent, { limit: 1 }))[0]?.signature;
    }
    this.emit({ status: 'approved', solanaTx });

    // 3. Rebuild preimages from the approved intent and verify them.
    const built = buildFromIntent(ctx, acct, raw);
    const approvals = IkaProgram.approvals(raw);
    if (approvals.length !== built.preimages.length) throw new IkaPortalError('DigestMismatch', 'approval count mismatch');
    built.preimages.forEach((m, i) => {
      if (bytesHex(approvalDigest(m)) !== bytesHex(approvals[i]!.messageDigest)) {
        throw new IkaPortalError('DigestMismatch', `local preimage ${i} does not match the approved digest; refusing to sign`);
      }
    });

    // 4. Sign each approved digest.
    const ref = this.dwalletRefs().find((r) => r.address === entry.address.toBase58()) ?? this.minimalRef(entry, acct);
    const sigs: Uint8Array[] = [];
    for (let i = 0; i < built.preimages.length; i++) {
      sigs.push(
        await ctx.opts.signer.sign(
          ref,
          { approval: approvals[i]!.messageApproval, message: built.preimages[i]!, scheme: built.schemes[i]!, approvalTx: solanaTx!, approvalSlot: slot },
          ctx.opts.unlocker,
        ),
      );
    }
    this.emit({ status: 'signed', solanaTx });

    if (onSigned) {
      const digests = approvals.map((a) => a.finalDigest);
      const signedIntent: SignedIntent = { intent: this.intent, solanaTx, preimages: built.preimages, digests, signatures: sigs, rawTransaction: await this.rawTx(acct, built.assembly, sigs, digests) };
      if (!onSigned(signedIntent)) return { intent: this.intent, solanaTx };
    }

    // 5. Assemble + broadcast. 6. Confirm.
    const out = await this.broadcast(acct, built.assembly, sigs, approvals.map((a) => a.finalDigest));
    this.emit({ status: 'broadcast', solanaTx, destinationTx: out.hash, destinationTxUrl: out.url });
    await this.hooks.onBroadcast?.(out.hash);
    await out.confirm();
    this.emit({ status: 'confirmed', solanaTx, destinationTx: out.hash, destinationTxUrl: out.url });
    return { intent: this.intent, solanaTx, destinationTx: out.hash, destinationTxUrl: out.url };
  }

  private predictEvmNonce(acct: AccountView, raw: Raw): bigint {
    const chain = decChain(raw.params.chain);
    if (chain === 'bitcoin') return 0n;
    const chainId = this.ctx.evmChain(chain).chainId;
    return acct.evmNonces.find((n) => n.chainId === chainId)?.nonce ?? 0n;
  }

  private maPda(pk: Uint8Array, scheme: number, preimage: Uint8Array) {
    // Same derivation as the program (Ika seeds: dwallet chunks, scheme, keccak(preimage)).
    return messageApprovalPdaFor(this.ctx.config.dwalletProgram, pk, scheme, approvalDigest(preimage));
  }

  private minimalRef(entry: AccountView['dwallets'][number], acct: AccountView): DWalletRef {
    return {
      address: entry.address.toBase58(),
      publicKey: bytesHex(entry.publicKey),
      curve: 'secp256k1',
      imported: acct.mode === 'recoverable',
      userShare: acct.userShare,
      backend: this.ctx.opts.signer.kind,
    };
  }

  private async rawTx(acct: AccountView, a: Assembly, sigs: Uint8Array[], digests: Uint8Array[]): Promise<string | undefined> {
    if (a.kind === 'btc') {
      const der = sigs.map((s, i) => btc.toBitcoinSignature(s, digests[i]!, a.lock.type === 'p2wpkh' ? a.lock.pubkey : a.lock.dwalletPubkey));
      return btc.finalizeTx(a.plan, a.lock, der).hex;
    }
    if (a.kind === 'evm-direct') {
      const s = await evm.toEvmSignature(sigs[0]!, `0x${bytesHex(digests[0]!)}`, acct.evmAddress!);
      return serializeTransaction(a.tx, { r: s.r, s: s.s, yParity: s.yParity });
    }
    return undefined;
  }

  private async broadcast(acct: AccountView, a: Assembly, sigs: Uint8Array[], digests: Uint8Array[]): Promise<{ hash: string; url?: string; confirm: () => Promise<void> }> {
    const { ctx } = this;
    const hex = (d: Uint8Array) => `0x${bytesHex(d)}` as Hex;
    if (a.kind === 'btc') {
      const b = ctx.bitcoin();
      const der = sigs.map((s, i) => btc.toBitcoinSignature(s, digests[i]!, a.lock.type === 'p2wpkh' ? a.lock.pubkey : a.lock.dwalletPubkey));
      const { hex: rawTx, txid } = btc.finalizeTx(a.plan, a.lock, der);
      await b.backend.broadcast(rawTx).catch((e: Error) => {
        // Resuming an intent that was already broadcast: same txid, fine.
        if (!/already (in|known)|txn-already|Transaction already/i.test(e.message)) throw e;
      });
      return {
        hash: txid,
        url: b.explorer ? `${b.explorer.replace(/\/$/, '')}/tx/${txid}` : undefined,
        confirm: async () => {
          for (;;) {
            const t = await b.backend.tx(txid);
            if (t && t.confirmations >= 1) return;
            await sleep(ctx.pollMs * 2);
          }
        },
      };
    }
    const adapter = ctx.evm(a.chain);
    const account = acct.evmAddress!;
    const receipt = (hash: Hex) => async () => {
      const r = await adapter.waitForReceipt(hash);
      if (r.status !== 'success') throw new IkaPortalError('EvmReverted', `transaction ${hash} reverted`);
    };
    const withUrl = (hash: Hex) => ({ hash, url: adapter.txUrl(hash), confirm: receipt(hash) });
    const sig = (i: number) => evm.toEvmSignature(sigs[i]!, hex(digests[i]!), account);
    const relayer = () => {
      if (!ctx.relayer) throw new IkaPortalError('NoRelayer', 'delegated EVM execution needs `relayerUrl`');
      return ctx.relayer;
    };
    switch (a.kind) {
      case 'evm-direct': {
        const s = await sig(0);
        const raw = serializeTransaction(a.tx, { r: s.r, s: s.s, yParity: s.yParity });
        try {
          return withUrl(await adapter.broadcastDirect(a.tx, s));
        } catch (e) {
          // Resuming an intent that was already broadcast: return its hash.
          if (/already known|nonce too low/i.test((e as Error).message)) return withUrl(keccak256(raw));
          throw e;
        }
      }
      case 'evm-execute': {
        const s = await sig(0);
        const { hash } = await relayer().execute({ chainId: adapter.chainId, account, ...a.call, deadline: a.deadline, sig: s.serialized });
        return withUrl(hash);
      }
      case 'evm-cancel': {
        const s = await sig(0);
        const { hash } = await relayer().cancelRecovery({ chainId: adapter.chainId, account, deadline: a.deadline, sig: s.serialized });
        return withUrl(hash);
      }
      case 'evm-setup': {
        const auth = await sig(0);
        const init = await sig(1);
        const { hash } = await relayer().setup({
          chainId: adapter.chainId,
          account,
          authorization: { address: a.implementation, chainId: adapter.chainId, nonce: a.eoaNonce, r: auth.r, s: auth.s, yParity: auth.yParity },
          initArgs: { recoveryKey: a.recoveryKey, recoveryDelay: a.recoveryDelay, sig: init.serialized },
        });
        return withUrl(hash);
      }
    }
  }
}

export const intentKindOf = (raw: Raw) => decKind(raw.params.kind);
export const intentStatusOf = (raw: Raw) => decStatus(raw.status);
export { PublicKey };
