import { SwapRecipientMismatch, SwapTimeoutError } from './errors.js';
import type { PreparedSwap, Quote, QuoteRequest, SwapProvider } from './types.js';
import { assertValidFees, sameAddress, totalFeeBps } from './util.js';

export interface SwapRouterOptions {
  providers: SwapProvider[];
  /** Provider ids in tie-break order (first wins). Providers not listed rank after, in `providers` order. */
  priority?: string[];
  /** Per-provider quote timeout. Default 3000 ms. */
  timeoutMs?: number;
}

export interface QuoteAllResult {
  /** Highest `amountOut` among executable quotes; ties broken by priority. */
  best: Quote | null;
  /** All quotes received (executable or not), sorted best-first. */
  quotes: Quote[];
  errors: { providerId: string; error: unknown }[];
  /** Providers not queried, e.g. because they cannot express the configured fees. */
  skipped: { providerId: string; reason: string }[];
}

export class SwapRouter {
  readonly providers: SwapProvider[];
  readonly priority: string[];
  readonly timeoutMs: number;

  constructor({ providers, priority = [], timeoutMs = 3000 }: SwapRouterOptions) {
    const ids = new Set<string>();
    for (const p of providers) {
      if (ids.has(p.id)) throw new Error(`duplicate swap provider id: ${p.id}`);
      ids.add(p.id);
    }
    this.providers = providers;
    this.priority = priority;
    this.timeoutMs = timeoutMs;
  }

  getProvider(id: string): SwapProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /** Lower rank = preferred on ties. */
  rank(providerId: string): number {
    const i = this.priority.indexOf(providerId);
    if (i >= 0) return i;
    const j = this.providers.findIndex((p) => p.id === providerId);
    return this.priority.length + (j >= 0 ? j : this.providers.length);
  }

  async quoteAll(req: QuoteRequest): Promise<QuoteAllResult> {
    assertValidFees(req.fees);
    const feesZero = totalFeeBps(req.fees) === 0;
    const skipped: QuoteAllResult['skipped'] = [];
    const errors: QuoteAllResult['errors'] = [];

    const enabled = this.providers.filter((p) => {
      if (feesZero) return true;
      let ok = false;
      try {
        ok = p.supportsFees(req.fees);
      } catch (error) {
        errors.push({ providerId: p.id, error });
        return false;
      }
      if (!ok) skipped.push({ providerId: p.id, reason: 'cannot express configured fees' });
      return ok;
    });

    const settled = await Promise.all(enabled.map((p) => this.quoteOne(p, req)));
    const quotes: Quote[] = [];
    settled.forEach((r, i) => {
      const providerId = enabled[i]!.id;
      if (r.ok) {
        if (r.quote) {
          try {
            assertQuoteMatchesRequest(r.quote, req);
            quotes.push(r.quote);
          } catch (error) {
            errors.push({ providerId, error });
          }
        }
      } else {
        errors.push({ providerId, error: r.error });
      }
    });

    quotes.sort((a, b) => this.compare(a, b));
    const best = quotes.find((q) => q.executable) ?? null;
    return { best, quotes, errors, skipped };
  }

  /** Sort comparator: executable first, then higher amountOut, then priority. */
  private compare(a: Quote, b: Quote): number {
    if (a.executable !== b.executable) return a.executable ? -1 : 1;
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    return this.rank(a.providerId) - this.rank(b.providerId);
  }

  private async quoteOne(
    p: SwapProvider,
    req: QuoteRequest,
  ): Promise<{ ok: true; quote: Quote | null } | { ok: false; error: unknown }> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new SwapTimeoutError(p.id, this.timeoutMs);
        ctrl.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      const quote = await Promise.race([Promise.resolve().then(() => p.quote(req, { signal: ctrl.signal })), timeout]);
      return { ok: true, quote };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Throws if a quote does not target the request's own recipient / refund addresses or amount. */
export function assertQuoteMatchesRequest(q: Quote, req: QuoteRequest): void {
  if (!sameAddress(q.recipient, req.recipient)) throw new SwapRecipientMismatch('recipient', req.recipient, q.recipient);
  if (!sameAddress(q.refundTo, req.refundTo)) throw new SwapRecipientMismatch('refundTo', req.refundTo, q.refundTo);
  if (q.amountIn !== req.from.amount) throw new Error(`[${q.providerId}] quote amountIn ${q.amountIn} != requested ${req.from.amount}`);
}

/**
 * Swap-flow guard: after `prepare`, check the provider will pay and refund the
 * account's OWN addresses before proposing the swap intent.
 * EVM hex and bech32 addresses compare case-insensitively.
 */
export function assertOwnAddresses(prepared: PreparedSwap, own: { recipient: string; refundTo: string }): void {
  const q = prepared.quote;
  if (!sameAddress(q.recipient, own.recipient)) throw new SwapRecipientMismatch('recipient', own.recipient, q.recipient);
  if (!sameAddress(q.refundTo, own.refundTo)) throw new SwapRecipientMismatch('refundTo', own.refundTo, q.refundTo);
  if (!sameAddress(q.request.recipient, own.recipient))
    throw new SwapRecipientMismatch('recipient', own.recipient, q.request.recipient);
  if (!sameAddress(q.request.refundTo, own.refundTo))
    throw new SwapRecipientMismatch('refundTo', own.refundTo, q.request.refundTo);
}
