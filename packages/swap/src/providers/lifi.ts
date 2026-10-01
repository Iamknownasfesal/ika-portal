/**
 * LI.FI (li.fi) provider — quotes for display; execution only for plain-transfer routes.
 *
 * API: https://li.quest
 *   GET /v1/quote?fromChain&toChain&fromToken&toToken&fromAmount&fromAddress&toAddress&slippage&integrator&fee
 *   GET /v1/status?txHash&fromChain&toChain
 *
 * LI.FI returns a `transactionRequest` that calls the LI.FI Diamond contract (EVM, often after
 * an ERC-20 approval) or a Bitcoin PSBT carrying an OP_RETURN memo. The Ika policy program can only
 * approve plain transfers, so such quotes are returned with `executable: false` (shown for price
 * comparison, never selected as `best`, and `prepare` throws SwapNotExecutable).
 *
 * Fees: LI.FI takes ONE integrator fee (`fee`, a fraction, e.g. 0.003 = 30 bps) that is paid to
 * the fee wallet configured for `integrator` in the LI.FI partner portal. There is no per-request
 * recipient and no second recipient, so `supportsFees` is true only when `feeWallet` is configured,
 * equals `fees.integrator.recipient`, and there is no separate Ika fee.
 */
import { EVM_TOKEN_ADDRESSES, assetKey, isNative, isSupportedAsset, type AssetKey } from '../assets.js';
import { SwapNotExecutable } from '../errors.js';
import type { Chain, FeeConfig, FetchLike, PreparedSwap, Quote, QuoteRequest, SwapProvider, SwapState, SwapStatus } from '../types.js';
import {
  activeFees,
  configuredFeeLines,
  decodeErc20Transfer,
  defaultFetch,
  httpJson,
  joinUrl,
  nowSec,
  sameAddress,
  toBigInt,
  type HttpOptions,
} from '../util.js';

export const LIFI_DEFAULT_BASE_URL = 'https://li.quest';
export const LIFI_BITCOIN_CHAIN_ID = 20000000000001;

export const LIFI_CHAIN_IDS: Record<Chain, number> = {
  bitcoin: LIFI_BITCOIN_CHAIN_ID,
  ethereum: 1,
  base: 8453,
};

export const LIFI_TOKENS: Partial<Record<AssetKey, string>> = {
  'bitcoin:BTC': 'bitcoin',
  'ethereum:ETH': '0x0000000000000000000000000000000000000000',
  'ethereum:USDC': EVM_TOKEN_ADDRESSES['ethereum:USDC']!,
  'base:ETH': '0x0000000000000000000000000000000000000000',
  'base:USDC': EVM_TOKEN_ADDRESSES['base:USDC']!,
};

export interface LifiQuoteResponse {
  id: string;
  type: string;
  tool: string;
  action: { fromAmount: string; fromAddress: string; toAddress: string; fromChainId: number; toChainId: number; slippage?: number };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    executionDuration?: number;
    feeCosts?: { name: string; amount: string; included?: boolean; percentage?: string; token: { chainId: number; address: string } }[];
  };
  transactionRequest?: { to?: string; data?: string; value?: string };
  [k: string]: unknown;
}

export type LifiStatusValue = 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED';

export interface LifiStatusResponse {
  status: LifiStatusValue;
  substatus?: string;
  substatusMessage?: string;
  sending?: { txHash?: string };
  receiving?: { txHash?: string; amount?: string };
}

export interface LifiProviderOptions {
  /** LI.FI integrator id (required by LI.FI for attribution; fees need portal configuration). */
  integrator: string;
  /** The fee wallet configured for `integrator` in the LI.FI portal. Enables fee support. */
  feeWallet?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  id?: string;
  quoteTtlSec?: number;
  depositWindowSec?: number;
  now?: () => number;
}

export class LifiProvider implements SwapProvider {
  readonly id: string;
  readonly baseUrl: string;
  private readonly http: HttpOptions;
  private readonly opts: LifiProviderOptions;
  private readonly now: () => number;
  private readonly depositTx = new Map<string, string>();

  constructor(opts: LifiProviderOptions) {
    this.opts = opts;
    this.id = opts.id ?? 'lifi';
    this.baseUrl = opts.baseUrl ?? LIFI_DEFAULT_BASE_URL;
    this.http = { providerId: this.id, fetch: opts.fetch ?? defaultFetch(), ...(opts.headers ? { headers: opts.headers } : {}) };
    this.now = opts.now ?? nowSec;
  }

  supportsFees(fees: FeeConfig): boolean {
    const active = activeFees(fees);
    if (active.length === 0) return true;
    if (!this.opts.feeWallet) return false;
    if (active.length !== 1 || active[0]!.kind !== 'integrator') return false;
    return sameAddress(active[0]!.recipient, this.opts.feeWallet);
  }

  buildQuoteParams(req: QuoteRequest): URLSearchParams | null {
    if (!isSupportedAsset(req.from.chain, req.from.asset) || !isSupportedAsset(req.to.chain, req.to.asset)) return null;
    const fromToken = LIFI_TOKENS[assetKey(req.from.chain, req.from.asset)];
    const toToken = LIFI_TOKENS[assetKey(req.to.chain, req.to.asset)];
    if (!fromToken || !toToken) return null;
    if (req.from.chain === req.to.chain && req.from.asset === req.to.asset) return null;
    const p = new URLSearchParams({
      fromChain: String(LIFI_CHAIN_IDS[req.from.chain]),
      toChain: String(LIFI_CHAIN_IDS[req.to.chain]),
      fromToken,
      toToken,
      fromAmount: req.from.amount.toString(),
      fromAddress: req.refundTo,
      toAddress: req.recipient,
      slippage: String(req.slippageBps / 10_000),
      integrator: this.opts.integrator,
    });
    const bps = activeFees(req.fees).reduce((s, f) => s + f.bps, 0);
    if (bps > 0) p.set('fee', String(bps / 10_000));
    return p;
  }

  /** Is the transactionRequest a plain transfer we could approve? */
  analyzeTx(req: QuoteRequest, res: LifiQuoteResponse): { executable: true; depositAddress: string; tokenAddress?: string } | { executable: false; reason: string } {
    const tx = res.transactionRequest;
    if (!tx || !tx.to) return { executable: false, reason: 'no transactionRequest' };
    const data = tx.data ?? '';
    if (req.from.chain === 'bitcoin') {
      if (data && data !== '0x') return { executable: false, reason: 'bitcoin route requires a LI.FI PSBT (OP_RETURN memo)' };
      return { executable: true, depositAddress: tx.to };
    }
    if (isNative(req.from.chain, req.from.asset)) {
      if (data && data !== '0x') return { executable: false, reason: 'route requires contract calldata' };
      return { executable: true, depositAddress: tx.to };
    }
    const decoded = decodeErc20Transfer(data);
    const token = LIFI_TOKENS[assetKey(req.from.chain, req.from.asset)]!;
    if (!decoded || !sameAddress(tx.to, token)) {
      return { executable: false, reason: res.estimate.approvalAddress ? 'route requires an ERC-20 approval and contract calldata' : 'route requires contract calldata' };
    }
    return { executable: true, depositAddress: decoded.to, tokenAddress: token };
  }

  private toQuote(req: QuoteRequest, res: LifiQuoteResponse): Quote {
    const a = this.analyzeTx(req, res);
    const amountIn = toBigInt(res.estimate.fromAmount, 'fromAmount');
    const provider: Quote['fees']['provider'] = (res.estimate.feeCosts ?? [])
      .filter((f) => f.included !== false)
      .map((f) => ({
        name: f.name,
        amount: BigInt(f.amount),
        side: f.token.chainId === LIFI_CHAIN_IDS[req.from.chain] ? ('input' as const) : ('output' as const),
      }));
    const now = this.now();
    const quote: Quote = {
      providerId: this.id,
      request: req,
      amountIn,
      amountOut: toBigInt(res.estimate.toAmount, 'toAmount'),
      minAmountOut: toBigInt(res.estimate.toAmountMin, 'toAmountMin'),
      fees: { ...configuredFeeLines(req.fees, amountIn, 'input'), provider },
      recipient: res.action.toAddress,
      refundTo: res.action.fromAddress,
      deadline: now + (this.opts.depositWindowSec ?? 30 * 60),
      expiresAt: now + (this.opts.quoteTtlSec ?? 30),
      executable: a.executable,
      raw: a.executable ? { response: res, depositAddress: a.depositAddress, tokenAddress: a.tokenAddress } : { response: res },
    };
    if (!a.executable) quote.nonExecutableReason = a.reason;
    if (res.estimate.executionDuration !== undefined) quote.estimatedTimeSec = res.estimate.executionDuration;
    return quote;
  }

  async quote(req: QuoteRequest, opts?: { signal?: AbortSignal }): Promise<Quote | null> {
    const params = this.buildQuoteParams(req);
    if (!params) return null;
    const res = await httpJson<LifiQuoteResponse>(this.http, 'GET', joinUrl(this.baseUrl, `/v1/quote?${params}`), undefined, opts?.signal);
    return this.toQuote(req, res);
  }

  async prepare(quote: Quote): Promise<PreparedSwap> {
    if (!quote.executable) throw new SwapNotExecutable(this.id, quote.nonExecutableReason ?? 'unknown');
    const raw = quote.raw as { response: LifiQuoteResponse; depositAddress: string; tokenAddress?: string };
    const p: PreparedSwap = {
      quote,
      depositAddress: raw.depositAddress,
      amount: quote.amountIn,
      deadline: quote.deadline,
      providerRef: raw.response.id,
      raw: raw.response,
    };
    if (raw.tokenAddress) p.tokenAddress = raw.tokenAddress;
    return p;
  }

  /** LI.FI status is keyed by the origin tx hash, which we remember here. */
  async submitDeposit(p: PreparedSwap, txHash: string): Promise<void> {
    this.depositTx.set(p.providerRef, txHash);
  }

  async status(p: PreparedSwap): Promise<SwapStatus> {
    const txHash = this.depositTx.get(p.providerRef);
    if (!txHash) return { status: 'pending', providerStatus: 'NO_DEPOSIT_TX', reason: 'submitDeposit not called yet' };
    const q = new URLSearchParams({
      txHash,
      fromChain: String(LIFI_CHAIN_IDS[p.quote.request.from.chain]),
      toChain: String(LIFI_CHAIN_IDS[p.quote.request.to.chain]),
    });
    const res = await httpJson<LifiStatusResponse>(this.http, 'GET', joinUrl(this.baseUrl, `/v1/status?${q}`));
    return mapLifiStatus(res);
  }
}

export function mapLifiStatus(res: LifiStatusResponse): SwapStatus {
  let status: SwapState;
  if (res.status === 'DONE') status = res.substatus === 'REFUNDED' ? 'refunded' : 'success';
  else if (res.status === 'FAILED' || res.status === 'INVALID') status = 'failed';
  else status = 'pending';
  const out: SwapStatus = { status, providerStatus: res.substatus ? `${res.status}/${res.substatus}` : res.status, raw: res };
  if (res.sending?.txHash) out.originTxHash = res.sending.txHash;
  if (res.receiving?.txHash) {
    if (status === 'refunded') out.refundTxHash = res.receiving.txHash;
    else out.destinationTxHash = res.receiving.txHash;
  }
  if (status === 'success' && res.receiving?.amount) out.amountOut = BigInt(res.receiving.amount);
  if (res.substatusMessage && status !== 'success') out.reason = res.substatusMessage;
  return out;
}
