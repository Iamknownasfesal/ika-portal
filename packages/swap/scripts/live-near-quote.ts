/**
 * Fetch a REAL mainnet DRY quote from NEAR Intents 1Click (no deposit address, no execution).
 *
 *   pnpm --filter @ika-portal/swap exec tsx scripts/live-near-quote.ts
 *
 * Env (all optional):
 *   ONECLICK_BASE_URL  default https://1click.chaindefuser.com (or your proxy URL)
 *   ONECLICK_JWT       if set, sent as Bearer (only for local runs — never ship it to clients)
 *   AMOUNT_SATS        default 100000 (0.001 BTC)
 *   RECIPIENT          Base address receiving USDC (placeholder default)
 *   REFUND_TO          BTC refund address (placeholder default)
 *   FEE_RECIPIENT      NEAR Intents account / EVM address for the integrator fee (default ika-integrator.near)
 *   FEE_BPS            default 30
 */
import { NearIntentsProvider, type QuoteRequest } from '../src/index.js';

const baseUrl = process.env.ONECLICK_BASE_URL ?? 'https://1click.chaindefuser.com';
const headers: Record<string, string> = process.env.ONECLICK_JWT ? { authorization: `Bearer ${process.env.ONECLICK_JWT}` } : {};

const provider = new NearIntentsProvider({ baseUrl, headers });
const req: QuoteRequest = {
  from: { chain: 'bitcoin', asset: 'BTC', amount: BigInt(process.env.AMOUNT_SATS ?? '100000') },
  to: { chain: 'base', asset: 'USDC' },
  recipient: process.env.RECIPIENT ?? '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
  refundTo: process.env.REFUND_TO ?? 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  slippageBps: 100,
  fees: { integrator: { recipient: process.env.FEE_RECIPIENT ?? 'ika-integrator.near', bps: Number(process.env.FEE_BPS ?? 30) } },
};

const fmt = (v: bigint, d: number) => {
  const s = v.toString().padStart(d + 1, '0');
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
};

const t0 = Date.now();
const q = await provider.quote(req);
if (!q) {
  console.error('route not supported');
  process.exit(1);
}
const raw = q.raw as { correlationId: string; timestamp: string; quoteRequest: { appFees?: unknown; originAsset?: string } };
console.log(`1Click dry quote from ${baseUrl} in ${Date.now() - t0} ms (correlationId ${raw.correlationId}, ${raw.timestamp})`);
console.log(`  ${fmt(q.amountIn, 8)} BTC -> ${fmt(q.amountOut, 6)} USDC on Base (min ${fmt(q.minAmountOut, 6)}, slippage ${req.slippageBps} bps)`);
console.log(`  recipient ${q.recipient}  refundTo ${q.refundTo}`);
console.log(`  deadline ${new Date(q.deadline * 1000).toISOString()}  est. ${q.estimatedTimeSec}s  executable=${q.executable}`);
console.log(`  requested appFees: ${JSON.stringify(provider.mapAppFees(req.fees))}`);
console.log(`  echoed appFees:    ${JSON.stringify(raw.quoteRequest.appFees)}  (originAsset echoed as ${raw.quoteRequest.originAsset})`);
console.log(
  '  fee lines:',
  JSON.stringify(q.fees, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
);
