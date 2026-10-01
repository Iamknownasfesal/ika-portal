/** Conversions between SDK-friendly values and the program's Anchor types. */
import { Buffer } from 'buffer';
import BN from 'bn.js';
import { btc, isEvmChain, type AssetSymbol, type BitcoinNetworkName, type Chain } from '@ika-portal/chains';
import { getAddress, type Address } from 'viem';
import type { AllowEntry, DelayThreshold, Limit, Mode, Policy, IntentKind, IntentStatus } from './types.js';

export const ZERO20 = new Array<number>(20).fill(0);

export interface CodecContext {
  btcNetwork: BitcoinNetworkName;
  /** ERC-20 address for (chain, symbol); null for native assets. */
  token(chain: Chain, asset: AssetSymbol): Address | null;
  /** Reverse lookup for display. */
  symbolOf(chain: Chain, address: Uint8Array): AssetSymbol;
}

export const bn = (v: bigint | number) => new BN(v.toString());
export const big = (v: BN | number | bigint) => BigInt(v.toString());

type AnchorEnum<T extends string> = { [K in T]?: Record<string, never> };
const variant = <T extends string>(e: object) => Object.keys(e)[0] as T;

const CHAIN_TO_VARIANT = { bitcoin: 'bitcoin', ethereum: 'ethereum', base: 'base' } as const;
export const encChain = (c: Chain) => ({ [CHAIN_TO_VARIANT[c]]: {} }) as AnchorEnum<'bitcoin' | 'ethereum' | 'base'>;
export const decChain = (e: object): Chain => variant<Chain>(e);

const MODE: Record<Mode, string> = { recoverable: 'recoverable', enforced: 'enforced', enforced_recovery: 'enforcedRecovery' };
export const encMode = (m: Mode) => ({ [MODE[m]]: {} });
export const decMode = (e: object): Mode => (variant<string>(e) === 'enforcedRecovery' ? 'enforced_recovery' : (variant(e) as Mode));

export const encShare = (s: 'public' | 'encrypted') => ({ [s]: {} });
export const decShare = (e: object) => variant<'public' | 'encrypted'>(e);

const KIND: Record<IntentKind, string> = { send: 'send', swap: 'swap', evm_setup: 'evmSetup', evm_cancel_recovery: 'evmCancelRecovery' };
export const encKind = (k: IntentKind) => ({ [KIND[k]]: {} });
export const decKind = (e: object): IntentKind => {
  const v = variant<string>(e);
  return (Object.entries(KIND).find(([, x]) => x === v)?.[0] ?? v) as IntentKind;
};
export const decStatus = (e: object) => variant<IntentStatus>(e);

export const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
export const bytesHex = (b: Uint8Array | number[]) => Buffer.from(Uint8Array.from(b)).toString('hex');

export function encAsset(ctx: CodecContext, chain: Chain, asset: AssetSymbol): number[] {
  const t = ctx.token(chain, asset);
  return t ? Array.from(hexToBytes(t)) : ZERO20;
}

/** Recipient bytes as the program expects: EVM 20-byte address, BTC scriptPubKey. */
export function encAddress(ctx: CodecContext, chain: Chain, address: string): Buffer {
  if (isEvmChain(chain)) return Buffer.from(hexToBytes(getAddress(address)));
  return Buffer.from(btc.addressToScript(address, ctx.btcNetwork));
}

export function decAddress(ctx: CodecContext, chain: Chain, bytes: Uint8Array): string {
  if (isEvmChain(chain)) return getAddress(`0x${bytesHex(bytes)}`);
  try {
    return btc.scriptToAddress(bytes, ctx.btcNetwork);
  } catch {
    return bytesHex(bytes);
  }
}

const encLimit = (ctx: CodecContext) => (l: Limit) => ({
  chain: encChain(l.chain),
  asset: encAsset(ctx, l.chain, l.asset),
  maxPerWindow: bn(l.maxPerWindow),
  windowS: l.windowS,
});

export function encPolicy(ctx: CodecContext, p: Policy) {
  return {
    limits: p.limits.map(encLimit(ctx)),
    allowlistEnabled: p.allowlistEnabled,
    allowlist: p.allowlist.map((a: AllowEntry) => ({ chain: encChain(a.chain), address: encAddress(ctx, a.chain, a.address) })),
    delayThresholds: p.delayThresholds.map((t: DelayThreshold) => ({
      chain: encChain(t.chain),
      asset: encAsset(ctx, t.chain, t.asset),
      amount: bn(t.amount),
    })),
    delayS: p.delayS,
    swapsEnabled: p.swapsEnabled,
    swapLimits: p.swapLimits.map(encLimit(ctx)),
    maxBtcFeeSats: bn(p.maxBtcFeeSats),
    maxEvmFeeWei: bn(p.maxEvmFeeWei),
    policyChangeDelayS: p.policyChangeDelayS,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

const decLimit = (ctx: CodecContext) => (l: Raw): Limit => {
  const chain = decChain(l.chain);
  return { chain, asset: ctx.symbolOf(chain, Uint8Array.from(l.asset)), maxPerWindow: big(l.maxPerWindow), windowS: l.windowS };
};

export function decPolicy(ctx: CodecContext, p: Raw): Policy {
  return {
    limits: p.limits.map(decLimit(ctx)),
    allowlistEnabled: p.allowlistEnabled,
    allowlist: p.allowlist.map((a: Raw) => {
      const chain = decChain(a.chain);
      return { chain, address: decAddress(ctx, chain, Uint8Array.from(a.address)) };
    }),
    delayThresholds: p.delayThresholds.map((t: Raw) => {
      const chain = decChain(t.chain);
      return { chain, asset: ctx.symbolOf(chain, Uint8Array.from(t.asset)), amount: big(t.amount) };
    }),
    delayS: p.delayS,
    swapsEnabled: p.swapsEnabled,
    swapLimits: p.swapLimits.map(decLimit(ctx)),
    maxBtcFeeSats: big(p.maxBtcFeeSats),
    maxEvmFeeWei: big(p.maxEvmFeeWei),
    policyChangeDelayS: p.policyChangeDelayS,
  };
}
