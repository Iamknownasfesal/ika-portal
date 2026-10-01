/**
 * Off-chain mirror of the program's policy evaluation, so a wallet can show
 * the result before the user signs. The program remains the authority.
 */
import type { AssetSymbol, Chain } from '@ika-portal/chains';
import type { IntentKind, Policy } from './types.js';

export interface SpendState {
  windowStart: number;
  used: bigint;
}

export interface PolicyCheckInput {
  kind: IntentKind;
  chain: Chain;
  asset: AssetSymbol;
  to: string;
  amount: bigint;
  /** BTC effective fee (sats) or EVM direct max fee (wei). */
  fee?: bigint;
  now: number;
}

export type PolicyResult =
  | { ok: true; delayed: boolean; executableAt: number }
  | { ok: false; error: 'LimitExceeded' | 'RecipientNotAllowed' | 'SwapsDisabled' | 'SwapLimitExceeded' | 'FeeTooHigh'; message: string };

const sameAddr = (chain: Chain, a: string, b: string) => (chain === 'bitcoin' ? a === b : a.toLowerCase() === b.toLowerCase());

function window(limits: Policy['limits'], spend: SpendState[], i: CheckArgs) {
  const idx = limits.findIndex((l) => l.chain === i.chain && l.asset === i.asset);
  if (idx < 0) return { ok: true, remaining: null as bigint | null };
  const l = limits[idx]!;
  const w = spend[idx] ?? { windowStart: 0, used: 0n };
  const used = i.now >= w.windowStart + l.windowS ? 0n : w.used;
  return { ok: used + i.amount <= l.maxPerWindow, remaining: l.maxPerWindow - used };
}
type CheckArgs = { chain: Chain; asset: AssetSymbol; amount: bigint; now: number };

export function previewPolicy(policy: Policy, spend: { limits: SpendState[]; swaps: SpendState[] }, i: PolicyCheckInput): PolicyResult {
  if (i.kind === 'evm_setup' || i.kind === 'evm_cancel_recovery') return { ok: true, delayed: false, executableAt: i.now };
  if (i.kind === 'swap' && !policy.swapsEnabled) return { ok: false, error: 'SwapsDisabled', message: 'Swaps are disabled by policy' };
  if (i.kind === 'send' && policy.allowlistEnabled && !policy.allowlist.some((a) => a.chain === i.chain && sameAddr(i.chain, a.address, i.to))) {
    return { ok: false, error: 'RecipientNotAllowed', message: `${i.to} is not in the allowlist` };
  }
  if (i.fee !== undefined) {
    const cap = i.chain === 'bitcoin' ? policy.maxBtcFeeSats : policy.maxEvmFeeWei;
    if (i.fee > cap) return { ok: false, error: 'FeeTooHigh', message: `fee ${i.fee} exceeds cap ${cap}` };
  }
  const lim = window(policy.limits, spend.limits, i);
  if (!lim.ok) return { ok: false, error: 'LimitExceeded', message: `exceeds the ${i.chain} ${i.asset} limit (remaining ${lim.remaining})` };
  if (i.kind === 'swap') {
    const sw = window(policy.swapLimits, spend.swaps, i);
    if (!sw.ok) return { ok: false, error: 'SwapLimitExceeded', message: `exceeds the swap limit (remaining ${sw.remaining})` };
  }
  const delayed = policy.delayThresholds.some((t) => t.chain === i.chain && t.asset === i.asset && i.amount >= t.amount);
  return { ok: true, delayed, executableAt: delayed ? i.now + policy.delayS : i.now };
}
