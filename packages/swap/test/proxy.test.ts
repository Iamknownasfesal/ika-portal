import { describe, expect, it } from 'vitest';
import { NearIntentsProvider, createNearIntentsProxyHandler } from '../src/index.js';
import { btcToBaseUsdc, fixture, replayFetch } from './helpers.js';

describe('createNearIntentsProxyHandler', () => {
  function setup(enforceAppFees?: { recipient: string; fee: number }[]) {
    const upstream = replayFetch({
      'POST /v0/quote': { body: fixture('near/quote-dry-btc-base-usdc.json') },
      'GET /v0/status': { body: fixture('near/status-pending-deposit.json') },
      'GET /v0/tokens': { body: [] },
      'POST /v0/deposit/submit': { body: {} },
    });
    const handler = createNearIntentsProxyHandler({ jwt: 'SECRET.JWT', fetch: upstream.fetch, ...(enforceAppFees ? { enforceAppFees } : {}) });
    return { handler, upstream };
  }

  it('injects the bearer JWT and forwards the 4 endpoints', async () => {
    const { handler, upstream } = setup();
    const r1 = await handler(new Request('https://wallet.example/api/1click/v0/quote', { method: 'POST', body: JSON.stringify({ dry: true }) }));
    expect(r1.status).toBe(200);
    expect(upstream.calls[0]!.url).toBe('https://1click.chaindefuser.com/v0/quote');
    expect(upstream.calls[0]!.headers.authorization).toBe('Bearer SECRET.JWT');
    expect(upstream.calls[0]!.body).toEqual({ dry: true });

    await handler(new Request('https://wallet.example/api/1click/v0/status?depositAddress=abc'));
    expect(upstream.calls[1]!.url).toBe('https://1click.chaindefuser.com/v0/status?depositAddress=abc');
    expect((await handler(new Request('https://w/v0/tokens'))).status).toBe(200);
    expect((await handler(new Request('https://w/v0/deposit/submit', { method: 'POST', body: '{}' }))).status).toBe(200);
  });

  it('blocks other paths and methods', async () => {
    const { handler, upstream } = setup();
    expect((await handler(new Request('https://w/v0/account/balances'))).status).toBe(404);
    expect((await handler(new Request('https://w/v0/quote'))).status).toBe(405);
    expect((await handler(new Request('https://w/v0/status', { method: 'POST', body: '{}' }))).status).toBe(405);
    expect(upstream.calls).toHaveLength(0);
  });

  it('can enforce server-side appFees', async () => {
    const { handler, upstream } = setup([{ recipient: 'wallet.near', fee: 25 }]);
    await handler(new Request('https://w/v0/quote', { method: 'POST', body: JSON.stringify({ dry: true, appFees: [] }) }));
    expect(upstream.calls[0]!.body.appFees).toEqual([{ recipient: 'wallet.near', fee: 25 }]);
  });

  it('works end-to-end as the NearIntentsProvider baseUrl', async () => {
    const { handler, upstream } = setup();
    const p = new NearIntentsProvider({ baseUrl: 'https://wallet.example/api/1click', fetch: (u, init) => handler(new Request(u, init)) });
    const q = await p.quote(btcToBaseUsdc());
    expect(q?.amountOut).toBe(83_284_843n);
    expect(upstream.calls[0]!.headers.authorization).toBe('Bearer SECRET.JWT');
  });
});
