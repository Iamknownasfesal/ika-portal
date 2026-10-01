# Error codes

Errors surface as `IkaPortalError` (`e.code`, `e.message`). Program errors are decoded from transaction logs, so the code is the same whether the SDK pre-check or the program rejected the action.

## Program errors (`ika_account`)

### Policy rejections: show these to the user

| Code | # | Meaning | Suggested UX |
| --- | --- | --- | --- |
| `LimitExceeded` | 6000 | Spending limit for this chain/asset window exceeded | Show the remaining allowance and when the window resets |
| `RecipientNotAllowed` | 6001 | Recipient isn't in the allowlist | Offer to add it (a policy change, with delay) |
| `SwapsDisabled` | 6002 | Swaps are disabled by policy | — |
| `SwapLimitExceeded` | 6003 | Swap limit for this window exceeded | Show remaining swap allowance |
| `FeeTooHigh` | 6004 | BTC fee or direct-mode EVM max fee exceeds the cap | Retry later, or raise the cap |
| `UnknownChain` | 6005 | Chain isn't in the program Config (or has no 7702 implementation for setup) | Integration/config issue |
| `TooManyInputs` | 6006 | More BTC inputs than `max_btc_inputs` (4) | Send a smaller amount or consolidate UTXOs |

### Validation

| Code | # | Meaning |
| --- | --- | --- |
| `UnknownAsset` | 6007 | Token isn't in the Config token list for that chain |
| `InvalidPolicy` | 6008 | Duplicate (chain, asset), `windowS = 0`, bad allowlist address, or too many entries |
| `InvalidRecovery` | 6009 | Recovery params don't match the mode |
| `PdaOwnerRequiresPublicShare` | 6010 | PDA owner with `encrypted` user share |
| `InvalidDWallet` | 6011 | Not a dWallet of the configured dWallet program |
| `DWalletNotActive` | 6012 | dWallet not in the Active state |
| `WrongDWalletAuthority` | 6013 | dWallet authority isn't the program's CPI PDA |
| `WrongCurve` | 6014 | Not secp256k1 |
| `InvalidRole` | 6015 | Role doesn't fit the mode, the chain is already covered, or the dWallet is already registered |
| `AccountNotReady` | 6016 | No dWallet registered for that chain |
| `InvalidIntentParams` | 6017 | Malformed intent (wrong params for the chain or kind) |
| `InvalidAddress` | 6018 | EVM address not 20 bytes / BTC script empty or > 34 bytes |
| `InsufficientInputs` | 6019 | BTC inputs don't cover amount + fee |
| `EvmNotDelegated` | 6020 | Delegated send before `setupEvm` |
| `RecoveryNotConfigured` | 6021 | Cancel-recovery on a non-`enforced_recovery` account |
| `DeadlineExpired` | 6022 | Delegated / cancel-recovery deadline has passed |
| `InvalidPoint` | 6023 | Supplied secp256k1 Y coordinate doesn't match the key |
| `DigestError` | 6024 | Internal serialization overflow |

### Lifecycle

| Code | # | Meaning |
| --- | --- | --- |
| `IntentNotProposed` | 6025 | Approve or cancel on an intent that isn't `proposed` |
| `NotExecutableYet` | 6026 | Approve before the delay has passed (the SDK waits and retries) |
| `NoPendingPolicy` | 6027 | Apply/cancel with nothing pending |
| `PolicyChangeNotReady` | 6028 | Apply before `policyChangeDelayS` has passed |
| `InvalidMessageApproval` | 6029 | Wrong Ika MessageApproval account passed to approve |
| `WrongApprovalCount` | 6030 | Wrong number of MessageApproval accounts |
| `WrongDWallet` | 6031 | Wrong dWallet account for the intent's chain |
| `Overflow` | 6032 | Arithmetic overflow |

Anchor constraint errors (e.g. `ConstraintHasOne`, 2001, when someone other than the owner signs) come through as `TransactionFailed` with logs attached.

## SDK errors

| Code | Where | Meaning / fix |
| --- | --- | --- |
| `ShareLocked` | sign | Encrypted share and no unlocker, or the unlocker derives the wrong key (different wallet) |
| `DWalletNotFound` | load, sign | dWallet gone (Ika pre-alpha devnet wipe), or missing `DWalletRef` / `session` |
| `AccountNotFound` | load | No account at `(owner, index)` |
| `OwnerNotWallet` | owner actions | Owner isn't the connected wallet (PDA?). Use `prepareAccount` / `instructions.*` |
| `NoFeePayer` | send | Neither `feePayer` nor `wallet` configured |
| `NoRelayer` | delegated EVM | Set `relayerUrl` |
| `NoSwapProviders` / `SwapNotExecutable` | swaps | Configure providers / pick an executable quote |
| `QuoteExpiresBeforeDelay` | swaps | Policy delay outlasts the quote: re-quote after the delay |
| `DigestMismatch` | sign | The locally rebuilt preimage doesn't match the approved digest. The SDK refuses to sign. Report it: indicates version skew between SDK and program |
| `EvmReverted` | EVM confirm | Destination transaction reverted |
| `DWalletProgramMismatch` | init | Program Config and signer target different dWallet programs (e.g. mock vs Ika) |
| `UnknownAsset` / `UnknownChain` | config | Asset or chain missing from the SDK `chains` config |
| `Timeout` | waitForAccount | Account didn't appear in time |
| `TransactionFailed` | any | Undecoded failure; see `e.logs` |
| `Unsupported` | signer | Feature not available on the Ika pre-alpha (key import, gas deposit funding) |
| `IkaError` | signer | Ika gRPC returned an error (message included) |
| `ApprovalMissing` / `ApprovalMismatch` | signer | The MessageApproval account is absent or doesn't match the message |
