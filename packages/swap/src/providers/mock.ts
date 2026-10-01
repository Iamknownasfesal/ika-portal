import { ASSET_DECIMALS, assetKey, isSupportedAsset } from '../assets.js';
import { SwapError } from '../errors.js';
import type { AssetSymbol, Chain, FeeConfig, PreparedSwap, Quote, QuoteRequest, SwapProvider, SwapStatus } from '../types.js';
import { BPS, configuredFeeLines, nowSec } from '../util.js';

export type MockPayout = (args: {
  chain: Chain;
  asset: AssetSymbol;
  to: string;
  amount: bigint;
  depositTxHash: string;
}) => Promise<string /* destination tx hash */>;

export interface MockSwapProviderOptions {
  /**
   * Human-unit prices keyed `FROM/TO`, e.g. `{ 'BTC/USDC': '60000', 'ETH/USDC': '3000' }`
   * meaning 1 BTC = 60000 USDC. The inverse pair is derived automatically; same-asset
   * (bridge) pairs default to 1. Decimal strings are parsed exactly.
   */
  rates: Record<string, string | number>;
  /** Sends the destination asset from a funded test key the mock controls. */
  payout: MockPayout;
  /** A deposit address (controlled by the test operator) per origin chain. */
  depositAddresses: Partial<Record<Chain, string>>;
  id?: string;
  /** Whether `supportsFees` returns true. Default true. */
  feeSupport?: boolean;
  /** Deposit window in seconds. Default 3600. */
  deadlineSec?: number;
  /** Quote validity in seconds. Default 60. */
  quoteTtlSec?: number;
  /** ERC-20 addresses of the (testnet) origin tokens, keyed `chain:ASSET`; copied to `PreparedSwap.tokenAddress`. */
  tokenAddresses?: Partial<Record<`${Chain}:${AssetSymbol}`, string>>;
  now?: () => number;
}

interface Rational {
  num: bigint;
  den: bigint;
}

function parseDecimal(v: string | number): Rational {
  const s = typeof v === 'number' ? v.toString() : v.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new TypeError(`invalid rate: ${v}`);
  const frac = m[2] ?? '';
  return { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
}

interface MockRecord {
  status: SwapStatus;
  paid: boolean;
}

/**
 * Deterministic swap provider for testnets and tests. Output = amountIn × rate
 * (decimals-aware), minus integrator + ika fee bps applied to the OUTPUT.
 * On `submitDeposit` it calls `payout` to deliver the destination asset.
 */
export class MockSwapProvider implements SwapProvider {
  readonly id: string;
  private readonly rates = new Map<string, Rational>();
  private readonly records = new Map<string, MockRecord>();
  private counter = 0;
  private readonly opts: MockSwapProviderOptions;
  private readonly now: () => number;

  constructor(opts: MockSwapProviderOptions) {
    this.opts = opts;
    this.id = opts.id ?? 'mock';
    this.now = opts.now ?? nowSec;
    for (const [pair, v] of Object.entries(opts.rates)) {
      const [a, b] = pair.split('/');
      if (!a || !b) throw new TypeError(`invalid rate pair: ${pair}`);
      const r = parseDecimal(v);
      if (r.num === 0n) throw new RangeError(`zero rate for ${pair}`);
      this.rates.set(`${a}/${b}`, r);
      if (!opts.rates[`${b}/${a}`]) this.rates.set(`${b}/${a}`, { num: r.den, den: r.num });
    }
  }

  supportsFees(_fees: FeeConfig): boolean {
    return this.opts.feeSupport ?? true;
  }

  private rate(from: AssetSymbol, to: AssetSymbol): Rational | undefined {
    if (from === to) return this.rates.get(`${from}/${to}`) ?? { num: 1n, den: 1n };
    return this.rates.get(`${from}/${to}`);
  }

  /** Gross output (before fees) in destination base units. */
  grossOut(from: AssetSymbol, to: AssetSymbol, amountIn: bigint): bigint | undefined {
    const r = this.rate(from, to);
    if (!r) return undefined;
    const dIn = ASSET_DECIMALS[from];
    const dOut = ASSET_DECIMALS[to];
    let num = amountIn * r.num;
    let den = r.den;
    if (dOut >= dIn) num *= 10n ** BigInt(dOut - dIn);
    else den *= 10n ** BigInt(dIn - dOut);
    return num / den;
  }

  async quote(req: QuoteRequest): Promise<Quote | null> {
    const { from, to } = req;
    if (!isSupportedAsset(from.chain, from.asset) || !isSupportedAsset(to.chain, to.asset)) return null;
    if (from.chain === to.chain && from.asset === to.asset) return null;
    if (!this.opts.depositAddresses[from.chain]) return null;
    const gross = this.grossOut(from.asset, to.asset, from.amount);
    if (gross === undefined) return null;
    const feeLines = configuredFeeLines(req.fees, gross, 'output');
    const feeTotal = (feeLines.integrator?.amount ?? 0n) + (feeLines.ika?.amount ?? 0n);
    const amountOut = gross - feeTotal;
    if (amountOut <= 0n) return null;
    const now = this.now();
    return {
      providerId: this.id,
      request: req,
      amountIn: from.amount,
      amountOut,
      minAmountOut: (amountOut * (BPS - BigInt(req.slippageBps))) / BPS,
      fees: { ...feeLines, provider: [] },
      recipient: req.recipient,
      refundTo: req.refundTo,
      deadline: now + (this.opts.deadlineSec ?? 3600),
      expiresAt: now + (this.opts.quoteTtlSec ?? 60),
      executable: true,
      estimatedTimeSec: 0,
      raw: { gross },
    };
  }

  async prepare(quote: Quote): Promise<PreparedSwap> {
    const from = quote.request.from;
    const depositAddress = this.opts.depositAddresses[from.chain];
    if (!depositAddress) throw new SwapError(`[${this.id}] no deposit address for ${from.chain}`);
    const providerRef = `${this.id}-${++this.counter}`;
    this.records.set(providerRef, { status: { status: 'pending', providerStatus: 'PENDING_DEPOSIT' }, paid: false });
    const key = assetKey(from.chain, from.asset);
    const tokenAddress = this.opts.tokenAddresses?.[key];
    const p: PreparedSwap = {
      quote,
      depositAddress,
      amount: quote.amountIn,
      deadline: this.now() + (this.opts.deadlineSec ?? 3600),
      providerRef,
    };
    if (tokenAddress) p.tokenAddress = tokenAddress;
    return p;
  }

  async submitDeposit(p: PreparedSwap, txHash: string): Promise<void> {
    const rec = this.records.get(p.providerRef);
    if (!rec) throw new SwapError(`[${this.id}] unknown swap ${p.providerRef}`);
    if (rec.paid || rec.status.status !== 'pending') return; // idempotent
    if (this.now() > p.deadline) {
      rec.status = { status: 'failed', providerStatus: 'EXPIRED', originTxHash: txHash, reason: 'deposit after deadline' };
      return;
    }
    rec.paid = true;
    rec.status = { status: 'pending', providerStatus: 'PROCESSING', originTxHash: txHash };
    const q = p.quote;
    try {
      const destinationTxHash = await this.opts.payout({
        chain: q.request.to.chain,
        asset: q.request.to.asset,
        to: q.recipient,
        amount: q.amountOut,
        depositTxHash: txHash,
      });
      rec.status = { status: 'success', providerStatus: 'SUCCESS', originTxHash: txHash, destinationTxHash, amountOut: q.amountOut };
    } catch (e) {
      rec.status = {
        status: 'failed',
        providerStatus: 'FAILED',
        originTxHash: txHash,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async status(p: PreparedSwap): Promise<SwapStatus> {
    const rec = this.records.get(p.providerRef);
    if (!rec) throw new SwapError(`[${this.id}] unknown swap ${p.providerRef}`);
    return { ...rec.status };
  }
}

