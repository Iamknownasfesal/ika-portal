/**
 * NEAR Intents 1Click API provider.
 *
 * API: https://1click.chaindefuser.com (OpenAPI: /docs/v0/openapi.yaml)
 *   POST /v0/quote            (dry: true => quote, dry: false => deposit address)
 *   POST /v0/deposit/submit   {txHash, depositAddress}
 *   GET  /v0/status?depositAddress=...
 *   GET  /v0/tokens
 *
 * The partner JWT MUST NOT be shipped to clients: point `baseUrl` at the wallet's backend
 * proxy (see `createNearIntentsProxyHandler`), which injects `Authorization: Bearer <jwt>`.
 */
import { EVM_TOKEN_ADDRESSES, assetKey, isSupportedAsset, type AssetKey } from '../assets.js';
import { SwapNotExecutable, SwapProviderError, SwapQuoteDegraded, UnsupportedFeeRecipient } from '../errors.js';
import type { FeeConfig, FetchLike, PreparedSwap, Quote, QuoteRequest, SwapProvider, SwapState, SwapStatus } from '../types.js';
import {
  activeFees,
  base58Decode,
  configuredFeeLines,
  defaultFetch,
  httpJson,
  isEvmAddress,
  isoToSec,
  joinUrl,
  nowSec,
  sameAddress,
  toBigInt,
  toHex,
  type HttpOptions,
} from '../util.js';

export const NEAR_INTENTS_DEFAULT_BASE_URL = 'https://1click.chaindefuser.com';

/**
 * 1Click asset ids for the MVP assets, taken from `GET /v0/tokens` (recorded 2026-09-30,
 * fixture: test/fixtures/near/tokens.json). Override per instance with `assetIds`.
 * Note: 1Click also lists `1cs_v1:btc:native:coin` ("BTC(OMNI)") and normalizes
 * `nep141:btc.omft.near` to it in the echoed quoteRequest; both are accepted as input.
 */
export const NEAR_INTENTS_ASSET_IDS: Partial<Record<AssetKey, string>> = {
  'bitcoin:BTC': 'nep141:btc.omft.near',
  'ethereum:ETH': 'nep141:eth.omft.near',
  'ethereum:USDC': `nep141:eth-${EVM_TOKEN_ADDRESSES['ethereum:USDC']}.omft.near`, // nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near
  'base:ETH': 'nep141:base.omft.near',
  'base:USDC': `nep141:base-${EVM_TOKEN_ADDRESSES['base:USDC']}.omft.near`, // nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
};

export type NearStatus =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export const NEAR_STATUS_MAP: Record<NearStatus, SwapState> = {
  PENDING_DEPOSIT: 'pending',
  KNOWN_DEPOSIT_TX: 'pending',
  PROCESSING: 'pending',
  SUCCESS: 'success',
  REFUNDED: 'refunded',
  FAILED: 'failed',
  INCOMPLETE_DEPOSIT: 'failed',
};

export interface NearAppFee {
  recipient: string;
  fee: number;
}

export interface NearQuoteRequestBody {
  dry: boolean;
  swapType: 'EXACT_INPUT';
  depositMode: 'SIMPLE';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
  appFees?: NearAppFee[];
  referral?: string;
  quoteWaitingTimeMs?: number;
}

export interface NearQuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: Partial<NearQuoteRequestBody> & { recipient: string; refundTo: string; appFees?: NearAppFee[] };
  quote: {
    depositAddress?: string;
    depositMemo?: string;
    amountIn: string;
    minAmountIn: string;
    amountOut: string;
    minAmountOut: string;
    deadline?: string;
    timeWhenInactive?: string;
    timeEstimate: number;
    refundFee?: string;
    withdrawFee?: string;
    [k: string]: unknown;
  };
}

export interface NearStatusResponse {
  correlationId: string;
  status: NearStatus;
  updatedAt: string;
  quoteResponse?: NearQuoteResponse;
  swapDetails?: {
    amountOut?: string | null;
    refundedAmount?: string | null;
    refundReason?: string | null;
    originChainTxHashes?: { hash: string; explorerUrl?: string }[];
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
  };
}

export interface NearIntentsProviderOptions {
  /** URL of the wallet's 1Click proxy (or the public API for keyless dry quotes). */
  baseUrl: string;
  /** Overrides / additions to NEAR_INTENTS_ASSET_IDS. */
  assetIds?: Partial<Record<AssetKey, string>>;
  fetch?: FetchLike;
  /** Extra headers for the proxy (e.g. a wallet session token). Never put the 1Click JWT here in client code. */
  headers?: Record<string, string>;
  id?: string;
  /** Refund deadline from now, in seconds. Default: 2h for Bitcoin origin (confirmations), 30 min otherwise. */
  deadlineSec?: number | ((req: QuoteRequest) => number);
  /** Dry-quote validity (seconds) used for `Quote.expiresAt`. Default 60. */
  quoteTtlSec?: number;
  /** Distribution-channel identifier, sent as `referral`. */
  referral?: string;
  quoteWaitingTimeMs?: number;
  now?: () => number;
}

const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BECH32_BTC_RE = /^(bc1|tb1|bcrt1)[a-z0-9]{8,}$/i;

/**
 * Map a fee recipient to a NEAR Intents account id (1Click `appFees[].recipient`).
 *
 * 1Click credits app fees to an account INSIDE NEAR Intents (verifier contract), not on-chain.
 * Observed on the live API (2026-09-30): the recipient is NOT validated at quote time (even "x"
 * is accepted), so a wrong value silently loses fees. We therefore validate here:
 *  - NEAR named or implicit (64-hex) account ids are used as-is;
 *  - EVM addresses map to their Intents implicit account id: the lowercase 0x address
 *    (withdrawable by signing intents with that EVM key);
 *  - Solana base58 ed25519 public keys map to the NEAR implicit account (hex of the key);
 *  - Bitcoin addresses and anything else are rejected.
 */
export function toIntentsAccountId(recipient: string, providerId = 'near-intents'): string {
  if (isEvmAddress(recipient)) return recipient.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(recipient)) return recipient;
  if (BECH32_BTC_RE.test(recipient)) throw new UnsupportedFeeRecipient(providerId, recipient, 'bitcoin addresses cannot hold Intents balances');
  // Base58 (Solana key or legacy BTC) unless it is also a plain lowercase NEAR account id.
  const maybeBase58 = /^[1-9A-HJ-NP-Za-km-z]{25,44}$/.test(recipient) && (/[A-Z]/.test(recipient) || !NEAR_ACCOUNT_RE.test(recipient));
  if (maybeBase58) {
    const bytes = base58Decode(recipient);
    if (bytes?.length === 32) return toHex(bytes); // Solana ed25519 key -> NEAR implicit account
    if (bytes?.length === 25) throw new UnsupportedFeeRecipient(providerId, recipient, 'bitcoin addresses cannot hold Intents balances');
  }
  if (NEAR_ACCOUNT_RE.test(recipient)) return recipient;
  throw new UnsupportedFeeRecipient(providerId, recipient, 'not a NEAR Intents account id, EVM address or Solana public key');
}

export class NearIntentsProvider implements SwapProvider {
  readonly id: string;
  readonly baseUrl: string;
  private readonly assetIds: Partial<Record<AssetKey, string>>;
  private readonly http: HttpOptions;
  private readonly opts: NearIntentsProviderOptions;
  private readonly now: () => number;

  constructor(opts: NearIntentsProviderOptions) {
    this.opts = opts;
    this.id = opts.id ?? 'near-intents';
    this.baseUrl = opts.baseUrl;
    this.assetIds = { ...NEAR_INTENTS_ASSET_IDS, ...opts.assetIds };
    this.http = { providerId: this.id, fetch: opts.fetch ?? defaultFetch(), ...(opts.headers ? { headers: opts.headers } : {}) };
    this.now = opts.now ?? nowSec;
  }

  supportsFees(fees: FeeConfig): boolean {
    try {
      this.mapAppFees(fees);
      return true;
    } catch {
      return false;
    }
  }

  mapAppFees(fees: FeeConfig): NearAppFee[] {
    return activeFees(fees).map((f) => ({ recipient: toIntentsAccountId(f.recipient, this.id), fee: f.bps }));
  }

  private deadlineFor(req: QuoteRequest): number {
    const d = this.opts.deadlineSec;
    if (typeof d === 'function') return d(req);
    if (typeof d === 'number') return d;
    return req.from.chain === 'bitcoin' ? 2 * 3600 : 30 * 60;
  }

  /** Build the 1Click POST /v0/quote body. Returns null if an asset is not mapped. */
  buildQuoteBody(req: QuoteRequest, dry: boolean): NearQuoteRequestBody | null {
    if (!isSupportedAsset(req.from.chain, req.from.asset) || !isSupportedAsset(req.to.chain, req.to.asset)) return null;
    const originAsset = this.assetIds[assetKey(req.from.chain, req.from.asset)];
    const destinationAsset = this.assetIds[assetKey(req.to.chain, req.to.asset)];
    if (!originAsset || !destinationAsset || originAsset === destinationAsset) return null;
    const body: NearQuoteRequestBody = {
      dry,
      swapType: 'EXACT_INPUT',
      depositMode: 'SIMPLE',
      slippageTolerance: req.slippageBps,
      originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset,
      amount: req.from.amount.toString(),
      refundTo: req.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: req.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date((this.now() + this.deadlineFor(req)) * 1000).toISOString(),
    };
    const appFees = this.mapAppFees(req.fees);
    if (appFees.length) body.appFees = appFees;
    if (this.opts.referral) body.referral = this.opts.referral;
    if (this.opts.quoteWaitingTimeMs !== undefined) body.quoteWaitingTimeMs = this.opts.quoteWaitingTimeMs;
    return body;
  }

  private toQuote(req: QuoteRequest, res: NearQuoteResponse, sentDeadline: string): Quote {
    const q = res.quote;
    const amountIn = toBigInt(q.amountIn, 'amountIn');
    const provider: Quote['fees']['provider'] = [];
    if (q.withdrawFee) provider.push({ name: 'withdrawFee', amount: toBigInt(q.withdrawFee, 'withdrawFee'), side: 'output' });
    // Fees 1Click added on top of ours (e.g. its keyless-access fee), as echoed in quoteRequest.appFees.
    // 1Click may also rewrite our bps (observed without a JWT: 30 -> 15), so fee lines use the echoed bps.
    const echoed = res.quoteRequest.appFees ?? [];
    const ours = this.mapAppFees(req.fees);
    const oursSet = new Set(ours.map((f) => f.recipient));
    for (const f of echoed) {
      if (!oursSet.has(f.recipient)) provider.push({ name: `appFee:${f.recipient}`, amount: (amountIn * BigInt(f.fee)) / 10_000n, side: 'input', bps: f.fee });
    }
    const feeLines = configuredFeeLines(req.fees, amountIn, 'input');
    for (const line of [feeLines.integrator, feeLines.ika]) {
      if (!line) continue;
      const e = echoed.find((f) => f.recipient === toIntentsAccountId(line.recipient, this.id));
      if (e && e.fee !== line.bps) {
        line.bps = e.fee;
        line.amount = (amountIn * BigInt(e.fee)) / 10_000n;
      }
    }
    const requestDeadline = isoToSec(res.quoteRequest.deadline ?? sentDeadline) ?? isoToSec(sentDeadline)!;
    const depositDeadline = isoToSec(q.deadline);
    const quote: Quote = {
      providerId: this.id,
      request: req,
      amountIn,
      amountOut: toBigInt(q.amountOut, 'amountOut'),
      minAmountOut: toBigInt(q.minAmountOut, 'minAmountOut'),
      fees: { ...feeLines, provider },
      recipient: res.quoteRequest.recipient,
      refundTo: res.quoteRequest.refundTo,
      deadline: depositDeadline !== undefined ? Math.min(requestDeadline, depositDeadline) : requestDeadline,
      expiresAt: this.now() + (this.opts.quoteTtlSec ?? 60),
      executable: true,
      estimatedTimeSec: q.timeEstimate,
      raw: res,
    };
    return quote;
  }

  async quote(req: QuoteRequest, opts?: { signal?: AbortSignal }): Promise<Quote | null> {
    const body = this.buildQuoteBody(req, true);
    if (!body) return null;
    const res = await httpJson<NearQuoteResponse>(this.http, 'POST', joinUrl(this.baseUrl, '/v0/quote'), body, opts?.signal);
    return this.toQuote(req, res, body.deadline);
  }

  async prepare(quote: Quote): Promise<PreparedSwap> {
    const req = quote.request;
    const body = this.buildQuoteBody(req, false);
    if (!body) throw new SwapProviderError(this.id, 'route no longer supported');
    const res = await httpJson<NearQuoteResponse>(this.http, 'POST', joinUrl(this.baseUrl, '/v0/quote'), body);
    const depositAddress = res.quote.depositAddress;
    if (!depositAddress) throw new SwapProviderError(this.id, 'non-dry quote returned no depositAddress', undefined, res);
    if (res.quote.depositMemo) throw new SwapNotExecutable(this.id, 'deposit requires a memo');
    const fresh = this.toQuote(req, res, body.deadline);
    if (!sameAddress(fresh.recipient, req.recipient) || !sameAddress(fresh.refundTo, req.refundTo)) {
      // assertOwnAddresses() will raise the precise error; keep the provider honest here too.
      throw new SwapProviderError(this.id, 'prepared quote recipient/refundTo differs from request', undefined, res);
    }
    if (fresh.amountIn !== req.from.amount) throw new SwapProviderError(this.id, `prepared amountIn ${fresh.amountIn} != ${req.from.amount}`);
    if (fresh.amountOut < quote.minAmountOut) throw new SwapQuoteDegraded(this.id, quote.minAmountOut, fresh.amountOut);
    const tokenAddress = req.from.asset === 'USDC' ? EVM_TOKEN_ADDRESSES[assetKey(req.from.chain, req.from.asset)] : undefined;
    const prepared: PreparedSwap = {
      quote: fresh,
      depositAddress,
      amount: fresh.amountIn,
      deadline: fresh.deadline,
      providerRef: depositAddress,
      raw: res,
    };
    if (tokenAddress) prepared.tokenAddress = tokenAddress;
    return prepared;
  }

  async submitDeposit(p: PreparedSwap, txHash: string): Promise<void> {
    await httpJson(this.http, 'POST', joinUrl(this.baseUrl, '/v0/deposit/submit'), { txHash, depositAddress: p.depositAddress });
  }

  async status(p: PreparedSwap): Promise<SwapStatus> {
    const url = joinUrl(this.baseUrl, `/v0/status?depositAddress=${encodeURIComponent(p.depositAddress)}`);
    const res = await httpJson<NearStatusResponse>(this.http, 'GET', url);
    return mapNearStatus(res);
  }

  /** GET /v0/tokens (useful to refresh the asset id table). */
  async tokens(): Promise<{ assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress?: string }[]> {
    return httpJson(this.http, 'GET', joinUrl(this.baseUrl, '/v0/tokens'));
  }
}

export function mapNearStatus(res: NearStatusResponse): SwapStatus {
  const status = NEAR_STATUS_MAP[res.status];
  if (!status) throw new SwapProviderError('near-intents', `unknown 1Click status ${String(res.status)}`, undefined, res);
  const d = res.swapDetails ?? {};
  const out: SwapStatus = { status, providerStatus: res.status, raw: res };
  const origin = d.originChainTxHashes?.[0]?.hash;
  const dest = d.destinationChainTxHashes?.[0]?.hash;
  if (origin) out.originTxHash = origin;
  if (status === 'refunded') {
    // The refund is paid on the origin chain; 1Click reports it among the tx hashes after the deposit.
    const refund = d.originChainTxHashes?.[1]?.hash ?? dest;
    if (refund) out.refundTxHash = refund;
  } else if (dest) out.destinationTxHash = dest;
  if (status === 'success' && d.amountOut) out.amountOut = toBigInt(d.amountOut, 'amountOut');
  if (d.refundReason) out.reason = d.refundReason;
  if (res.status === 'INCOMPLETE_DEPOSIT') out.reason ??= 'deposit smaller than quoted amountIn';
  return out;
}
