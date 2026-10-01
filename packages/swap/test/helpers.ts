import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike, QuoteRequest } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(join(here, 'fixtures', path), 'utf8')) as T;
}

export interface RecordedCall {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

/** A fetch that replays recorded responses, matched by `METHOD path-prefix`. */
export function replayFetch(routes: Record<string, { status?: number; body: unknown } | ((call: RecordedCall) => { status?: number; body: unknown })>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const u = new URL(input);
    const method = init?.method ?? 'GET';
    const call: RecordedCall = {
      url: input,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (u.pathname + u.search).startsWith(p!);
    });
    if (!key) return new Response(JSON.stringify({ message: `no fixture for ${method} ${u.pathname}` }), { status: 404 });
    const r = routes[key]!;
    const { status = 200, body } = typeof r === 'function' ? r(call) : r;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

// Addresses used when the fixtures were recorded.
export const EVM_ADDR = '0x2527D02599Ba641c19FEa793cD0F167589a0f10D';
export const BTC_ADDR_NEAR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
export const BTC_ADDR_RELAY = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

export function btcToBaseUsdc(over: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    from: { chain: 'bitcoin', asset: 'BTC', amount: 100_000n },
    to: { chain: 'base', asset: 'USDC' },
    recipient: EVM_ADDR,
    refundTo: BTC_ADDR_NEAR,
    slippageBps: 100,
    fees: { integrator: { recipient: 'ika-integrator.near', bps: 30 } },
    ...over,
  };
}
