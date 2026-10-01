import { describe, expect, it, vi } from 'vitest';
import { MockSwapProvider, SwapRouter, assertOwnAddresses, type QuoteRequest } from '../src/index.js';

const RECIPIENT = '0x2527D02599Ba641c19FEa793cD0F167589a0f10D';
const REFUND = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const DEPOSIT_BTC = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

function btcReq(over: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    from: { chain: 'bitcoin', asset: 'BTC', amount: 100_000n }, // 0.001 BTC
    to: { chain: 'base', asset: 'USDC' },
    recipient: RECIPIENT,
    refundTo: REFUND,
    slippageBps: 100,
    fees: { integrator: { recipient: '0xfee0000000000000000000000000000000000001', bps: 30 }, ika: { recipient: '0x1ka0000000000000000000000000000000000001', bps: 10 } },
    ...over,
  };
}

function mock(payout = vi.fn(async () => '0xdesttx'), over: Partial<ConstructorParameters<typeof MockSwapProvider>[0]> = {}) {
  return new MockSwapProvider({
    rates: { 'BTC/USDC': '60000', 'ETH/USDC': '2670.5' },
    payout,
    depositAddresses: { bitcoin: DEPOSIT_BTC, ethereum: '0x00000000000000000000000000000000000000d1' },
    now: () => 1_000_000,
    ...over,
  });
}

describe('MockSwapProvider output math', () => {
  it('BTC -> USDC: decimals-aware rate, integrator + ika fees applied to output', async () => {
    const q = (await mock().quote(btcReq()))!;
    // gross = 0.001 BTC * 60000 = 60 USDC = 60_000_000; fees 30 + 10 bps of output
    expect(q.amountOut).toBe(60_000_000n - 180_000n - 60_000n);
    expect(q.fees.integrator).toEqual({ recipient: '0xfee0000000000000000000000000000000000001', bps: 30, amount: 180_000n, side: 'output' });
    expect(q.fees.ika?.amount).toBe(60_000n);
    expect(q.minAmountOut).toBe((59_760_000n * 9_900n) / 10_000n);
    expect(q.amountIn).toBe(100_000n);
    expect(q.executable).toBe(true);
  });

  it('ETH -> USDC with a fractional rate and no fees', async () => {
    const q = (await mock().quote(
      btcReq({ from: { chain: 'ethereum', asset: 'ETH', amount: 10n ** 16n }, refundTo: RECIPIENT, fees: { integrator: { recipient: 'x', bps: 0 } } }),
    ))!;
    expect(q.amountOut).toBe(26_705_000n); // 0.01 * 2670.5 USDC
    expect(q.fees.integrator).toBeUndefined();
  });

  it('derives the inverse pair (USDC -> BTC)', () => {
    expect(mock().grossOut('USDC', 'BTC', 60_000_000n)).toBe(100_000n);
    expect(mock().grossOut('USDC', 'ETH', 2_670_500_000n)).toBe(10n ** 18n);
  });

  it('returns null for unknown pairs or missing deposit address', async () => {
    const m = mock(undefined, { rates: { 'BTC/USDC': 60000 } });
    expect(await m.quote(btcReq({ to: { chain: 'base', asset: 'ETH' } }))).toBeNull();
    expect(await m.quote(btcReq({ from: { chain: 'base', asset: 'USDC', amount: 1n } }))).toBeNull();
  });
});

describe('MockSwapProvider flow', () => {
  it('routes to the best mock quote, applies integrator fees and delivers to the account own address', async () => {
    const payout = vi.fn(async () => '0xpayouttx');
    const good = mock(payout, { id: 'mock-good', rates: { 'BTC/USDC': '60000' } });
    const worse = mock(vi.fn(), { id: 'mock-worse', rates: { 'BTC/USDC': '59000' } });
    const router = new SwapRouter({ providers: [worse, good] });
    const { best } = await router.quoteAll(btcReq());
    expect(best?.providerId).toBe('mock-good');

    const prepared = await good.prepare(best!);
    expect(prepared).toMatchObject({ depositAddress: DEPOSIT_BTC, amount: 100_000n, deadline: 1_000_000 + 3600 });
    assertOwnAddresses(prepared, { recipient: RECIPIENT, refundTo: REFUND });
    expect((await good.status(prepared)).status).toBe('pending');

    await good.submitDeposit(prepared, 'btc-deposit-txid');
    expect(payout).toHaveBeenCalledWith({ chain: 'base', asset: 'USDC', to: RECIPIENT, amount: 59_760_000n, depositTxHash: 'btc-deposit-txid' });
    expect(await good.status(prepared)).toMatchObject({ status: 'success', destinationTxHash: '0xpayouttx', originTxHash: 'btc-deposit-txid', amountOut: 59_760_000n });

    await good.submitDeposit(prepared, 'btc-deposit-txid'); // idempotent
    expect(payout).toHaveBeenCalledTimes(1);
  });

  it('records failed when payout throws', async () => {
    const m = mock(vi.fn(async () => {
      throw new Error('faucet empty');
    }));
    const p = await m.prepare((await m.quote(btcReq()))!);
    await m.submitDeposit(p, 'tx');
    expect(await m.status(p)).toMatchObject({ status: 'failed', reason: 'faucet empty' });
  });

  it('respects feeSupport', () => {
    expect(mock(undefined, { feeSupport: false }).supportsFees(btcReq().fees)).toBe(false);
    expect(mock().supportsFees(btcReq().fees)).toBe(true);
  });
});
