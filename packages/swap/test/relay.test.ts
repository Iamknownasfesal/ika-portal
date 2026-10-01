/**
 * RelayProvider against RECORDED api.relay.link /quote/v2 responses (mainnet, 2026-09-30):
 *   relay/btc-base-usdc.json          BTC -> Base USDC, useDepositAddress, 30 bps app fee
 *   relay/btc-base-usdc-2fees.json    same with two app fees (30 + 10 bps), ttl, refundOnOrigin
 *   relay/eth-base-usdc.json          ETH (mainnet) -> Base USDC, useDepositAddress
 *   relay/baseusdc-btc.json           Base USDC -> BTC, useDepositAddress (ERC-20 transfer deposit)
 *   relay/eth-base-usdc-nodeposit.json  normal (calldata) flow -> must be non-executable
 *   relay/status-waiting.json         GET /intents/status/v3 for the BTC request
 * `*.handcrafted.json` are built from the OpenAPI schema/example.
 */
import { describe, expect, it } from 'vitest';
import {
  RelayProvider,
  SwapNotExecutable,
  SwapRouter,
  assertOwnAddresses,
  mapRelayStatus,
  type QuoteRequest,
} from '../src/index.js';
import { BTC_ADDR_RELAY, EVM_ADDR, fixture, replayFetch } from './helpers.js';

const NOW = 1_790_799_230;
const FEES = { integrator: { recipient: EVM_ADDR, bps: 30 } };

function provider(routes: Parameters<typeof replayFetch>[0]) {
  const r = replayFetch(routes);
  return { p: new RelayProvider({ fetch: r.fetch, now: () => NOW }), calls: r.calls };
}

const btcReq: QuoteRequest = {
  from: { chain: 'bitcoin', asset: 'BTC', amount: 100_000n },
  to: { chain: 'base', asset: 'USDC' },
  recipient: EVM_ADDR,
  refundTo: BTC_ADDR_RELAY,
  slippageBps: 100,
  fees: FEES,
};
const ethReq: QuoteRequest = {
  from: { chain: 'ethereum', asset: 'ETH', amount: 10n ** 16n },
  to: { chain: 'base', asset: 'USDC' },
  recipient: EVM_ADDR,
  refundTo: EVM_ADDR,
  slippageBps: 100,
  fees: FEES,
};
const usdcReq: QuoteRequest = {
  from: { chain: 'base', asset: 'USDC', amount: 100_000_000n },
  to: { chain: 'bitcoin', asset: 'BTC' },
  recipient: BTC_ADDR_RELAY,
  refundTo: EVM_ADDR,
  slippageBps: 100,
  fees: FEES,
};

describe('RelayProvider request', () => {
  it('sends a deposit-address quote with refundTo and appFees (bps as strings)', async () => {
    const { p, calls } = provider({ 'POST /quote/v2': { body: fixture('relay/btc-base-usdc-2fees.json') } });
    await p.quote({ ...btcReq, fees: { integrator: { recipient: EVM_ADDR, bps: 30 }, ika: { recipient: '0x1111111111111111111111111111111111111111', bps: 10 } } });
    expect(calls[0]!.url).toBe('https://api.relay.link/quote/v2');
    expect(calls[0]!.body).toEqual({
      user: BTC_ADDR_RELAY,
      recipient: EVM_ADDR,
      originChainId: 8253038,
      destinationChainId: 8453,
      originCurrency: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8',
      destinationCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amount: '100000',
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
      refundTo: BTC_ADDR_RELAY,
      refundOnOrigin: true,
      slippageTolerance: '100',
      ttl: 7200,
      appFees: [
        { recipient: EVM_ADDR, fee: '30' },
        { recipient: '0x1111111111111111111111111111111111111111', fee: '10' },
      ],
    });
  });

  it('supports only EVM fee recipients', () => {
    const p = new RelayProvider({ fetch: async () => new Response() });
    expect(p.supportsFees(FEES)).toBe(true);
    expect(p.supportsFees({ integrator: { recipient: 'ika.near', bps: 10 } })).toBe(false);
    expect(p.supportsFees({ integrator: { recipient: 'ika.near', bps: 0 } })).toBe(true);
  });
});

describe('RelayProvider recorded quotes', () => {
  it('BTC origin: plain transfer to a deposit address', async () => {
    const { p } = provider({ 'POST /quote/v2': { body: fixture('relay/btc-base-usdc.json') } });
    const q = (await p.quote(btcReq))!;
    expect(q.executable).toBe(true);
    expect(q.amountIn).toBe(100_000n);
    expect(q.amountOut).toBe(80_962_210n);
    expect(q.minAmountOut).toBe(80_152_588n);
    expect(q.recipient).toBe(EVM_ADDR);
    expect(q.refundTo).toBe(BTC_ADDR_RELAY);
    expect(q.fees.integrator).toEqual({ recipient: EVM_ADDR, bps: 30, amount: 300n, side: 'input' });
    const prepared = await p.prepare(q);
    expect(prepared).toMatchObject({
      depositAddress: 'bc1q8pklmz5vcnnuuzz009pva4z8tnvguzjsq0eqfm',
      amount: 100_000n,
      providerRef: '0x179079923092eafee8b6d186a1f60e91bafccc5e7325f9b254c8b34d308c5f96',
    });
    expect(prepared.tokenAddress).toBeUndefined();
    assertOwnAddresses(prepared, { recipient: EVM_ADDR, refundTo: BTC_ADDR_RELAY });
  });

  it('native ETH origin: value transfer with empty calldata', async () => {
    const { p } = provider({ 'POST /quote/v2': { body: fixture('relay/eth-base-usdc.json') } });
    const q = (await p.quote(ethReq))!;
    expect(q.executable).toBe(true);
    expect(q.amountOut).toBe(25_704_529n);
    const prepared = await p.prepare(q);
    expect(prepared.depositAddress).toBe('0xc47a8c58f151f0d5dcf753a68f10943eba5eb122');
    expect(prepared.amount).toBe(10n ** 16n);
  });

  it('ERC-20 origin: plain transfer(depositAddress, amount) on the USDC contract', async () => {
    const { p } = provider({ 'POST /quote/v2': { body: fixture('relay/baseusdc-btc.json') } });
    const q = (await p.quote(usdcReq))!;
    expect(q.executable).toBe(true);
    const prepared = await p.prepare(q);
    expect(prepared.depositAddress).toBe('0x8041e5c41e1dbef0ef6b77041bf6c854d02e1945');
    expect(prepared.tokenAddress).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(prepared.amount).toBe(100_000_000n);
  });

  it('calldata flow (no deposit address) is non-executable and never best', async () => {
    const { p } = provider({ 'POST /quote/v2': { body: fixture('relay/eth-base-usdc-nodeposit.json') } });
    const q = (await p.quote({ ...ethReq, fees: { integrator: { recipient: EVM_ADDR, bps: 0 } } }))!;
    expect(q.executable).toBe(false);
    expect(q.nonExecutableReason).toMatch(/deposit address/);
    await expect(p.prepare(q)).rejects.toBeInstanceOf(SwapNotExecutable);
    const res = await new SwapRouter({ providers: [p] }).quoteAll({ ...ethReq, fees: { integrator: { recipient: EVM_ADDR, bps: 0 } } });
    expect(res.best).toBeNull();
    expect(res.quotes).toHaveLength(1);
  });

  it('flags tampered deposits (amount mismatch / extra calldata) as non-executable', async () => {
    const f = fixture('relay/eth-base-usdc.json');
    f.steps[0].items[0].data.data = '0xdeadbeef';
    const { p } = provider({ 'POST /quote/v2': { body: f } });
    expect((await p.quote(ethReq))!.executable).toBe(false);

    const g = fixture('relay/baseusdc-btc.json');
    g.steps[0].items[0].data.data = g.steps[0].items[0].data.data.slice(0, -2) + '01';
    const { p: p2 } = provider({ 'POST /quote/v2': { body: g } });
    expect((await p2.quote(usdcReq))!.executable).toBe(false);
  });

  it('re-quotes in prepare() when the quote expired', async () => {
    let n = 0;
    const r = replayFetch({ 'POST /quote/v2': () => (n++, { body: fixture('relay/btc-base-usdc.json') }) });
    let now = NOW;
    const p = new RelayProvider({ fetch: r.fetch, now: () => now });
    const q = (await p.quote(btcReq))!;
    now += 31;
    await p.prepare(q);
    expect(n).toBe(2);
  });

  it('submitDeposit indexes the tx; status maps recorded + handcrafted responses', async () => {
    const { p, calls } = provider({
      'POST /quote/v2': { body: fixture('relay/btc-base-usdc.json') },
      'POST /transactions/index': { body: { message: 'Success' } },
      'GET /intents/status/v3': { body: fixture('relay/status-waiting.json') },
    });
    const prepared = await p.prepare((await p.quote(btcReq))!);
    await p.submitDeposit(prepared, 'ff'.repeat(32));
    expect(calls.at(-1)!.body).toEqual({ chainId: '8253038', txHash: 'ff'.repeat(32), requestId: prepared.providerRef });
    expect(await p.status(prepared)).toMatchObject({ status: 'pending', providerStatus: 'waiting' });
    expect(calls.at(-1)!.url).toContain(`requestId=${prepared.providerRef}`);

    expect(mapRelayStatus(fixture('relay/status-success.handcrafted.json'))).toMatchObject({
      status: 'success',
      destinationTxHash: '0x' + 'bb'.repeat(32),
      originTxHash: 'aa'.repeat(32),
    });
    expect(mapRelayStatus(fixture('relay/status-refund.handcrafted.json'))).toMatchObject({
      status: 'refunded',
      refundTxHash: 'cc'.repeat(32),
      reason: 'DEPOSITED_AMOUNT_TOO_LOW_TO_FILL',
    });
    for (const [s, ours] of [['depositing', 'pending'], ['pending', 'pending'], ['submitted', 'pending'], ['failure', 'failed']] as const) {
      expect(mapRelayStatus({ status: s }).status).toBe(ours);
    }
  });
});
