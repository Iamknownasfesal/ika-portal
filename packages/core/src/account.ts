import { Buffer } from 'buffer';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { btc, evm, isEvmChain, NATIVE, type AssetSymbol, type Chain, type EvmChain } from '@ika-portal/chains';
import type { DWalletRef } from '@ika-portal/signer';
import { assertOwnAddresses, type PreparedSwap, type Quote, type QuoteAllResult, type SwapStatus } from '@ika-portal/swap';
import { getAddress } from 'viem';
import { bn, encAddress, encAsset, encChain, encKind, encPolicy } from './codec.js';
import type { AccountView, Ctx } from './context.js';
import { IntentHandle } from './intent.js';
import { previewPolicy, type PolicyResult } from './policyPreview.js';
import { IkaPortalError } from './program.js';
import { sendInstructions, sleep } from './tx.js';
import type { Addresses, IntentKind, Policy, SendArgs } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

const DIRECT_GAS_FALLBACK = { ETH: 21_000n, token: 65_000n };

export interface PreparedIntent {
  params: Raw;
  kind: IntentKind;
  chain: Chain;
  asset: AssetSymbol;
  to: string;
  amount: bigint;
  /** BTC effective fee (sats) or EVM direct max fee (wei), for policy preview. */
  fee?: bigint;
}

export interface SwapHandle {
  prepared: PreparedSwap;
  intent: IntentHandle;
  /** Resolves when the provider reports a final state. */
  wait(): Promise<SwapStatus>;
}

/** An Ika account: one Solana owner controlling Bitcoin + EVM addresses. */
export class IkaAccountHandle {
  constructor(
    private readonly ctx: Ctx,
    public view: AccountView,
    /** dWallet references to persist alongside the account (needed by some signer backends). */
    public readonly dwallets: DWalletRef[] = [],
  ) {}

  get address() {
    return this.view.address;
  }
  get owner() {
    return this.view.owner;
  }
  get mode() {
    return this.view.mode;
  }
  get policy(): Policy {
    return this.view.policy;
  }
  get addresses(): Addresses {
    return this.ctx.addresses(this.view);
  }

  async refresh(): Promise<this> {
    const raw = await this.ctx.program.fetchAccount(this.view.address);
    if (!raw) throw new IkaPortalError('AccountNotFound', `account ${this.view.address.toBase58()} not found`);
    this.view = this.ctx.decodeAccount(this.view.address, raw);
    return this;
  }

  isDelegated(chain: EvmChain): boolean {
    const id = this.ctx.evmChain(chain).chainId;
    return this.view.evmNonces.some((n) => n.chainId === id && n.delegated);
  }

  async balances(): Promise<Partial<Record<Chain, Partial<Record<AssetSymbol, bigint>>>>> {
    const out: Partial<Record<Chain, Partial<Record<AssetSymbol, bigint>>>> = {};
    const a = this.addresses;
    const jobs: Promise<void>[] = [];
    if (a.bitcoin && this.ctx.opts.chains.bitcoin) {
      jobs.push(
        this.ctx.bitcoin().backend.utxos(a.bitcoin).then((u) => {
          out.bitcoin = { BTC: u.reduce((s, x) => s + x.value, 0n) };
        }),
      );
    }
    for (const chain of ['ethereum', 'base'] as const) {
      const addr = a[chain];
      const cfg = this.ctx.opts.chains[chain];
      if (!addr || !cfg) continue;
      const adapter = this.ctx.evm(chain);
      const assets: AssetSymbol[] = ['ETH', ...(Object.keys(cfg.tokens ?? {}) as AssetSymbol[])];
      out[chain] = {};
      for (const asset of assets) {
        jobs.push(
          adapter.balance(addr, asset).then((v) => {
            out[chain]![asset] = v;
          }),
        );
      }
    }
    await Promise.all(jobs);
    return out;
  }

  // ── Building intents ─────────────────────────────────────────────────

  private base(kind: IntentKind, chain: Chain, asset: AssetSymbol, to: string, amount: bigint) {
    const c = this.ctx.codec;
    return {
      kind: encKind(kind),
      chain: encChain(chain),
      asset: encAsset(c, chain, asset),
      to: kind === 'evm_setup' || kind === 'evm_cancel_recovery' ? Buffer.alloc(0) : encAddress(c, chain, to),
      amount: bn(amount),
      evm: null as Raw,
      btc: null as Raw,
    };
  }

  /** Resolve a send/swap into concrete intent params (UTXOs, fees, nonces). */
  async prepareTransfer(kind: 'send' | 'swap', args: SendArgs): Promise<PreparedIntent> {
    const { chain, asset, to, amount } = args;
    if (asset !== NATIVE[chain] && chain === 'bitcoin') throw new IkaPortalError('UnknownAsset', 'only BTC on Bitcoin');
    const params = this.base(kind, chain, asset, to, amount);
    let fee: bigint | undefined;

    if (chain === 'bitcoin') {
      const b = this.ctx.bitcoin();
      const lock = this.ctx.btcLock(this.view);
      const address = this.addresses.bitcoin!;
      const [utxos, feeRate] = await Promise.all([b.backend.utxos(address), b.backend.feeRate()]);
      const sel = btc.selectCoins(utxos, amount, {
        feeRate,
        maxInputs: this.ctx.config.maxBtcInputs,
        maxFee: this.view.policy.maxBtcFeeSats,
        lock: lock.type,
      });
      const plan = btc.planSpend(sel.inputs, btc.addressToScript(to, this.ctx.codec.btcNetwork), amount, sel.fee, lock);
      fee = plan.fee;
      params.btc = {
        inputs: sel.inputs.map((u) => ({ txid: Array.from(btc.txidToInternal(u.txid)), vout: u.vout, value: bn(u.value) })),
        fee: bn(sel.fee),
      };
    } else {
      const mode = args.evmMode ?? (this.isDelegated(chain) ? 'delegated' : 'direct');
      if (mode === 'delegated') {
        if (!this.isDelegated(chain)) throw new IkaPortalError('EvmNotDelegated', `run setupEvm('${chain}') first`);
        params.evm = { delegated: { deadline: bn(await this.evmDeadline(chain, args.deadlineS ?? 3600)) } };
      } else {
        const adapter = this.ctx.evm(chain);
        const from = this.view.evmAddress!;
        const call = evm.evmCall(this.ctx.codec.token(chain, asset), getAddress(to), amount);
        const [nonce, fees, gas] = await Promise.all([
          adapter.txNonce(from),
          adapter.fees(),
          adapter.estimateGas(from, call).catch(() => (asset === 'ETH' ? DIRECT_GAS_FALLBACK.ETH : DIRECT_GAS_FALLBACK.token)),
        ]);
        fee = gas * fees.maxFeePerGas;
        params.evm = {
          direct: { nonce: bn(nonce), gasLimit: bn(gas), maxFeePerGas: bn(fees.maxFeePerGas), maxPriorityFeePerGas: bn(fees.maxPriorityFeePerGas) },
        };
      }
    }
    return { params, kind, chain, asset, to, amount, fee };
  }

  /**
   * Signature deadlines are checked by the EVM chain against its block time, so
   * base them on the chain's clock (falling back to wall time if it's behind).
   */
  private async evmDeadline(chain: EvmChain, seconds: number): Promise<number> {
    const block = await this.ctx.evm(chain).client.getBlock({ blockTag: 'latest' }).catch(() => null);
    const now = Math.max(Math.floor(Date.now() / 1000), block ? Number(block.timestamp) : 0);
    return now + seconds;
  }

  /** Show the policy result before submitting (the program re-checks on-chain). */
  checkPolicy(p: Pick<PreparedIntent, 'kind' | 'chain' | 'asset' | 'to' | 'amount' | 'fee'>): PolicyResult {
    return previewPolicy(this.view.policy, this.view.spend, { ...p, now: Math.floor(Date.now() / 1000) });
  }

  private async intentFrom(prepared: { params: Raw }, hooks?: { onBroadcast?: (h: string) => Promise<void> }): Promise<{ handle: IntentHandle; ixs: TransactionInstruction[] }> {
    await this.refresh();
    const nonce = this.view.intentNonce;
    const payer = this.ctx.canSignAs(this.owner) ? this.ctx.feePayer().publicKey : this.owner;
    const ixs = [await this.ctx.program.proposeIntent(this.owner, payer, this.address, nonce, prepared.params)];
    const intent = this.ctx.program.intentPda(this.address, nonce);
    const handle = new IntentHandle(this.ctx, this.address, () => this.dwallets, { proposeIxs: ixs, intent, owner: this.owner }, hooks);
    return { handle, ixs };
  }

  /** Send BTC / ETH / USDC. Returns a handle; iterate `progress()` or `await wait()`. */
  async send(args: SendArgs): Promise<IntentHandle> {
    const prepared = await this.prepareTransfer('send', args);
    const check = this.checkPolicy(prepared);
    if (!check.ok) throw new IkaPortalError(check.error, check.message);
    return (await this.intentFrom(prepared)).handle;
  }

  /** One-time EIP-7702 setup (delegation to IkaAccount + Init) via the relayer. */
  async setupEvm(chain: EvmChain): Promise<IntentHandle> {
    const eoaNonce = await this.ctx.evm(chain).txNonce(this.view.evmAddress!);
    const params = this.base('evm_setup', chain, 'ETH', '', 0n);
    params.evm = { setup: { eoaNonce: bn(eoaNonce) } };
    return (await this.intentFrom({ params })).handle;
  }

  /** Cancel a pending EVM recovery (dWallet-signed `cancelRecovery`). */
  async cancelEvmRecovery(chain: EvmChain, deadlineS = 3600): Promise<IntentHandle> {
    const params = this.base('evm_cancel_recovery', chain, 'ETH', '', 0n);
    params.evm = { cancelRecovery: { deadline: bn(await this.evmDeadline(chain, deadlineS)) } };
    return (await this.intentFrom({ params })).handle;
  }

  /** Resume an existing intent (e.g. after a reload, or one proposed by a Squads vault). */
  intent(address: PublicKey): IntentHandle {
    return new IntentHandle(this.ctx, this.address, () => this.dwallets, { intent: address, owner: this.owner });
  }

  async cancelIntent(intent: PublicKey) {
    return sendInstructions(this.ctx.connection, [await this.ctx.program.cancelIntent(this.owner, this.address, intent)], this.ctx.feePayer(), [this.wallet()]);
  }

  async listIntents() {
    const all = await this.ctx.program.intentsOf(this.address);
    return all.sort((a, b) => Number(b.account.nonce) - Number(a.account.nonce));
  }

  // ── Swaps ────────────────────────────────────────────────────────────

  async quoteSwap(req: { from: { chain: Chain; asset: AssetSymbol; amount: bigint }; to: { chain: Chain; asset: AssetSymbol }; slippageBps?: number }): Promise<QuoteAllResult> {
    const router = this.ctx.router;
    const cfg = this.ctx.opts.swap;
    if (!router || !cfg) throw new IkaPortalError('NoSwapProviders', 'configure `swap.providers`');
    const a = this.addresses;
    const recipient = a[req.to.chain];
    const refundTo = a[req.from.chain];
    if (!recipient || !refundTo) throw new IkaPortalError('AccountNotReady', 'account has no address on one of the chains');
    return router.quoteAll({ ...req, recipient, refundTo, slippageBps: req.slippageBps ?? cfg.slippageBps ?? 100, fees: cfg.fees });
  }

  /** Execute a quote: deposit to the provider via a `swap` intent, then track the swap. */
  async swap(quote: Quote): Promise<SwapHandle> {
    const provider = this.ctx.opts.swap?.providers.find((p) => p.id === quote.providerId);
    if (!provider) throw new IkaPortalError('NoSwapProviders', `provider ${quote.providerId} not configured`);
    if (!quote.executable) throw new IkaPortalError('SwapNotExecutable', quote.nonExecutableReason ?? 'quote is not executable');
    const prepared = await provider.prepare(quote);
    const own = this.addresses;
    assertOwnAddresses(prepared, { recipient: own[quote.request.to.chain]!, refundTo: own[quote.request.from.chain]! });

    const from = quote.request.from;
    const intentPrep = await this.prepareTransfer('swap', { chain: from.chain, asset: from.asset, to: prepared.depositAddress, amount: prepared.amount });
    const check = this.checkPolicy(intentPrep);
    if (!check.ok) throw new IkaPortalError(check.error, check.message);
    // A delayed intent could outlive the quote: re-quote instead.
    if (check.delayed && check.executableAt > prepared.deadline - 120) {
      throw new IkaPortalError('QuoteExpiresBeforeDelay', 'this swap is delayed by policy past the quote deadline; re-quote after the delay');
    }
    const { handle } = await this.intentFrom(intentPrep, {
      onBroadcast: async (txHash) => {
        await provider.submitDeposit?.(prepared, txHash).catch(() => undefined);
      },
    });
    const ctx = this.ctx;
    return {
      prepared,
      intent: handle,
      async wait() {
        await handle.wait();
        for (;;) {
          const s = await provider.status(prepared);
          if (s.status !== 'pending') return s;
          await sleep(ctx.pollMs * 3);
        }
      },
    };
  }

  // ── Policy ───────────────────────────────────────────────────────────

  private wallet() {
    if (!this.ctx.canSignAs(this.owner)) {
      throw new IkaPortalError('OwnerNotWallet', 'the owner is not the connected wallet (PDA owner?): use account.instructions.* instead');
    }
    return this.ctx.opts.wallet!;
  }

  async proposePolicy(next: Policy) {
    const ix = await this.ctx.program.proposePolicy(this.owner, this.address, encPolicy(this.ctx.codec, next));
    const r = await sendInstructions(this.ctx.connection, [ix], this.ctx.feePayer(), [this.wallet()]);
    await this.refresh();
    return r;
  }

  async applyPolicy() {
    const r = await sendInstructions(this.ctx.connection, [await this.ctx.program.applyPolicy(this.address)], this.ctx.feePayer());
    await this.refresh();
    return r;
  }

  async cancelPolicy() {
    const r = await sendInstructions(this.ctx.connection, [await this.ctx.program.cancelPolicy(this.owner, this.address)], this.ctx.feePayer(), [this.wallet()]);
    await this.refresh();
    return r;
  }

  // ── Raw instruction builders (Squads / other PDA owners) ─────────────

  get instructions() {
    const self = this;
    const ctx = this.ctx;
    const propose = async (prepared: { params: Raw }) => (await self.intentFrom(prepared)).ixs;
    return {
      /** Propose a send; execute these from the owner, then call `account.intent(pda)` or let `send()` continue. */
      async send(args: SendArgs) {
        return propose(await self.prepareTransfer('send', args));
      },
      async setupEvm(chain: EvmChain) {
        const eoaNonce = await ctx.evm(chain).txNonce(self.view.evmAddress!);
        const params = self.base('evm_setup', chain, 'ETH', '', 0n);
        params.evm = { setup: { eoaNonce: bn(eoaNonce) } };
        return propose({ params });
      },
      /** Propose the deposit for a prepared swap (see `swap()` for the policy/deadline checks). */
      async swap(prepared: PreparedSwap) {
        const from = prepared.quote.request.from;
        const own = self.addresses;
        assertOwnAddresses(prepared, { recipient: own[prepared.quote.request.to.chain]!, refundTo: own[from.chain]! });
        return propose(await self.prepareTransfer('swap', { chain: from.chain, asset: from.asset, to: prepared.depositAddress, amount: prepared.amount }));
      },
      async cancelEvmRecovery(chain: EvmChain, deadlineS = 3600) {
        const params = self.base('evm_cancel_recovery', chain, 'ETH', '', 0n);
        params.evm = { cancelRecovery: { deadline: bn(await self.evmDeadline(chain, deadlineS)) } };
        return propose({ params });
      },
      async cancelIntent(intent: PublicKey) {
        return [await ctx.program.cancelIntent(self.owner, self.address, intent)];
      },
      async proposePolicy(next: Policy) {
        return [await ctx.program.proposePolicy(self.owner, self.address, encPolicy(ctx.codec, next))];
      },
      async applyPolicy() {
        return [await ctx.program.applyPolicy(self.address)];
      },
      async cancelPolicy() {
        return [await ctx.program.cancelPolicy(self.owner, self.address)];
      },
      async setEvmNonce(chain: EvmChain, nonce: bigint) {
        return [await ctx.program.setEvmNonce(self.owner, self.address, ctx.evmChain(chain).chainId, nonce)];
      },
    };
  }

  /** The PDA the next proposal will create (for PDA owners waiting on a vault transaction). */
  nextIntentAddress(): PublicKey {
    return this.ctx.program.intentPda(this.address, this.view.intentNonce);
  }
}

export const isEvm = isEvmChain;
