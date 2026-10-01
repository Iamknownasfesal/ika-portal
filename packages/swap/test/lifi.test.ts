/**
 * LifiProvider against RECORDED li.quest /v1/quote responses (mainnet, 2026-09-30):
 *   lifi/eth-base-usdc.json      ETH -> Base USDC: calldata to the LI.FI Diamond
 *   lifi/baseusdc-ethusdc.json   Base USDC -> ETH USDC: approval + calldata
 *   lifi/btc-base-usdc.json      BTC -> Base USDC: PSBT with OP_RETURN memo (via NEAR)
 * All three are non-executable for the Ika policy (plain transfers only).
 */
import { describe, expect, it } from 'vitest';
import { LifiProvider, SwapNotExecutable, SwapRouter, mapLifiStatus, type QuoteRequest } from '../src/index.js';
import { EVM_ADDR, fixture, replayFetch } from './helpers.js';

const NO_FEES = { integrator: { recipient: EVM_ADDR, bps: 0 } };
const ethReq: QuoteRequest = {
  from: { chain: 'ethereum', asset: 'ETH', amount: 10n ** 16n },
  to: { chain: 'base', asset: 'USDC' },
  recipient: EVM_ADDR,
  refundTo: EVM_ADDR,
  slippageBps: 100,
  fees: NO_FEES,
};

function provider(routes: Parameters<typeof replayFetch>[0], feeWallet?: string) {
  const r = replayFetch(routes);
  return { p: new LifiProvider({ integrator: 'ika-portal', fetch: r.fetch, now: () => 1_790_000_000, ...(feeWallet ? { feeWallet } : {}) }), calls: r.calls };
}

describe('LifiProvider', () => {
  it('builds GET /v1/quote params (amount as decimal string, slippage and fee as fractions)', async () => {
    const { p, calls } = provider({ 'GET /v1/quote': { body: fixture('lifi/eth-base-usdc.json') } }, EVM_ADDR);
    await p.quote({ ...ethReq, fees: { integrator: { recipient: EVM_ADDR, bps: 30 } } });
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://li.quest/v1/quote');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      fromChain: '1',
      toChain: '8453',
      fromToken: '0x0000000000000000000000000000000000000000',
      toToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      fromAmount: '10000000000000000',
      fromAddress: EVM_ADDR,
      toAddress: EVM_ADDR,
      slippage: '0.01',
      integrator: 'ika-portal',
      fee: '0.003',
    });
  });

  it('supportsFees only with a portal-configured fee wallet and a single integrator fee', () => {
    const none = new LifiProvider({ integrator: 'x', fetch: async () => new Response() });
    expect(none.supportsFees(NO_FEES)).toBe(true);
    expect(none.supportsFees({ integrator: { recipient: EVM_ADDR, bps: 30 } })).toBe(false);
    const cfg = new LifiProvider({ integrator: 'x', feeWallet: EVM_ADDR.toLowerCase(), fetch: async () => new Response() });
    expect(cfg.supportsFees({ integrator: { recipient: EVM_ADDR, bps: 30 } })).toBe(true);
    expect(cfg.supportsFees({ integrator: { recipient: EVM_ADDR, bps: 30 }, ika: { recipient: EVM_ADDR, bps: 5 } })).toBe(false);
    expect(cfg.supportsFees({ integrator: { recipient: '0x1111111111111111111111111111111111111111', bps: 30 } })).toBe(false);
  });

  it('recorded ETH quote: contract calldata -> executable=false, shown but never best', async () => {
    const { p } = provider({ 'GET /v1/quote': { body: fixture('lifi/eth-base-usdc.json') } });
    const q = (await p.quote(ethReq))!;
    expect(q).toMatchObject({ executable: false, amountOut: 26_563_803n, minAmountOut: 26_298_165n, recipient: EVM_ADDR, refundTo: EVM_ADDR });
    expect(q.nonExecutableReason).toMatch(/calldata/);
    expect(q.fees.provider.find((f) => f.name === 'LIFI Fixed Fee')?.amount).toBe(25_000_000_000_000n);
    await expect(p.prepare(q)).rejects.toBeInstanceOf(SwapNotExecutable);
    const res = await new SwapRouter({ providers: [p] }).quoteAll(ethReq);
    expect(res.best).toBeNull();
    expect(res.quotes[0]!.providerId).toBe('lifi');
  });

  it('recorded ERC-20 quote: approval + calldata -> executable=false', async () => {
    const { p } = provider({ 'GET /v1/quote': { body: fixture('lifi/baseusdc-ethusdc.json') } });
    const q = (await p.quote({ ...ethReq, from: { chain: 'base', asset: 'USDC', amount: 100_000_000n }, to: { chain: 'ethereum', asset: 'USDC' } }))!;
    expect(q.executable).toBe(false);
    expect(q.nonExecutableReason).toMatch(/approval/);
  });

  it('recorded BTC quote: PSBT with memo -> executable=false', async () => {
    const f = fixture('lifi/btc-base-usdc.json');
    const { p } = provider({ 'GET /v1/quote': { body: f } });
    const q = (await p.quote({
      from: { chain: 'bitcoin', asset: 'BTC', amount: 100_000n },
      to: { chain: 'base', asset: 'USDC' },
      recipient: EVM_ADDR,
      refundTo: f.action.fromAddress,
      slippageBps: 100,
      fees: NO_FEES,
    }))!;
    expect(q.executable).toBe(false);
    expect(q.nonExecutableReason).toMatch(/PSBT/);
    expect(q.amountOut).toBe(83_315_047n);
  });

  it('a (hypothetical) plain native transfer route would be executable', async () => {
    const f = fixture('lifi/eth-base-usdc.json');
    f.transactionRequest = { to: '0x00000000000000000000000000000000000000d1', data: '0x', value: '0x2386f26fc10000' };
    const { p } = provider({ 'GET /v1/quote': { body: f } });
    const q = (await p.quote(ethReq))!;
    expect(q.executable).toBe(true);
    expect((await p.prepare(q)).depositAddress).toBe('0x00000000000000000000000000000000000000d1');
  });

  it('maps LI.FI statuses', () => {
    expect(mapLifiStatus({ status: 'PENDING' }).status).toBe('pending');
    expect(mapLifiStatus({ status: 'NOT_FOUND' }).status).toBe('pending');
    expect(mapLifiStatus({ status: 'DONE', substatus: 'COMPLETED', receiving: { txHash: '0xd', amount: '5' } })).toMatchObject({
      status: 'success',
      destinationTxHash: '0xd',
      amountOut: 5n,
    });
    expect(mapLifiStatus({ status: 'DONE', substatus: 'REFUNDED', receiving: { txHash: '0xr' } })).toMatchObject({ status: 'refunded', refundTxHash: '0xr' });
    expect(mapLifiStatus({ status: 'FAILED' }).status).toBe('failed');
  });
});
