/**
 * Relay (relay.link) provider — deposit-address flow only.
 *
 * API: https://api.relay.link (OpenAPI: /documentation/json)
 *   POST /quote/v2 { useDepositAddress: true, refundTo, appFees, ... }
 *   POST /transactions/index { chainId, txHash, requestId }   (speeds up indexing)
 *   GET  /intents/status/v3?requestId=...
 *
 * With `useDepositAddress: true` Relay returns a single "deposit" step whose item is a plain
 * transfer to a per-request deposit address (BTC: `{amount}` to `depositAddress`; native ETH:
 * `data: "0x"`; ERC-20: `transfer(depositAddress, amount)`). Relay has no dry mode: the deposit
 * address is registered by the quote call itself, so `prepare` reuses it (re-quoting if expired).
 * Every step is verified to be a plain transfer; anything else yields `executable: false`.
 */
import { EVM_CHAIN_IDS, EVM_TOKEN_ADDRESSES, assetKey, isNative, isSupportedAsset, type AssetKey } from '../assets.js';
import { SwapNotExecutable, SwapProviderError } from '../errors.js';
import type { Chain, FeeConfig, FetchLike, PreparedSwap, Quote, QuoteRequest, SwapProvider, SwapState, SwapStatus } from '../types.js';
import {
  activeFees,
  configuredFeeLines,
  decodeErc20Transfer,
  defaultFetch,
  httpJson,
  isEvmAddress,
  joinUrl,
  nowSec,
  sameAddress,
  toBigInt,
  type HttpOptions,
} from '../util.js';

export const RELAY_DEFAULT_BASE_URL = 'https://api.relay.link';
export const RELAY_BITCOIN_CHAIN_ID = 8253038;

export const RELAY_CHAIN_IDS: Record<Chain, number> = {
  bitcoin: RELAY_BITCOIN_CHAIN_ID,
  ...EVM_CHAIN_IDS,
};

/** Relay currency ids (from GET /chains, 2026-09-30). */
export const RELAY_CURRENCIES: Partial<Record<AssetKey, string>> = {
  'bitcoin:BTC': 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8',
  'ethereum:ETH': '0x0000000000000000000000000000000000000000',
  'ethereum:USDC': EVM_TOKEN_ADDRESSES['ethereum:USDC']!,
  'base:ETH': '0x0000000000000000000000000000000000000000',
  'base:USDC': EVM_TOKEN_ADDRESSES['base:USDC']!,
};

export type RelayStatus = 'refund' | 'waiting' | 'depositing' | 'failure' | 'pending' | 'submitted' | 'success';

export const RELAY_STATUS_MAP: Record<RelayStatus, SwapState> = {
  waiting: 'pending',
  depositing: 'pending',
  pending: 'pending',
  submitted: 'pending',
  success: 'success',
  refund: 'refunded',
  failure: 'failed',
};

interface RelayAmount {
  currency: { chainId: number; address: string; symbol: string; decimals: number };
  amount: string;
  minimumAmount?: string;
}

export interface RelayQuoteResponse {
  requestId?: string;
  steps: {
    id: string;
    kind: string;
    requestId?: string;
    depositAddress?: string;
    items: { status: string; data: Record<string, unknown>; check?: { endpoint: string; method: string } }[];
  }[];
  fees: Record<string, RelayAmount | undefined>;
  details: {
    sender?: string;
    recipient?: string;
    currencyIn: RelayAmount;
    currencyOut: RelayAmount;
    timeEstimate?: number;
    [k: string]: unknown;
  };
  protocol?: {
    v2?: {
      orderData?: {
        inputs?: { refunds?: { chainId: string; recipient: string; deadline?: number }[] }[];
        output?: { payments?: { recipient: string }[]; deadline?: number };
      };
    };
  };
}

export interface RelayStatusResponse {
  status: RelayStatus;
  details?: string;
  inTxHashes?: string[];
  txHashes?: string[];
  failReason?: string | null;
  refundFailReason?: string | null;
}

export interface RelayProviderOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  /** e.g. `{ 'x-api-key': ... }` — only in server-side use. */
  headers?: Record<string, string>;
  id?: string;
  currencies?: Partial<Record<AssetKey, string>>;
  /** Deposit window (seconds), also sent as Relay `ttl`. Default 2h for Bitcoin origin, 30 min otherwise. */
  depositWindowSec?: number | ((req: QuoteRequest) => number);
  /** Quote validity (seconds) before `prepare` re-quotes. Default 30. */
  quoteTtlSec?: number;
  referrer?: string;
  now?: () => number;
}

interface RelayRaw {
  response: RelayQuoteResponse;
  depositAddress?: string;
  requestId?: string;
  tokenAddress?: string;
}

export class RelayProvider implements SwapProvider {
  readonly id: string;
  readonly baseUrl: string;
  private readonly http: HttpOptions;
  private readonly currencies: Partial<Record<AssetKey, string>>;
  private readonly opts: RelayProviderOptions;
  private readonly now: () => number;

  constructor(opts: RelayProviderOptions = {}) {
    this.opts = opts;
    this.id = opts.id ?? 'relay';
    this.baseUrl = opts.baseUrl ?? RELAY_DEFAULT_BASE_URL;
    this.currencies = { ...RELAY_CURRENCIES, ...opts.currencies };
    this.http = { providerId: this.id, fetch: opts.fetch ?? defaultFetch(), ...(opts.headers ? { headers: opts.headers } : {}) };
    this.now = opts.now ?? nowSec;
  }

  /**
   * Relay `appFees` accept multiple `{recipient, fee(bps)}` entries; fees accrue to the recipient's
   * Relay app-fee balance (claimable via /app-fees/{wallet}/claim). We only accept EVM recipients.
   */
  supportsFees(fees: FeeConfig): boolean {
    return activeFees(fees).every((f) => isEvmAddress(f.recipient));
  }

  private windowFor(req: QuoteRequest): number {
    const d = this.opts.depositWindowSec;
    if (typeof d === 'function') return d(req);
    if (typeof d === 'number') return d;
    return req.from.chain === 'bitcoin' ? 2 * 3600 : 30 * 60;
  }

  buildQuoteBody(req: QuoteRequest): Record<string, unknown> | null {
    if (!isSupportedAsset(req.from.chain, req.from.asset) || !isSupportedAsset(req.to.chain, req.to.asset)) return null;
    const originCurrency = this.currencies[assetKey(req.from.chain, req.from.asset)];
    const destinationCurrency = this.currencies[assetKey(req.to.chain, req.to.asset)];
    if (!originCurrency || !destinationCurrency) return null;
    if (req.from.chain === req.to.chain && req.from.asset === req.to.asset) return null;
    const body: Record<string, unknown> = {
      user: req.refundTo,
      recipient: req.recipient,
      originChainId: RELAY_CHAIN_IDS[req.from.chain],
      destinationChainId: RELAY_CHAIN_IDS[req.to.chain],
      originCurrency,
      destinationCurrency,
      amount: req.from.amount.toString(),
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
      refundTo: req.refundTo,
      refundOnOrigin: true,
      slippageTolerance: String(req.slippageBps),
      ttl: this.windowFor(req),
    };
    const appFees = activeFees(req.fees).map((f) => ({ recipient: f.recipient, fee: String(f.bps) }));
    if (appFees.length) body.appFees = appFees;
    if (this.opts.referrer) body.referrer = this.opts.referrer;
    return body;
  }

  /** Checks that the returned steps are exactly one plain transfer of `amount` to a deposit address. */
  analyzeSteps(req: QuoteRequest, res: RelayQuoteResponse): { executable: true; depositAddress: string; requestId: string; tokenAddress?: string } | { executable: false; reason: string } {
    const steps = res.steps ?? [];
    if (steps.length !== 1) return { executable: false, reason: `expected 1 step, got ${steps.map((s) => s.id).join(',')}` };
    const step = steps[0]!;
    if (step.id !== 'deposit' || step.kind !== 'transaction') return { executable: false, reason: `unexpected step ${step.id}/${step.kind}` };
    if (step.items.length !== 1) return { executable: false, reason: 'deposit step has multiple items' };
    const depositAddress = step.depositAddress;
    const requestId = step.requestId ?? res.requestId;
    if (!depositAddress || !requestId) return { executable: false, reason: 'no deposit address (route requires calldata)' };
    const data = step.items[0]!.data;
    const amount = req.from.amount;
    if (req.from.chain === 'bitcoin') {
      const extra = Object.keys(data).filter((k) => !['amount', 'tokenSymbol'].includes(k));
      if (extra.length) return { executable: false, reason: `bitcoin deposit carries extra data: ${extra.join(',')}` };
      if (toBigInt(data.amount, 'amount') !== amount) return { executable: false, reason: 'deposit amount differs from request' };
      return { executable: true, depositAddress, requestId };
    }
    const to = String(data.to ?? '');
    const callData = String(data.data ?? '0x');
    const value = BigInt(String(data.value ?? '0'));
    if (Number(data.chainId) !== RELAY_CHAIN_IDS[req.from.chain]) return { executable: false, reason: 'deposit on unexpected chain' };
    if (isNative(req.from.chain, req.from.asset)) {
      if (callData !== '0x' && callData !== '') return { executable: false, reason: 'native deposit carries calldata' };
      if (!sameAddress(to, depositAddress)) return { executable: false, reason: 'native deposit target is not the deposit address' };
      if (value !== amount) return { executable: false, reason: 'deposit value differs from request' };
      return { executable: true, depositAddress, requestId };
    }
    const token = this.currencies[assetKey(req.from.chain, req.from.asset)]!;
    const decoded = decodeErc20Transfer(callData);
    if (!decoded) return { executable: false, reason: 'ERC-20 deposit is not a plain transfer(to, amount)' };
    if (!sameAddress(to, token)) return { executable: false, reason: 'ERC-20 transfer targets an unexpected token' };
    if (!sameAddress(decoded.to, depositAddress)) return { executable: false, reason: 'ERC-20 transfer recipient is not the deposit address' };
    if (decoded.amount !== amount || value !== 0n) return { executable: false, reason: 'ERC-20 transfer amount/value mismatch' };
    return { executable: true, depositAddress, requestId, tokenAddress: token };
  }

  private toQuote(req: QuoteRequest, res: RelayQuoteResponse): Quote {
    const a = this.analyzeSteps(req, res);
    const amountIn = toBigInt(res.details.currencyIn.amount, 'currencyIn.amount');
    const amountOut = toBigInt(res.details.currencyOut.amount, 'currencyOut.amount');
    const minAmountOut = toBigInt(res.details.currencyOut.minimumAmount ?? res.details.currencyOut.amount, 'currencyOut.minimumAmount');
    const provider: Quote['fees']['provider'] = [];
    for (const [name, f] of Object.entries(res.fees ?? {})) {
      if (!f || name === 'app' || name === 'subsidized' || name === 'relayerGas' || name === 'relayerService') continue; // relayer = gas + service
      const amt = BigInt(f.amount);
      if (amt === 0n) continue;
      const side = f.currency.chainId === RELAY_CHAIN_IDS[req.from.chain] && sameAddress(f.currency.address, res.details.currencyIn.currency.address) ? 'input' : 'output';
      provider.push({ name, amount: amt, side });
    }
    const order = res.protocol?.v2?.orderData;
    const recipient = order?.output?.payments?.[0]?.recipient ?? res.details.recipient ?? req.recipient;
    const originRefund = order?.inputs?.[0]?.refunds?.find((r) => r.chainId === req.from.chain); // Relay protocol chain slugs match our Chain names
    const refundTo = originRefund?.recipient ?? req.refundTo;
    const now = this.now();
    const raw: RelayRaw = { response: res };
    if (a.executable) {
      raw.depositAddress = a.depositAddress;
      raw.requestId = a.requestId;
      if (a.tokenAddress) raw.tokenAddress = a.tokenAddress;
    }
    const quote: Quote = {
      providerId: this.id,
      request: req,
      amountIn,
      amountOut,
      minAmountOut,
      fees: { ...configuredFeeLines(req.fees, amountIn, 'input'), provider },
      recipient,
      refundTo,
      deadline: now + this.windowFor(req),
      expiresAt: now + (this.opts.quoteTtlSec ?? 30),
      executable: a.executable,
      raw,
    };
    if (!a.executable) quote.nonExecutableReason = a.reason;
    if (typeof res.details.timeEstimate === 'number') quote.estimatedTimeSec = res.details.timeEstimate;
    return quote;
  }

  async quote(req: QuoteRequest, opts?: { signal?: AbortSignal }): Promise<Quote | null> {
    const body = this.buildQuoteBody(req);
    if (!body) return null;
    const res = await httpJson<RelayQuoteResponse>(this.http, 'POST', joinUrl(this.baseUrl, '/quote/v2'), body, opts?.signal);
    return this.toQuote(req, res);
  }

  async prepare(quote: Quote): Promise<PreparedSwap> {
    let q = quote;
    if (q.expiresAt <= this.now()) {
      const fresh = await this.quote(q.request);
      if (!fresh) throw new SwapProviderError(this.id, 'route no longer supported');
      q = fresh;
    }
    if (!q.executable) throw new SwapNotExecutable(this.id, q.nonExecutableReason ?? 'unknown');
    const raw = q.raw as RelayRaw;
    const p: PreparedSwap = {
      quote: q,
      depositAddress: raw.depositAddress!,
      amount: q.amountIn,
      deadline: q.deadline,
      providerRef: raw.requestId!,
      raw: raw.response,
    };
    if (raw.tokenAddress) p.tokenAddress = raw.tokenAddress;
    return p;
  }

  async submitDeposit(p: PreparedSwap, txHash: string): Promise<void> {
    await httpJson(this.http, 'POST', joinUrl(this.baseUrl, '/transactions/index'), {
      chainId: String(RELAY_CHAIN_IDS[p.quote.request.from.chain]),
      txHash,
      requestId: p.providerRef,
    });
  }

  async status(p: PreparedSwap): Promise<SwapStatus> {
    const url = joinUrl(this.baseUrl, `/intents/status/v3?requestId=${encodeURIComponent(p.providerRef)}`);
    const res = await httpJson<RelayStatusResponse>(this.http, 'GET', url);
    return mapRelayStatus(res);
  }
}

export function mapRelayStatus(res: RelayStatusResponse): SwapStatus {
  const status = RELAY_STATUS_MAP[res.status];
  if (!status) throw new SwapProviderError('relay', `unknown Relay status ${String(res.status)}`, undefined, res);
  const out: SwapStatus = { status, providerStatus: res.status, raw: res };
  if (res.inTxHashes?.[0]) out.originTxHash = res.inTxHashes[0];
  if (res.txHashes?.[0]) {
    if (status === 'refunded') out.refundTxHash = res.txHashes[0];
    else out.destinationTxHash = res.txHashes[0];
  }
  const reason = res.failReason && res.failReason !== 'N/A' ? res.failReason : res.details;
  if (reason && status !== 'success') out.reason = reason;
  return out;
}
