# Policies

A policy is attached to each account and enforced by the program when an intent is proposed.

```ts
import { defaultPolicy } from '@ika-portal/core';

const policy = defaultPolicy({
  limits: [
    { chain: 'bitcoin', asset: 'BTC', maxPerWindow: 5_000_000n, windowS: 86_400 },     // 0.05 BTC / day
    { chain: 'base', asset: 'USDC', maxPerWindow: 1_000_000_000n, windowS: 86_400 },    // 1,000 USDC / day
  ],
  allowlistEnabled: true,
  allowlist: [
    { chain: 'ethereum', address: '0xExchangeDeposit…' },
    { chain: 'bitcoin', address: 'tb1q…' },
  ],
  delayThresholds: [{ chain: 'base', asset: 'USDC', amount: 500_000_000n }],             // ≥ 500 USDC waits
  delayS: 3600,
  swapsEnabled: true,
  swapLimits: [{ chain: 'bitcoin', asset: 'BTC', maxPerWindow: 2_000_000n, windowS: 86_400 }],
  maxBtcFeeSats: 50_000n,
  maxEvmFeeWei: 5_000_000_000_000_000n,  // 0.005 ETH per direct EVM tx
  policyChangeDelayS: 86_400,
});
```

## Rules

| Field | Rule | Rejection |
| --- | --- | --- |
| `limits` (max 8) | Sends **and swaps** count toward the (chain, asset) window. Assets without an entry are unlimited | `LimitExceeded` |
| `allowlistEnabled` / `allowlist` (max 16) | `send` recipients must be listed for that chain. Swap deposits are exempt | `RecipientNotAllowed` |
| `delayThresholds` (max 8) + `delayS` | Intents at or above the amount can be approved only `delayS` after proposal | `NotExecutableYet` if approved early |
| `swapsEnabled` | `false` rejects `swap` intents | `SwapsDisabled` |
| `swapLimits` (max 8) | A separate cap for swaps | `SwapLimitExceeded` |
| `maxBtcFeeSats` | Effective BTC fee cap | `FeeTooHigh` |
| `maxEvmFeeWei` | `gas_limit × max_fee_per_gas` cap for direct EVM transactions | `FeeTooHigh` |
| `policyChangeDelayS` | A new policy takes effect only after this delay (0 allowed for tests) | `PolicyChangeNotReady` |

Rules to know:

- **Windows are fixed, not rolling.** A window resets when `now ≥ window_start + window_s`, and the new window starts at that moment.
- **Cancelling** a proposed intent releases its usage, if it's still in the same window.
- `evm_setup` and `evm_cancel_recovery` skip limits and the allowlist.
- One entry per (chain, asset) in `limits` and `swapLimits`; `windowS` must be > 0. Invalid policies fail with `InvalidPolicy`.

## Changing a policy

```ts
await account.proposePolicy(next);   // owner; effective at now + current policyChangeDelayS
account.view.pendingPolicy;          // show it with a countdown to account.view.pendingPolicyAt
await account.applyPolicy();         // anyone, once the delay has passed
await account.cancelPolicy();        // owner, any time before apply
```

The delay that applies is the one in the **current** policy, so a user can't shorten it in the same step that loosens their limits. Spend usage carries over for limits whose chain, asset and window are unchanged.

## Showing policy in your UI

- `account.policy`: the decoded current policy.
- `account.view.spend.limits[i]` / `.swaps[i]`: `{ windowStart, used }`, aligned with `policy.limits[i]` / `policy.swapLimits[i]`.
- `account.checkPolicy(prepared)`: evaluates a send off-chain with the same rules. See [Sending](sending.md#preview-the-policy-result).

## A known gap: swaps

A swap deposit goes to the provider's address, so the program can't verify on-chain where the swap output ends up. `swapsEnabled` and `swapLimits` are the only on-chain controls. The SDK checks off-chain that the quote's recipient and refund addresses are the account's own.
