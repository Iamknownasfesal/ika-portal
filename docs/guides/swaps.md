# Swaps

Swaps move value across chains (for example BTC → USDC on Base) through third-party providers. The account sends the input to a provider's **deposit address** through a `swap` intent. The provider delivers the output to the account's own address on the destination chain.

## Configure providers and your fee

```ts
import { NearIntentsProvider, RelayProvider, LifiProvider } from '@ika-portal/swap';

const ika = new IkaPortal({
  ...,
  swap: {
    providers: [
      new NearIntentsProvider({ baseUrl: 'https://your-backend.example/1click' }), // your proxy (holds the JWT)
      new RelayProvider({}),
      new LifiProvider({ integrator: 'your-wallet', feeWallet: '0xYourLifiFeeWallet' }),
    ],
    fees: {
      integrator: { recipient: 'your-fee-account', bps: 30 },   // your fee
      // ika: { recipient: '…', bps: 0 },                       // optional protocol fee
    },
    priority: ['near-intents', 'relay'],   // tie-break order
    slippageBps: 100,
  },
});
```

## Quote and execute

```ts
const { best, quotes, errors } = await account.quoteSwap({
  from: { chain: 'bitcoin', asset: 'BTC', amount: 1_000_000n },
  to: { chain: 'base', asset: 'USDC' },
});

// Show every quote: providerId, amountOut (net of all fees), minAmountOut,
// fees.integrator / fees.ika / fees.provider[], estimatedTimeSec, executable.
const swap = await account.swap(best!);
for await (const e of swap.intent.progress()) render(e);   // the deposit transaction
const final = await swap.wait();   // 'success' | 'refunded' | 'failed' (+ destinationTxHash)
```

How the router chooses:

- All providers are queried in parallel with a 3 s timeout each.
- The router picks the highest `amountOut`, net of all fees. Ties are broken by `priority`.
- Providers that can't express your fee configuration are skipped, unless the fees are zero.
- Quotes marked `executable: false` are returned for display but never chosen as `best`.

Safety checks in `account.swap(quote)`:

1. The quote's recipient and refund address must equal the account's own addresses. Otherwise it throws `SwapRecipientMismatch`.
2. The deposit is a policy-checked `swap` intent: `swapsEnabled`, the swap limits and the general limits all apply.
3. If policy delays the deposit past the quote deadline minus 2 minutes, it throws `QuoteExpiresBeforeDelay`. Re-quote after the delay.

## Providers

| Provider | Executable here? | Notes |
| --- | --- | --- |
| **NEAR Intents 1Click** | Yes: plain transfer to a deposit address | Mainnet only (no testnet chains). Fees go in `appFees`; recipients can be NEAR accounts, EVM addresses or Solana keys (converted to NEAR implicit accounts); Bitcoin addresses are rejected. Without a partner JWT, 1Click adds its own 20 bps and halves yours |
| **Relay** | Yes, in deposit-address mode (BTC origin supported) | No dry quotes: each quote registers a deposit address. Fees build up in Relay's app-fee balance (EVM recipients only) |
| **LI.FI** | No (display only) | Routes need contract calldata, approvals or memos, which the policy program never signs. Fees require LI.FI portal setup (`feeWallet`) |
| **Mock** | Yes | Testnets and tests: fixed rates and a payout callback |

## Keep the 1Click JWT on your server

Never ship the partner JWT to clients. Run the included proxy handler on your backend. It exposes only the four 1Click endpoints the SDK uses, and can pin your fees:

```ts
import { createNearIntentsProxyHandler } from '@ika-portal/swap';

const handler = createNearIntentsProxyHandler({
  jwt: process.env.ONECLICK_JWT!,
  enforceAppFees: [{ recipient: 'your-fee-account.near', fee: 30 }], // clients can't strip or redirect fees
  responseHeaders: { 'access-control-allow-origin': 'https://your-wallet.app' },
});
// Works with any fetch-style server: Cloudflare Workers, Next.js route handlers, Bun, Deno…
export default { fetch: handler };
```

Point `NearIntentsProvider({ baseUrl })` at it.

## Testnets

No production provider supports testnets. Use `MockSwapProvider`:

```ts
import { MockSwapProvider } from '@ika-portal/swap';

new MockSwapProvider({
  rates: { 'BTC/USDC': '60000', 'ETH/USDC': '3000' },
  depositAddresses: { bitcoin: 'tb1q…yourTestDeposit', base: '0x…' },
  payout: async ({ chain, asset, to, amount }) => sendFromTestTreasury(chain, asset, to, amount),
});
```

`packages/swap/scripts/live-near-quote.ts` fetches a real mainnet dry quote from 1Click. Use it to check that your asset mapping and fees are correct.

## Squads / PDA owners

```ts
const prepared = await provider.prepare(quote);
const ixs = await account.instructions.swap(prepared);  // run in a vault transaction
```
