export class SwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The provider's quote/prepared swap does not pay/refund the account's own addresses. */
export class SwapRecipientMismatch extends SwapError {
  constructor(
    readonly field: 'recipient' | 'refundTo',
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`swap ${field} mismatch: expected ${expected}, got ${actual}`);
  }
}

/** HTTP / protocol error from a provider API. */
export class SwapProviderError extends SwapError {
  constructor(
    readonly providerId: string,
    message: string,
    readonly httpStatus?: number,
    readonly body?: unknown,
  ) {
    super(`[${providerId}] ${message}`);
  }
}

export class SwapTimeoutError extends SwapError {
  constructor(readonly providerId: string, readonly timeoutMs: number) {
    super(`[${providerId}] quote timed out after ${timeoutMs}ms`);
  }
}

/** The route needs calldata, approvals or a memo, which the policy program cannot approve. */
export class SwapNotExecutable extends SwapError {
  constructor(readonly providerId: string, reason: string) {
    super(`[${providerId}] route is not executable with a plain transfer: ${reason}`);
  }
}

/** A fee recipient cannot be represented by the provider (e.g. not a NEAR Intents account id). */
export class UnsupportedFeeRecipient extends SwapError {
  constructor(readonly providerId: string, readonly recipient: string, reason: string) {
    super(`[${providerId}] unsupported fee recipient ${recipient}: ${reason}`);
  }
}

/** The fresh (non-dry) quote returned by prepare is worse than the quote's minimum. */
export class SwapQuoteDegraded extends SwapError {
  constructor(readonly providerId: string, readonly minAmountOut: bigint, readonly amountOut: bigint) {
    super(`[${providerId}] prepared amountOut ${amountOut} is below quoted minAmountOut ${minAmountOut}`);
  }
}
