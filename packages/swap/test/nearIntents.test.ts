/**
 * NearIntentsProvider against RECORDED 1Click responses (mainnet, 2026-09-30, no JWT):
 *   fixtures/near/tokens.json                   GET  /v0/tokens
 *   fixtures/near/quote-dry-btc-base-usdc.json  POST /v0/quote dry:true   (0.001 BTC -> USDC on Base)
 *   fixtures/near/quote-nondry-btc-base-usdc.json POST /v0/quote dry:false (deposit address; no funds sent)
 *   fixtures/near/status-pending-deposit.json   GET  /v0/status for that deposit address
 * `*.handcrafted.json` status fixtures are derived from the recorded one per the OpenAPI schema.
 */
import { describe, expect, it } from 'vitest';
import {
  NEAR_INTENTS_ASSET_IDS,
  NearIntentsProvider,
  SwapQuoteDegraded,
  SwapRouter,
  assertOwnAddresses,
  mapNearStatus,
  toIntentsAccountId,
  UnsupportedFeeRecipient,
  type NearStatus,
} from '../src/index.js';
import { BTC_ADDR_NEAR, EVM_ADDR, btcToBaseUsdc, fixture, replayFetch } from './helpers.js';

const NOW = Date.parse('2026-09-30T20:13:05Z') / 1000;
const BASE = 'https://wallet.example/api/1click';

function provider(routes: Parameters<typeof replayFetch>[0]) {
  const r = replayFetch(routes);
  const p = new NearIntentsProvider({ baseUrl: BASE, fetch: r.fetch, now: () => NOW, headers: { 'x-wallet-session': 's1' } });
  return { p, calls: r.calls };
}

describe('asset id table', () => {
  it('matches the recorded GET /v0/tokens response', () => {
    const tokens = fixture<{ assetId: string; blockchain: string; symbol: string; decimals: number }[]>('near/tokens.json');
    const find = (blockchain: string, symbol: string) => tokens.find((t) => t.blockchain === blockchain && t.symbol === symbol);
    expect(NEAR_INTENTS_ASSET_IDS['bitcoin:BTC']).toBe(find('btc', 'BTC')!.assetId);
    expect(NEAR_INTENTS_ASSET_IDS['ethereum:ETH']).toBe(find('eth', 'ETH')!.assetId);
    expect(NEAR_INTENTS_ASSET_IDS['ethereum:USDC']).toBe(find('eth', 'USDC')!.assetId);
    expect(NEAR_INTENTS_ASSET_IDS['base:ETH']).toBe(find('base', 'ETH')!.assetId);
    expect(NEAR_INTENTS_ASSET_IDS['base:USDC']).toBe(find('base', 'USDC')!.assetId);
    expect(find('btc', 'BTC')!.decimals).toBe(8);
    expect(find('base', 'USDC')!.decimals).toBe(6);
  });

  it('is overridable via assetIds', () => {
    const p = new NearIntentsProvider({ baseUrl: BASE, fetch: async () => new Response(), assetIds: { 'bitcoin:BTC': '1cs_v1:btc:native:coin' } });
    expect(p.buildQuoteBody(btcToBaseUsdc(), true)!.originAsset).toBe('1cs_v1:btc:native:coin');
  });
});

describe('request body / fee mapping', () => {
  it('builds the 1Click quote body with appFees, types, decimal-string amount and ISO deadline', async () => {
    const { p, calls } = provider({ 'POST /api/1click/v0/quote': { body: fixture('near/quote-dry-btc-base-usdc.json') } });
    await p.quote(
      btcToBaseUsdc({ fees: { integrator: { recipient: 'ika-integrator.near', bps: 30 }, ika: { recipient: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D', bps: 10 } } }),
    );
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(`${BASE}/v0/quote`);
    expect(c.headers['x-wallet-session']).toBe('s1');
    expect(c.headers.authorization).toBeUndefined(); // never a JWT in the client
    expect(c.body).toEqual({
      dry: true,
      swapType: 'EXACT_INPUT',
      depositMode: 'SIMPLE',
      slippageTolerance: 100,
      originAsset: 'nep141:btc.omft.near',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      amount: '100000',
      refundTo: BTC_ADDR_NEAR,
      refundType: 'ORIGIN_CHAIN',
      recipient: EVM_ADDR,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date((NOW + 7200) * 1000).toISOString(), // 2h default for Bitcoin origin
      appFees: [
        { recipient: 'ika-integrator.near', fee: 30 },
        { recipient: '0x2527d02599ba641c19fea793cd0f167589a0f10d', fee: 10 }, // EVM -> Intents implicit account
      ],
    });
  });

  it('omits appFees when all fees are zero and serializes big amounts exactly', () => {
    const p = new NearIntentsProvider({ baseUrl: BASE, fetch: async () => new Response() });
    const b = p.buildQuoteBody(
      btcToBaseUsdc({ from: { chain: 'ethereum', asset: 'ETH', amount: 123456789012345678901n }, fees: { integrator: { recipient: 'a.near', bps: 0 } } }),
      false,
    )!;
    expect(b.appFees).toBeUndefined();
    expect(b.amount).toBe('123456789012345678901');
    expect(b.dry).toBe(false);
  });

  it('maps fee recipients to NEAR Intents account ids and rejects the rest', () => {
    expect(toIntentsAccountId('ika.near')).toBe('ika.near');
    expect(toIntentsAccountId('0xAbCdEf0000000000000000000000000000000001')).toBe('0xabcdef0000000000000000000000000000000001');
    expect(toIntentsAccountId('5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd')).toBe(
      '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
    );
    // Solana pubkey -> NEAR implicit (hex) account
    expect(toIntentsAccountId('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(
      '06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9',
    );
    expect(() => toIntentsAccountId('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toThrow(UnsupportedFeeRecipient); // legacy BTC
    expect(() => toIntentsAccountId(BTC_ADDR_NEAR)).toThrow(UnsupportedFeeRecipient);
    expect(() => toIntentsAccountId('Bad..Name')).toThrow(UnsupportedFeeRecipient);
    const p = new NearIntentsProvider({ baseUrl: BASE, fetch: async () => new Response() });
    expect(p.supportsFees({ integrator: { recipient: 'ika.near', bps: 20 } })).toBe(true);
    expect(p.supportsFees({ integrator: { recipient: BTC_ADDR_NEAR, bps: 20 } })).toBe(false);
    // zero-bps entries are not sent, so they don't need to be valid
    expect(p.supportsFees({ integrator: { recipient: BTC_ADDR_NEAR, bps: 0 } })).toBe(true);
  });

  it('returns null for routes without asset ids', async () => {
    const { p, calls } = provider({});
    expect(await p.quote(btcToBaseUsdc({ to: { chain: 'bitcoin', asset: 'USDC' } }))).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('recorded 1Click responses', () => {
  it('parses a recorded dry quote', async () => {
    const { p } = provider({ 'POST /api/1click/v0/quote': { body: fixture('near/quote-dry-btc-base-usdc.json') } });
    const q = (await p.quote(btcToBaseUsdc()))!;
    expect(q.providerId).toBe('near-intents');
    expect(q.amountIn).toBe(100_000n);
    expect(q.amountOut).toBe(83_284_843n);
    expect(q.minAmountOut).toBe(82_451_994n);
    expect(q.recipient).toBe(EVM_ADDR);
    expect(q.refundTo).toBe(BTC_ADDR_NEAR);
    expect(q.executable).toBe(true);
    expect(q.estimatedTimeSec).toBe(807);
    expect(q.deadline).toBe(Date.parse('2026-09-30T21:13:05Z') / 1000);
    // Keyless 1Click echoed our 30 bps as 15 bps and added its own 20 bps fee.
    expect(q.fees.integrator).toEqual({ recipient: 'ika-integrator.near', bps: 15, amount: 150n, side: 'input' });
    expect(q.fees.provider).toContainEqual({ name: 'withdrawFee', amount: 2400n, side: 'output' });
    expect(q.fees.provider).toContainEqual({
      name: 'appFee:5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
      amount: 200n,
      side: 'input',
      bps: 20,
    });
  });

  it('prepare() uses dry:false and returns the recorded deposit address', async () => {
    const { p, calls } = provider({
      'POST /api/1click/v0/quote': (c) => ({
        body: fixture(c.body.dry ? 'near/quote-dry-btc-base-usdc.json' : 'near/quote-nondry-btc-base-usdc.json'),
      }),
    });
    const q = (await p.quote(btcToBaseUsdc()))!;
    const prepared = await p.prepare(q);
    expect(calls.map((c) => c.body.dry)).toEqual([true, false]);
    expect(prepared.depositAddress).toBe('bc1q5dspp2mj2f0gd2an0n23hwrnr6uhtjd5ajehns');
    expect(prepared.depositMemo).toBeUndefined();
    expect(prepared.amount).toBe(100_000n);
    expect(prepared.tokenAddress).toBeUndefined();
    expect(prepared.providerRef).toBe(prepared.depositAddress);
    // min(request deadline, deposit-address deadline (+3 days))
    expect(prepared.deadline).toBe(Date.parse('2026-09-30T21:13:05Z') / 1000);
    expect(prepared.quote.amountOut).toBe(83_284_843n);
    assertOwnAddresses(prepared, { recipient: EVM_ADDR.toLowerCase(), refundTo: BTC_ADDR_NEAR });
  });

  it('prepare() rejects memos and degraded quotes', async () => {
    const nondry = fixture('near/quote-nondry-btc-base-usdc.json');
    const memo = structuredClone(nondry);
    memo.quote.depositMemo = '123';
    const { p } = provider({ 'POST /api/1click/v0/quote': (c) => ({ body: c.body.dry ? fixture('near/quote-dry-btc-base-usdc.json') : memo }) });
    await expect(p.prepare((await p.quote(btcToBaseUsdc()))!)).rejects.toThrow(/memo/);

    const worse = structuredClone(nondry);
    worse.quote.amountOut = '80000000';
    const { p: p2 } = provider({ 'POST /api/1click/v0/quote': (c) => ({ body: c.body.dry ? fixture('near/quote-dry-btc-base-usdc.json') : worse }) });
    await expect(p2.prepare((await p2.quote(btcToBaseUsdc()))!)).rejects.toBeInstanceOf(SwapQuoteDegraded);
  });

  it('submitDeposit posts txHash + depositAddress; status parses the recorded PENDING_DEPOSIT', async () => {
    const { p, calls } = provider({
      'POST /api/1click/v0/quote': (c) => ({ body: fixture(c.body.dry ? 'near/quote-dry-btc-base-usdc.json' : 'near/quote-nondry-btc-base-usdc.json') }),
      'POST /api/1click/v0/deposit/submit': { body: fixture('near/status-pending-deposit.json') },
      'GET /api/1click/v0/status': { body: fixture('near/status-pending-deposit.json') },
    });
    const prepared = await p.prepare((await p.quote(btcToBaseUsdc()))!);
    await p.submitDeposit(prepared, 'abcd');
    expect(calls.at(-1)!.body).toEqual({ txHash: 'abcd', depositAddress: 'bc1q5dspp2mj2f0gd2an0n23hwrnr6uhtjd5ajehns' });
    const s = await p.status(prepared);
    expect(calls.at(-1)!.url).toBe(`${BASE}/v0/status?depositAddress=bc1q5dspp2mj2f0gd2an0n23hwrnr6uhtjd5ajehns`);
    expect(s).toMatchObject({ status: 'pending', providerStatus: 'PENDING_DEPOSIT' });
  });

  it('surfaces 1Click 400 errors (recorded message) to the router', async () => {
    const { p } = provider({
      'POST /api/1click/v0/quote': { status: 400, body: { message: 'Amount is too low for bridge, try at least 8300' } },
    });
    const res = await new SwapRouter({ providers: [p] }).quoteAll(btcToBaseUsdc({ from: { chain: 'bitcoin', asset: 'BTC', amount: 1000n } }));
    expect(res.best).toBeNull();
    expect(String(res.errors[0]!.error)).toMatch(/Amount is too low/);
  });
});

describe('status mapping', () => {
  it.each<[NearStatus, string]>([
    ['PENDING_DEPOSIT', 'pending'],
    ['KNOWN_DEPOSIT_TX', 'pending'],
    ['PROCESSING', 'pending'],
    ['SUCCESS', 'success'],
    ['REFUNDED', 'refunded'],
    ['FAILED', 'failed'],
    ['INCOMPLETE_DEPOSIT', 'failed'],
  ])('%s -> %s', (near, ours) => {
    const res = { ...fixture('near/status-pending-deposit.json'), status: near };
    expect(mapNearStatus(res).status).toBe(ours);
  });

  it('extracts destination tx hash and amount on SUCCESS', () => {
    const s = mapNearStatus(fixture('near/status-success.handcrafted.json'));
    expect(s).toMatchObject({ status: 'success', destinationTxHash: '0x' + 'bb'.repeat(32), originTxHash: 'aa'.repeat(32), amountOut: 83_290_011n });
  });

  it('extracts refund info on REFUNDED', () => {
    const s = mapNearStatus(fixture('near/status-refunded.handcrafted.json'));
    expect(s).toMatchObject({ status: 'refunded', refundTxHash: 'cc'.repeat(32), reason: 'DEADLINE_EXCEEDED' });
    expect(s.destinationTxHash).toBeUndefined();
  });

  it('throws on unknown statuses', () => {
    expect(() => mapNearStatus({ ...fixture('near/status-pending-deposit.json'), status: 'WAT' as never })).toThrow();
  });
});
