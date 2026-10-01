import { PublicKey } from '@solana/web3.js';
import { btc, evm, isEvmChain, type AssetSymbol, type Chain, type EvmChain, type BitcoinNetworkName } from '@ika-portal/chains';
import { SwapRouter } from '@ika-portal/swap';
import { getAddress, type Address } from 'viem';
import { bytesHex, big, decChain, decMode, decPolicy, decShare, type CodecContext } from './codec.js';
import { IkaProgram, IkaPortalError } from './program.js';
import type { Addresses, IkaPortalOptions, Mode, Policy, TxSigner, UserShareMode } from './types.js';
import type { SpendState } from './policyPreview.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export interface ConfigView {
  admin: PublicKey;
  dwalletProgram: PublicKey;
  btcNetwork: BitcoinNetworkName;
  maxBtcInputs: number;
  evmChains: { chain: EvmChain; chainId: number; implementation: Address }[];
  tokens: { chain: EvmChain; address: Address }[];
}

export interface DWalletEntryView {
  address: PublicKey;
  role: 'btc' | 'evm' | 'both';
  publicKey: Uint8Array;
}

export interface AccountView {
  address: PublicKey;
  owner: PublicKey;
  index: number;
  mode: Mode;
  userShare: UserShareMode;
  ikaUser: PublicKey;
  dwallets: DWalletEntryView[];
  btcPubkey: Uint8Array | null;
  evmAddress: Address | null;
  recoveryPubkey: Uint8Array | null;
  recoveryEvmAddress: Address | null;
  csvBlocks: number;
  recoveryDelayS: number;
  policy: Policy;
  pendingPolicy: Policy | null;
  pendingPolicyAt: number;
  spend: { limits: SpendState[]; swaps: SpendState[] };
  intentNonce: bigint;
  evmNonces: { chainId: number; nonce: bigint; delegated: boolean }[];
}

/** Shared state for IkaPortal, accounts and intents. */
export class Ctx {
  readonly program: IkaProgram;
  readonly pollMs: number;
  config!: ConfigView;
  codec!: CodecContext;
  private evmAdapters = new Map<EvmChain, evm.EvmAdapter>();
  readonly relayer?: evm.RelayerClient;
  readonly router?: SwapRouter;

  constructor(readonly opts: IkaPortalOptions) {
    this.program = new IkaProgram(opts.connection, opts.programId);
    this.pollMs = opts.pollMs ?? 1000;
    if (opts.relayerUrl) this.relayer = new evm.RelayerClient(opts.relayerUrl);
    if (opts.swap) this.router = new SwapRouter({ providers: opts.swap.providers, priority: opts.swap.priority });
  }

  get connection() {
    return this.opts.connection;
  }

  feePayer(): TxSigner {
    const p = this.opts.feePayer ?? this.opts.wallet;
    if (!p) throw new IkaPortalError('NoFeePayer', 'configure `feePayer` or `wallet` to send transactions');
    return p;
  }

  /** The wallet can sign for `owner` (false for PDAs such as Squads vaults). */
  canSignAs(owner: PublicKey) {
    return !!this.opts.wallet && this.opts.wallet.publicKey.equals(owner);
  }

  async loadConfig(): Promise<ConfigView> {
    const c = await this.program.fetchConfig();
    const hex20 = (b: number[]) => getAddress(`0x${bytesHex(b)}`);
    this.config = {
      admin: c.admin,
      dwalletProgram: c.dwalletProgram,
      btcNetwork: Object.keys(c.btcNetwork)[0] as BitcoinNetworkName,
      maxBtcInputs: c.maxBtcInputs,
      evmChains: c.evmChains.map((e: Raw) => ({ chain: decChain(e.chain) as EvmChain, chainId: Number(e.chainId), implementation: hex20(e.implementation) })),
      tokens: c.tokens.map((t: Raw) => ({ chain: decChain(t.chain) as EvmChain, address: hex20(t.address) })),
    };
    if (!this.config.dwalletProgram.equals(this.opts.signer.dwalletProgramId)) {
      throw new IkaPortalError(
        'DWalletProgramMismatch',
        `program Config uses dWallet program ${this.config.dwalletProgram.toBase58()} but the signer backend targets ${this.opts.signer.dwalletProgramId.toBase58()}`,
      );
    }
    const btcCfg = this.opts.chains.bitcoin;
    const network = btcCfg?.network ?? this.config.btcNetwork;
    this.codec = {
      btcNetwork: network,
      token: (chain: Chain, asset: AssetSymbol) => {
        if (!isEvmChain(chain) || asset === 'ETH' || asset === 'BTC') return null;
        const t = this.opts.chains[chain]?.tokens?.[asset];
        if (!t) throw new IkaPortalError('UnknownAsset', `${asset} is not configured on ${chain}`);
        return getAddress(t);
      },
      symbolOf: (chain: Chain, address: Uint8Array) => {
        if (address.every((b) => b === 0)) return chain === 'bitcoin' ? 'BTC' : 'ETH';
        const hex = `0x${bytesHex(address)}`.toLowerCase();
        const cfg = isEvmChain(chain) ? this.opts.chains[chain]?.tokens ?? {} : {};
        const found = Object.entries(cfg).find(([, a]) => a?.toLowerCase() === hex);
        return (found?.[0] ?? 'USDC') as AssetSymbol;
      },
    };
    return this.config;
  }

  evmChain(chain: EvmChain) {
    const c = this.config.evmChains.find((e) => e.chain === chain);
    if (!c) throw new IkaPortalError('UnknownChain', `${chain} is not configured in the program Config`);
    return c;
  }

  evm(chain: EvmChain): evm.EvmAdapter {
    let a = this.evmAdapters.get(chain);
    if (!a) {
      const cfg = this.opts.chains[chain];
      if (!cfg) throw new IkaPortalError('UnknownChain', `no RPC configured for ${chain}`);
      a = new evm.EvmAdapter(chain, cfg);
      this.evmAdapters.set(chain, a);
    }
    return a;
  }

  bitcoin() {
    const b = this.opts.chains.bitcoin;
    if (!b) throw new IkaPortalError('UnknownChain', 'no Bitcoin backend configured');
    return b;
  }

  decodeAccount(address: PublicKey, a: Raw): AccountView {
    const nonzero = (b: number[]) => b.some((x) => x !== 0);
    const spend = (w: Raw[]): SpendState[] => w.map((x) => ({ windowStart: Number(x.windowStart), used: big(x.used) }));
    return {
      address,
      owner: a.owner,
      index: a.index,
      mode: decMode(a.mode),
      userShare: decShare(a.userShare),
      ikaUser: a.ikaUser,
      dwallets: a.dwallets.map((d: Raw) => ({ address: d.dwallet, role: Object.keys(d.role)[0], publicKey: Uint8Array.from(d.pubkey) })),
      btcPubkey: nonzero(a.btcPubkey) ? Uint8Array.from(a.btcPubkey) : null,
      evmAddress: nonzero(a.evmAddress) ? getAddress(`0x${bytesHex(a.evmAddress)}`) : null,
      recoveryPubkey: a.recoveryPubkey ? Uint8Array.from(a.recoveryPubkey) : null,
      recoveryEvmAddress: nonzero(a.recoveryEvmAddress) ? getAddress(`0x${bytesHex(a.recoveryEvmAddress)}`) : null,
      csvBlocks: a.csvBlocks,
      recoveryDelayS: a.recoveryDelayS,
      policy: decPolicy(this.codec, a.policy),
      pendingPolicy: a.pendingPolicy ? decPolicy(this.codec, a.pendingPolicy) : null,
      pendingPolicyAt: Number(a.pendingPolicyAt),
      spend: { limits: spend(a.spend), swaps: spend(a.swapSpend) },
      intentNonce: big(a.intentNonce),
      evmNonces: a.evmNonces.map((n: Raw) => ({ chainId: Number(n.chainId), nonce: big(n.nonce), delegated: n.delegated })),
    };
  }

  btcLock(v: AccountView): btc.BtcLock {
    if (!v.btcPubkey) throw new IkaPortalError('AccountNotReady', 'no Bitcoin dWallet registered');
    if (v.mode === 'enforced_recovery') {
      return { type: 'p2wsh', dwalletPubkey: v.btcPubkey, recoveryPubkey: v.recoveryPubkey!, csvBlocks: v.csvBlocks };
    }
    return { type: 'p2wpkh', pubkey: v.btcPubkey };
  }

  addresses(v: AccountView): Addresses {
    const out: Addresses = {};
    if (v.btcPubkey) out.bitcoin = btc.lockAddress(this.btcLock(v), this.codec.btcNetwork);
    if (v.evmAddress) {
      for (const c of this.config.evmChains) out[c.chain] = v.evmAddress;
    }
    return out;
  }
}
