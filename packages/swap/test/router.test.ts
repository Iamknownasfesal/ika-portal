import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SwapRecipientMismatch,
  SwapRouter,
  SwapTimeoutError,
  assertOwnAddresses,
  type FeeConfig,
  type PreparedSwap,
  type Quote,
  type QuoteRequest,
  type SwapProvider,
} from '../src/index.js';

const req = (fees: FeeConfig = { integrator: { recipient: '0xfee', bps: 25 } }): QuoteRequest => ({
  from: { chain: 'bitcoin', asset: 'BTC', amount: 100_000n },
  to: { chain: 'base', asset: 'USDC' },
  recipient: '0xAbCdEf0000000000000000000000000000000001',
  refundTo: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  slippageBps: 50,
  fees,
});

function fake(
  id: string,
  amountOut: bigint | null,
  o: { supportsFees?: boolean; delayMs?: number; never?: boolean; throws?: Error; executable?: boolean; recipient?: string } = {},
): SwapProvider & { calls: number; aborted: boolean } {
  const p = {
    id,
    calls: 0,
    aborted: false,
    supportsFees: () => o.supportsFees ?? true,
    async quote(r: QuoteRequest, opts?: { signal?: AbortSignal }): Promise<Quote | null> {
      p.calls++;
      opts?.signal?.addEventListener('abort', () => (p.aborted = true));
      if (o.never) return new Promise(() => {});
      if (o.delayMs) await new Promise((res) => setTimeout(res, o.delayMs));
      if (o.throws) throw o.throws;
      if (amountOut === null) return null;
      return {
        providerId: id,
        request: r,
        amountIn: r.from.amount,
        amountOut,
        minAmountOut: amountOut,
        fees: { provider: [] },
        recipient: o.recipient ?? r.recipient,
        refundTo: r.refundTo,
        deadline: 0,
        expiresAt: 0,
        executable: o.executable ?? true,
        raw: null,
      };
    },
    prepare: async () => {
      throw new Error('unused');
    },
    status: async () => ({ status: 'pending' as const }),
  };
  return p;
}

afterEach(() => vi.useRealTimers());

describe('SwapRouter', () => {
  it('picks the highest net output', async () => {
    const r = new SwapRouter({ providers: [fake('a', 100n), fake('b', 300n), fake('c', 200n)] });
    const res = await r.quoteAll(req());
    expect(res.best?.providerId).toBe('b');
    expect(res.quotes.map((q) => q.providerId)).toEqual(['b', 'c', 'a']);
    expect(res.errors).toEqual([]);
  });

  it('breaks ties by configured priority', async () => {
    const providers = [fake('a', 300n), fake('b', 300n), fake('c', 300n)];
    expect((await new SwapRouter({ providers, priority: ['c', 'b', 'a'] }).quoteAll(req())).best?.providerId).toBe('c');
    expect((await new SwapRouter({ providers, priority: ['b'] }).quoteAll(req())).best?.providerId).toBe('b');
    // unlisted providers fall back to registration order
    expect((await new SwapRouter({ providers }).quoteAll(req())).best?.providerId).toBe('a');
  });

  it('drops a provider that never resolves after timeoutMs and aborts it (fake timers)', async () => {
    vi.useFakeTimers();
    const slow = fake('slow', 999n, { never: true });
    const r = new SwapRouter({ providers: [slow, fake('fast', 100n)], timeoutMs: 3000 });
    const p = r.quoteAll(req());
    await vi.advanceTimersByTimeAsync(3000);
    const res = await p;
    expect(res.best?.providerId).toBe('fast');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.providerId).toBe('slow');
    expect(res.errors[0]!.error).toBeInstanceOf(SwapTimeoutError);
    expect(slow.aborted).toBe(true);
  });

  it('keeps a provider that answers within the timeout (real timers)', async () => {
    const r = new SwapRouter({ providers: [fake('ok', 5n, { delayMs: 5 }), fake('late', 50n, { delayMs: 200 })], timeoutMs: 50 });
    const res = await r.quoteAll(req());
    expect(res.best?.providerId).toBe('ok');
    expect(res.errors.map((e) => e.providerId)).toEqual(['late']);
  });

  it('records a throwing provider in errors', async () => {
    const boom = new Error('boom');
    const res = await new SwapRouter({ providers: [fake('x', null, { throws: boom }), fake('y', 1n)] }).quoteAll(req());
    expect(res.best?.providerId).toBe('y');
    expect(res.errors).toEqual([{ providerId: 'x', error: boom }]);
  });

  it('treats null as unsupported route (no error)', async () => {
    const res = await new SwapRouter({ providers: [fake('x', null)] }).quoteAll(req());
    expect(res).toMatchObject({ best: null, quotes: [], errors: [] });
  });

  it('skips a fee-incapable provider when fees > 0, uses it when fees are zero', async () => {
    const incapable = fake('cheap', 1000n, { supportsFees: false });
    const r = new SwapRouter({ providers: [incapable, fake('capable', 10n)] });
    const withFees = await r.quoteAll(req());
    expect(withFees.best?.providerId).toBe('capable');
    expect(withFees.skipped).toEqual([{ providerId: 'cheap', reason: 'cannot express configured fees' }]);
    expect(incapable.calls).toBe(0);

    const zero = await r.quoteAll(req({ integrator: { recipient: '0xfee', bps: 0 }, ika: { recipient: 'ika', bps: 0 } }));
    expect(zero.best?.providerId).toBe('cheap');
    expect(incapable.calls).toBe(1);
  });

  it('never picks a non-executable quote as best, but still returns it', async () => {
    const r = new SwapRouter({ providers: [fake('lifi', 10_000n, { executable: false }), fake('near', 10n)] });
    const res = await r.quoteAll(req());
    expect(res.best?.providerId).toBe('near');
    expect(res.quotes.map((q) => q.providerId)).toContain('lifi');

    const only = await new SwapRouter({ providers: [fake('lifi', 10_000n, { executable: false })] }).quoteAll(req());
    expect(only.best).toBeNull();
    expect(only.quotes).toHaveLength(1);
  });

  it('rejects quotes that pay someone else', async () => {
    const res = await new SwapRouter({
      providers: [fake('evil', 10_000n, { recipient: '0x0000000000000000000000000000000000000bad' }), fake('good', 1n)],
    }).quoteAll(req());
    expect(res.best?.providerId).toBe('good');
    expect(res.errors[0]!.error).toBeInstanceOf(SwapRecipientMismatch);
  });

  it('rejects invalid fee config', async () => {
    await expect(new SwapRouter({ providers: [] }).quoteAll(req({ integrator: { recipient: 'x', bps: 10_000 } }))).rejects.toThrow();
  });
});

describe('assertOwnAddresses', () => {
  const r = req();
  const q = { request: r, recipient: r.recipient.toLowerCase(), refundTo: r.refundTo.toUpperCase() } as unknown as Quote;
  const p = { quote: q } as PreparedSwap;

  it('accepts own addresses (EVM + bech32 case-insensitive)', () => {
    expect(() => assertOwnAddresses(p, { recipient: r.recipient, refundTo: r.refundTo })).not.toThrow();
  });

  it('throws SwapRecipientMismatch on a different recipient or refund address', () => {
    expect(() => assertOwnAddresses(p, { recipient: '0xAbCdEf0000000000000000000000000000000002', refundTo: r.refundTo })).toThrow(
      SwapRecipientMismatch,
    );
    expect(() => assertOwnAddresses(p, { recipient: r.recipient, refundTo: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' })).toThrow(
      SwapRecipientMismatch,
    );
  });

  it('is case-sensitive for base58', () => {
    const q2 = { ...q, recipient: 'AbC', request: { ...r, recipient: 'AbC' } } as Quote;
    expect(() => assertOwnAddresses({ quote: q2 } as PreparedSwap, { recipient: 'abc', refundTo: r.refundTo })).toThrow(SwapRecipientMismatch);
  });
});
