/**
 * Core swap types for the Ika Portal SDK.
 *
 * All amounts are `bigint` in base units of the relevant asset
 * (BTC: 8 decimals, ETH: 18, USDC: 6). They are serialized to decimal
 * strings only at API boundaries.
 */

export type Chain = 'bitcoin' | 'ethereum' | 'base';
export type AssetSymbol = 'BTC' | 'ETH' | 'USDC';

export type FeeConfig = {
  integrator: { recipient: string; bps: number };
  ika?: { recipient: string; bps: number };
};

export type QuoteRequest = {
  from: { chain: Chain; asset: AssetSymbol; amount: bigint };
  to: { chain: Chain; asset: AssetSymbol };
  /** the account's own address on the destination chain */
  recipient: string;
  /** the account's own address on the origin chain */
  refundTo: string;
  slippageBps: number;
  fees: FeeConfig;
};

/** Which side of the swap a fee amount is denominated in. */
export type FeeSide = 'input' | 'output';

export interface FeeLine {
  recipient: string;
  bps: number;
  /** Fee amount in base units of the origin asset (side 'input') or destination asset (side 'output'). */
  amount: bigint;
  side: FeeSide;
}

export interface ProviderFee {
  name: string;
  amount: bigint;
  side: FeeSide;
  /** Provider-side fee in basis points, when known. */
  bps?: number;
}

export interface QuoteFees {
  integrator?: FeeLine;
  ika?: FeeLine;
  /** Fees charged by the provider itself (protocol, relayer, gas, withdraw...). Informational. */
  provider: ProviderFee[];
}

export interface Quote {
  providerId: string;
  request: QuoteRequest;
  /** Exact amount of the origin asset the account must send. */
  amountIn: bigint;
  /** Expected amount of the destination asset delivered to `recipient`, net of ALL fees. */
  amountOut: bigint;
  /** Minimum delivered amount after slippage. */
  minAmountOut: bigint;
  fees: QuoteFees;
  /** Destination address the provider will pay (as echoed by the provider). */
  recipient: string;
  /** Origin-chain refund address (as echoed by the provider). */
  refundTo: string;
  /** Unix seconds. After this the provider refunds / the deposit is no longer honoured. */
  deadline: number;
  /** Unix seconds. After this the quote should be refreshed before `prepare`. */
  expiresAt: number;
  /**
   * True if the route can be funded by a PLAIN transfer (native send or ERC-20
   * `transfer(to, amount)`) to a deposit address, with no memo / calldata / approval.
   * The Ika policy program can only approve plain transfers, so the router never
   * picks a non-executable quote as `best`.
   */
  executable: boolean;
  nonExecutableReason?: string;
  /** Estimated seconds from deposit confirmation to delivery, if known. */
  estimatedTimeSec?: number;
  /** Raw provider payload, kept for disputes and debugging. */
  raw: unknown;
}

export interface PreparedSwap {
  quote: Quote;
  /** Address on the origin chain that receives the plain transfer. */
  depositAddress: string;
  /** Memos are never allowed: the deposit must be a plain transfer. */
  depositMemo?: never;
  /** Exact amount to send, in base units of the origin asset. */
  amount: bigint;
  /** ERC-20 contract to call `transfer(depositAddress, amount)` on; undefined for native BTC/ETH. */
  tokenAddress?: string;
  /** Unix seconds. The deposit must be confirmed before this. */
  deadline: number;
  /** Provider-specific reference (deposit address, request id, ...). */
  providerRef: string;
  raw?: unknown;
}

export type SwapState = 'pending' | 'success' | 'refunded' | 'failed';

export interface SwapStatus {
  status: SwapState;
  /** Provider-native status string, e.g. `PROCESSING`. */
  providerStatus?: string;
  originTxHash?: string;
  destinationTxHash?: string;
  refundTxHash?: string;
  /** Actual delivered amount, when reported. */
  amountOut?: bigint;
  reason?: string;
  raw?: unknown;
}

export interface SwapProvider {
  id: string;
  /** can this provider express the configured fees? */
  supportsFees(fees: FeeConfig): boolean;
  /** null = route not supported */
  quote(req: QuoteRequest, opts?: { signal?: AbortSignal }): Promise<Quote | null>;
  /** deposit address, exact amount, deadline */
  prepare(quote: Quote): Promise<PreparedSwap>;
  submitDeposit?(p: PreparedSwap, txHash: string): Promise<void>;
  /** 'pending' | 'success' | 'refunded' | 'failed' */
  status(p: PreparedSwap): Promise<SwapStatus>;
}

/** Minimal fetch signature so tests can inject recorded responses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
