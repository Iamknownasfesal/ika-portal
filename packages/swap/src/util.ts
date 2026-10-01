import { SwapProviderError } from './errors.js';
import type { FeeConfig, FeeLine, FeeSide, FetchLike, QuoteFees } from './types.js';

export const BPS = 10_000n;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function totalFeeBps(fees: FeeConfig): number {
  return (fees.integrator?.bps ?? 0) + (fees.ika?.bps ?? 0);
}

export function assertValidFees(fees: FeeConfig): void {
  for (const f of [fees.integrator, fees.ika]) {
    if (!f) continue;
    if (!Number.isInteger(f.bps) || f.bps < 0) throw new RangeError(`fee bps must be a non-negative integer, got ${f.bps}`);
  }
  if (totalFeeBps(fees) >= 10_000) throw new RangeError('total fee bps must be < 10000');
}

/** Configured fee entries with bps > 0. */
export function activeFees(fees: FeeConfig): { kind: 'integrator' | 'ika'; recipient: string; bps: number }[] {
  const out: { kind: 'integrator' | 'ika'; recipient: string; bps: number }[] = [];
  if (fees.integrator && fees.integrator.bps > 0) out.push({ kind: 'integrator', ...fees.integrator });
  if (fees.ika && fees.ika.bps > 0) out.push({ kind: 'ika', ...fees.ika });
  return out;
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BPS;
}

/** Build the integrator/ika fee lines of a quote, computed on `base` (input or output amount). */
export function configuredFeeLines(fees: FeeConfig, base: bigint, side: FeeSide): Pick<QuoteFees, 'integrator' | 'ika'> {
  const line = (f?: { recipient: string; bps: number }): FeeLine | undefined =>
    f && f.bps > 0 ? { recipient: f.recipient, bps: f.bps, amount: bpsOf(base, f.bps), side } : undefined;
  const out: Pick<QuoteFees, 'integrator' | 'ika'> = {};
  const i = line(fees.integrator);
  const k = line(fees.ika);
  if (i) out.integrator = i;
  if (k) out.ika = k;
  return out;
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const BECH32_RE = /^(bc|tb|bcrt)1[02-9ac-hj-np-z]{6,87}$/i;

export function isEvmAddress(s: string): boolean {
  return EVM_RE.test(s);
}

/**
 * Address equality: case-insensitive for EVM hex addresses and bech32
 * (both are case-insensitive encodings); exact otherwise (base58 is case-sensitive).
 */
export function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  if ((isEvmAddress(a) && isEvmAddress(b)) || (BECH32_RE.test(a) && BECH32_RE.test(b))) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

export function toBigInt(v: unknown, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new TypeError(`${what}: expected integer amount, got ${JSON.stringify(v)}`);
}

export function isoToSec(iso: string | undefined | null): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

export interface HttpOptions {
  providerId: string;
  fetch: FetchLike;
  headers?: Record<string, string>;
}

export async function httpJson<T>(
  http: HttpOptions,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...http.headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (signal) init.signal = signal;
  const res = await http.fetch(url, init);
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'message' in parsed ? String((parsed as { message: unknown }).message) : text.slice(0, 200);
    throw new SwapProviderError(http.providerId, `${method} ${url} -> HTTP ${res.status}: ${msg}`, res.status, parsed);
  }
  return parsed as T;
}

export function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') throw new Error('global fetch is not available; pass `fetch` explicitly');
  return (input, init) => globalThis.fetch(input, init);
}

/** Encode ERC-20 `transfer(to, amount)` calldata (lowercase hex). */
export function encodeErc20Transfer(to: string, amount: bigint): string {
  if (!isEvmAddress(to)) throw new TypeError(`not an EVM address: ${to}`);
  return '0xa9059cbb' + to.slice(2).toLowerCase().padStart(64, '0') + amount.toString(16).padStart(64, '0');
}

/** Decode ERC-20 `transfer(to, amount)` calldata; undefined if it is anything else. */
export function decodeErc20Transfer(data: string): { to: string; amount: bigint } | undefined {
  const d = data.toLowerCase();
  if (!/^0xa9059cbb[0-9a-f]{128}$/.test(d)) return undefined;
  const toWord = d.slice(10, 74);
  if (!/^0{24}/.test(toWord)) return undefined;
  return { to: '0x' + toWord.slice(24), amount: BigInt('0x' + d.slice(74)) };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array | undefined {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return undefined;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
