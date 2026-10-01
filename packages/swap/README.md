# @ika-portal/swap

Cross-chain swaps for Ika Portal: a provider interface, a router, and providers for
NEAR Intents 1Click, Relay, LI.FI and a testnet mock. Amounts are `bigint` base units everywhere
(BTC 8, ETH 18, USDC 6 decimals) and become decimal strings only at API boundaries.

```ts
import { SwapRouter, NearIntentsProvider, RelayProvider, LifiProvider, assertOwnAddresses } from '@ika-portal/swap';

const router = new SwapRouter({
  providers: [
    new NearIntentsProvider({ baseUrl: 'https://wallet.example/api/1click' }), // your proxy, see below
    new RelayProvider(),
    new LifiProvider({ integrator: 'my-wallet' }),
  ],
  priority: ['near-intents', 'relay', 'lifi'],
  timeoutMs: 3000,
});

const { best, quotes, errors, skipped } = await router.quoteAll({
  from: { chain: 'bitcoin', asset: 'BTC', amount: 100_000n },
  to: { chain: 'base', asset: 'USDC' },
  recipient: account.addresses.base,     // the account's own address
  refundTo: account.addresses.bitcoin,   // the account's own address
  slippageBps: 100,
  fees: { integrator: { recipient: 'wallet.near', bps: 30 }, ika: { recipient: 'ika.near', bps: 5 } },
});
const provider = router.getProvider(best!.providerId)!;
const prepared = await provider.prepare(best!);          // deposit address, exact amount, deadline
assertOwnAddresses(prepared, { recipient: account.addresses.base, refundTo: account.addresses.bitcoin });
// propose a `swap` intent: plain transfer of prepared.amount to prepared.depositAddress
// (ERC-20: transfer(prepared.depositAddress, amount) on prepared.tokenAddress) … approve, sign, broadcast
await provider.submitDeposit?.(prepared, txHash);
const status = await provider.status(prepared);          // { status: 'pending' | 'success' | 'refunded' | 'failed', ... }
```

If the intent is delayed past `prepared.deadline - 120 s`, cancel it and re-quote.

## Plain transfers only

The on-chain policy program can approve only **plain transfers**: a native BTC/ETH send to an
address, or an ERC-20 `transfer(to, amount)`. Never arbitrary calldata, approvals, or OP_RETURN
memos. Therefore every `Quote` carries `executable: boolean`:

* `executable: true` — funded by one plain transfer to `depositAddress` (no memo — `depositMemo` is typed `never`).
* `executable: false` (+ `nonExecutableReason`) — shown for price comparison only. The router
  never selects it as `best`; `prepare()` throws `SwapNotExecutable`.

## Router

`SwapRouter.quoteAll(req)` queries all providers in parallel with a per-provider timeout
(`AbortController`, default 3 s), skips providers whose `supportsFees(req.fees)` is false unless
the total fee bps is zero (reported in `skipped`), records throws/timeouts in `errors`, drops
quotes whose recipient/refundTo/amountIn differ from the request, and sorts: executable first,
highest `amountOut` (already net of all fees), then `priority` order (unlisted providers follow in
registration order).

`assertOwnAddresses(prepared, { recipient, refundTo })` throws `SwapRecipientMismatch` unless
the prepared quote pays and refunds the account's own addresses (EVM hex and bech32 compared
case-insensitively, base58 exactly).

## Providers

### NearIntentsProvider (1Click)

* `quote` = `POST {baseUrl}/v0/quote` with `dry: true`; `prepare` = the same with `dry: false`
  (returns `depositAddress`; rejected if 1Click returns a `depositMemo` or the fresh
  `amountOut` is below the dry quote's `minAmountOut`).
* Body: `swapType: EXACT_INPUT`, `depositType: ORIGIN_CHAIN`, `recipientType: DESTINATION_CHAIN`,
  `refundType: ORIGIN_CHAIN`, `depositMode: SIMPLE`, `slippageTolerance` (bps), `amount`
  (decimal string), `deadline` (ISO; default now + 2 h for Bitcoin origin, 30 min otherwise),
  `appFees: [{ recipient, fee /* bps */ }]` from `FeeConfig` (zero-bps entries omitted).
* `submitDeposit` → `POST /v0/deposit/submit { txHash, depositAddress }`.
* `status` → `GET /v0/status?depositAddress=…`: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`,
  `PROCESSING` → pending; `SUCCESS` → success; `REFUNDED` → refunded; `FAILED`,
  `INCOMPLETE_DEPOSIT` → failed.
* `PreparedSwap.deadline` = min(requested refund deadline, deposit-address `deadline`).

Asset ids (from `GET /v0/tokens`, overridable with `assetIds`):

| chain:asset | 1Click asset id |
| --- | --- |
| bitcoin:BTC | `nep141:btc.omft.near` |
| ethereum:ETH | `nep141:eth.omft.near` |
| ethereum:USDC | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` |
| base:ETH | `nep141:base.omft.near` |
| base:USDC | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` |

1Click also lists `1cs_v1:btc:native:coin` ("BTC(OMNI)") and echoes `nep141:btc.omft.near` back as that id.

**App-fee recipients are NEAR Intents account ids**, credited inside the Intents verifier
contract (not paid on-chain). 1Click does **not** validate them (a live dry quote accepted `"x"`),
so the provider maps and validates with `toIntentsAccountId()`:

* NEAR named accounts (`wallet.near`) and 64-hex implicit accounts: as-is.
* EVM address → lowercase `0x…` Intents account (controlled by that EVM key via signed intents). Accepted live.
* Solana base58 public key → NEAR implicit account (hex of the 32-byte key).
* Bitcoin addresses / anything else → `UnsupportedFeeRecipient`; `supportsFees()` returns false.

**JWT**: the partner JWT lives in the wallet backend. The provider takes only `baseUrl` (the proxy)
and optional `headers` (e.g. a wallet session). `createNearIntentsProxyHandler({ jwt, upstream?,
enforceAppFees? })` from `src/proxy/nearProxy.ts` is a fetch-style `(Request) => Promise<Response>`
handler that forwards only `GET /v0/tokens`, `POST /v0/quote`, `POST /v0/deposit/submit`,
`GET /v0/status` (404/405 otherwise), injects `Authorization: Bearer`, and can overwrite `appFees`
server-side so clients cannot strip fees.

Observed without a JWT (2026-09-30): quotes work, but 1Click adds its own 20 bps app fee
(recipient `5880ad2b…47dd`) and halves the requested app fee (30 → 15 bps). Fee lines use the
bps 1Click echoes; the extra fee appears in `fees.provider`. Use a partner JWT in production.

**Testnets**: 1Click is mainnet-only — `/v0/tokens` lists no testnet chains and a `tb1…` refund
address is rejected (`refundTo is not valid`). Use `MockSwapProvider` on testnets.

### RelayProvider (relay.link)

* `POST https://api.relay.link/quote/v2` with `useDepositAddress: true`, `tradeType: EXACT_INPUT`,
  `user`/`refundTo` = origin address, `refundOnOrigin: true`, `ttl` (deposit window),
  `slippageTolerance` (string bps), `appFees: [{ recipient, fee: "<bps>" }]`.
  Chain ids: bitcoin `8253038`, ethereum `1`, base `8453`; BTC currency
  `bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8`, native ETH `0x000…0`.
* **Works with BTC origin** (recorded live): a single `deposit` step with a per-request
  `depositAddress` and item data `{ amount }` — a plain BTC send. Native ETH gives `data: "0x"`
  to the deposit address; ERC-20 gives `transfer(depositAddress, amount)` on the token.
  The provider verifies this exactly (chain, target, amount, calldata) and marks anything else
  non-executable (e.g. the normal flow without `useDepositAddress`, which calls a contract).
* Relay has no dry mode: the quote call registers the deposit address, so `prepare` reuses it
  (re-quoting if older than `quoteTtlSec`, default 30 s). `providerRef` = Relay `requestId`.
* `submitDeposit` → `POST /transactions/index { chainId, txHash, requestId }`;
  `status` → `GET /intents/status/v3?requestId=…` (`waiting|depositing|pending|submitted` →
  pending, `success`, `refund` → refunded, `failure` → failed).
* App fees: multiple recipients supported, charged in bps of the input and credited to the
  recipient's Relay app-fee balance (claim via `/app-fees/{wallet}/claim`). `supportsFees` requires
  EVM recipients.
* Note: Relay's order data lists a destination-chain refund path (USDC to the recipient) next to
  the origin refund even with `refundOnOrigin: true`; both go to the account's own addresses.

### LifiProvider (li.fi)

* `GET https://li.quest/v1/quote?fromChain&toChain&fromToken&toToken&fromAmount&fromAddress&toAddress&slippage&integrator[&fee]`
  (BTC chain id `20000000000001`, token `bitcoin`).
* LI.FI routes return a `transactionRequest` that calls the LI.FI Diamond (often after an ERC-20
  approval), or for BTC a PSBT with an OP_RETURN memo. These are **`executable: false`**: they
  show in `quotes` for price comparison but are never `best`. A route that is a pure native/ERC-20
  transfer would be executable (no such route was observed).
* Fees: one `fee` (fraction) paid to the wallet configured for `integrator` in the LI.FI portal
  (unconfigured integrators get `400: Integrator "…" is not configured for collecting fees`).
  `supportsFees` is true only with `feeWallet` set, equal to `fees.integrator.recipient`, and no
  separate Ika fee.
* BTC quotes need a `fromAddress` with UTXOs (`404 No UTXOs found` otherwise).
* `status` uses `GET /v1/status?txHash=…` with the hash given to `submitDeposit`.

### MockSwapProvider (testnets)

`new MockSwapProvider({ rates: { 'BTC/USDC': '60000' }, payout, depositAddresses: { bitcoin: 'tb1…' } })`.
Decimal-exact, decimals-aware fixed rates (inverse pairs derived); integrator and Ika fee bps are
applied to the output. `prepare` returns the configured deposit address for the origin chain (an
address the test operator controls) and a deadline. `submitDeposit(p, txHash)` calls
`payout({ chain, asset, to, amount, depositTxHash })` to send the destination asset from a funded
test key and records `success` with the destination tx hash (or `failed` if payout throws).
Status is in memory. `feeSupport: false` simulates a provider that cannot express fees.

## Tests and fixtures

`pnpm --filter @ika-portal/swap test` — router (selection, priority tie-break, timeouts,
errors, fee skipping, non-executable), mock math and flow, 1Click body/fee mapping and status
mapping, Relay and LI.FI parsing, proxy. Fixtures in `test/fixtures/` were **recorded from the
live mainnet APIs on 2026-09-30** (no funds sent); files named `*.handcrafted.json` are status
responses derived from the OpenAPI schemas (we have no completed swap to record).

`pnpm --filter @ika-portal/swap exec tsx scripts/live-near-quote.ts` fetches a real mainnet
dry quote (0.001 BTC → USDC on Base).
