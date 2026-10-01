# Security and trust model

## What the design guarantees

- **Only the program can approve signatures.** Each registered dWallet's authority is the `ika_account` CPI PDA, and Ika signs only messages that PDA approved.
- **Only the owner can propose.** Every intent needs the owner's signature (keypair, or a vault/program via its PDA).
- **The program signs only what it computed.** Digests are derived on-chain from structured intent fields (recipient, amount, asset, nonce, deadline, UTXOs). Clients never submit digests, so a policy can't be shown one thing and asked to approve another.
- **Verify-before-sign in the SDK.** The SDK rebuilds every preimage from the on-chain intent and refuses to request a signature unless it hashes to the approved digest.
- **One account per dWallet.** A claim PDA prevents the same dWallet from being registered to two accounts. The hand-off and registration are atomic, so they can't be front-run.
- **The policy can't be loosened instantly.** Changes wait `policy_change_delay_s`, which comes from the current policy.
- **EVM setup can only delegate to the Config implementation.** No intent field chooses the 7702 target.
- **Replay protection.** EVM direct uses the EOA nonce; delegated mode uses the `IkaAccount` nonce plus deadlines. Bitcoin signatures commit to the exact inputs and values (BIP143). Ika approvals are unique per digest.

## What each party can do

| Party | Can | Can't |
| --- | --- | --- |
| Owner | Propose anything the policy allows; change policy (after the delay); cancel proposed intents | Bypass policy (except `recoverable` via the mnemonic) |
| Anyone | Approve executable intents (pays rent); apply a pending policy after its delay | Create or alter intents |
| Ika session key (`identity`) | Authenticate gRPC requests | Get anything signed without an on-chain approval |
| Relayer | Submit or withhold dWallet-signed calls | Change them (they're signed); spend from accounts |
| Config admin | Change chains, tokens, the 7702 implementation and the dWallet program for **all** accounts | Spend from accounts directly. **This is a strong role: use a multisig** |
| Recovery key holder | After the delay: spend BTC (CSV) and EVM (`recoveryExecute`) | Act before the delay; the owner can cancel EVM recovery meanwhile |

## Mode and share trade-offs

- `recoverable`: whoever holds the mnemonic has full control, and policy doesn't apply to them.
- `public` share: Ika network threshold + Solana owner authorization. On the pre-alpha this is a single mock signer.
- `encrypted` share: the owner's device must unlock the share for each signature. **On the pre-alpha this is enforced by the SDK, not by the network**, because the mock signer doesn't verify the user's share.

## Pre-alpha caveats (don't hold value)

- The Ika Solana pre-alpha uses a single mock signer, not 2PC-MPC. Keys aren't production-secure.
- Devnet state is wiped periodically.
- The program and contract haven't been audited.
- The relayer has no authentication.
- The swap output destination can't be verified on-chain. Only `swapsEnabled` and swap limits apply on-chain; recipient/refund addresses are checked off-chain.

## Handling secrets in your wallet

- Show the mnemonic or recovery key once and never persist it. Don't send it to analytics or crash reporting.
- Treat `DWalletRef`s as integrity-sensitive (they're needed to sign), but they aren't secret.
- Keep the Ika session key separate from users' funds keys.
- Keep the 1Click partner JWT and the relayer key server-side only.
