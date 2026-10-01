/**
 * Reference backend proxy for the NEAR Intents 1Click API.
 *
 * The partner JWT stays on the wallet's server; clients point `NearIntentsProvider.baseUrl`
 * at this handler. Only the four endpoints the SDK uses are forwarded:
 *   GET /v0/tokens, POST /v0/quote, POST /v0/deposit/submit, GET /v0/status
 * Anything else returns 404 (unknown path) or 405 (wrong method).
 *
 * Works with any fetch-style server (Bun.serve, Deno.serve, Cloudflare Workers, Next.js route
 * handlers, or Node via a small adapter). The handler matches on the path suffix starting at
 * `/v0/`, so it can be mounted under any prefix (e.g. `/api/1click/v0/quote`).
 */
import type { FetchLike } from '../types.js';

export interface NearIntentsProxyOptions {
  /** 1Click partner JWT. Server-side only. */
  jwt: string;
  /** Upstream API. Default https://1click.chaindefuser.com */
  upstream?: string;
  fetch?: FetchLike;
  /**
   * If set, the proxy overwrites `appFees` on every POST /v0/quote so clients cannot strip or
   * redirect the wallet's fees.
   */
  enforceAppFees?: { recipient: string; fee: number }[];
  /** Extra CORS / response headers. */
  responseHeaders?: Record<string, string>;
}

const ROUTES: Record<string, 'GET' | 'POST'> = {
  '/v0/tokens': 'GET',
  '/v0/quote': 'POST',
  '/v0/deposit/submit': 'POST',
  '/v0/status': 'GET',
};

export function createNearIntentsProxyHandler(opts: NearIntentsProxyOptions): (req: Request) => Promise<Response> {
  const upstream = (opts.upstream ?? 'https://1click.chaindefuser.com').replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...opts.responseHeaders } });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const idx = url.pathname.indexOf('/v0/');
    const path = idx >= 0 ? url.pathname.slice(idx).replace(/\/+$/, '') : '';
    const method = ROUTES[path];
    if (!method) return json(404, { message: 'not found' });
    if (req.method !== method) return json(405, { message: 'method not allowed' });

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${opts.jwt}`,
    };
    const init: RequestInit = { method, headers };
    if (method === 'POST') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { message: 'invalid JSON body' });
      }
      if (path === '/v0/quote' && opts.enforceAppFees && body && typeof body === 'object') {
        (body as Record<string, unknown>).appFees = opts.enforceAppFees;
      }
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const target = upstream + path + (method === 'GET' ? url.search : '');
    let res: Response;
    try {
      res = await doFetch(target, init);
    } catch (e) {
      return json(502, { message: `upstream error: ${e instanceof Error ? e.message : String(e)}` });
    }
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', ...opts.responseHeaders },
    });
  };
}
