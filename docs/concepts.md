# Concepts

## The pieces

```
 Owner (keypair / Squads vault / program)
   │ signs intents
   ▼
 ika_account program ── CPI approve_message ──▶ Ika dWallet program ◀── reads ── Ika network
   │ policy + digests                                                                │ signs approved digests
   ▼                                                                                 ▼
 Your wallet (SDK) ───────── assembles and broadcasts signed txs ──────────▶ Bitcoin / Ethereum / Base
```

- **dWallet:** a secp256k1 key created by the Ika network (DKG) or imported. Its on-chain *authority* decides who can approve messages for it. Ika Portal transfers that authority to the `ika_account` program's CPI PDA, so the program is the only path to a signature.
- **Account:** a Solana PDA `["account", owner, index]` holding the owner, mode, registered dWallets, policy and spend windows. One owner can have many accounts (`index` 0–65535).
- **Addresses:** derived from the dWallet public keys.
  - Bitcoin: P2WPKH, or P2WSH for `enforced_recovery`.
  - EVM: the standard address of the key. **Ethereum and Base share one address.**

## Intents

Every action is an **intent**: a structured request stored in an `Intent` PDA (`["intent", account, nonce]`).

| Kind | Meaning |
| --- | --- |
| `send` | Transfer native BTC/ETH or a configured ERC-20 to an address |
| `swap` | A `send` to a swap provider's deposit address. Counts toward swap limits and is exempt from the allowlist |
| `evm_setup` | One-time EIP-7702 delegation + `IkaAccount.initialize` (gasless mode) |
| `evm_cancel_recovery` | dWallet-signed cancellation of a pending EVM recovery |

Lifecycle:

```
propose_intent (owner) ──▶ proposed ──(delay, if any)──▶ approve_intent (anyone) ──▶ approved
       │                                                                                │
       └── cancel_intent (owner) ──▶ cancelled                    Ika signs ──▶ SDK broadcasts ──▶ confirmed
```

- **propose** checks the policy and records spend. It fails with a typed error per rule.
- **approve** is permissionless. It requires `now ≥ executable_at`, **computes the digests from the intent's fields**, and approves each on Ika. Clients never submit digests, so a policy can't be tricked into approving something other than what it evaluated.
- The SDK then rebuilds each preimage from the **on-chain** intent. It refuses to request a signature unless the preimage hashes to the approved digest.

SDK progress events: `building → (awaiting_owner) → proposed → (delayed) → approved → signed → broadcast → confirmed`, or `cancelled` / `failed`.

## Account modes

Fixed at creation (changing the mode would change the addresses).

| Mode | How keys are made | Can policy be bypassed? | If Ika disappears |
| --- | --- | --- | --- |
| `recoverable` | A BIP39 mnemonic is generated on the device. `m/84'/…/0/0` (BTC) and `m/44'/60'/0'/0/0` (EVM) are imported into two dWallets | **Yes:** whoever holds the mnemonic can sign directly | Restore the mnemonic in any wallet |
| `enforced` | Ika DKG; no full key ever exists | No | Funds can't move |
| `enforced_recovery` | Ika DKG + a user-held recovery key | Only after the recovery delay | BTC: CSV branch after `csvBlocks`; EVM: `IkaAccount` recovery after `evmDelayS` (gasless mode) |

User-facing copy (use it verbatim):

- Recoverable: "You keep a recovery phrase. It works in any wallet, and it can bypass your policies."
- Enforced: "No full key exists. Policies can't be bypassed. If Ika becomes permanently unavailable, funds can't be moved."
- Enforced with recovery: "No full key exists. If Ika is unavailable, your recovery key can move funds after the delay."

> Pre-alpha: `recoverable` works only with `LocalMockSigner`, because the pre-alpha can't import a specific key yet.

## User share

Independent of mode; set per account.

| `userShare` | Who takes part in each signature | Allowed owners |
| --- | --- | --- |
| `public` | Only Ika. The Solana policy is the only gate | Any, including PDAs (Squads, programs) |
| `encrypted` | The owner's device must unlock the share (Solana signature or passkey) | Keypairs and passkeys. **PDAs are rejected on-chain** |

Copy: Public: "Your Solana account's approval is enough to sign." Encrypted: "Only your device can unlock your key share. Nothing is signed without it." (Show this choice only when the owner isn't a PDA.)

## EVM modes

| | direct (default) | delegated (gasless) |
| --- | --- | --- |
| What's signed | A normal EIP-1559 transaction | `IkaAccount.execute(...)` (EIP-712) |
| Who pays gas | The dWallet address (needs ETH) | Your relayer |
| Setup | None | One `setupEvm(chain)` per chain (EIP-7702) |
| Contract / relayer | None | `IkaAccount.sol` + `services/relayer` |
| EVM recovery | Not available | Available for `enforced_recovery` |

`account.send` uses delegated mode automatically once a chain is set up. Pass `evmMode` to override.

## Policy

Per account, enforced on-chain at propose time. See [Policies](guides/policies.md).

- **limits:** per (chain, asset), fixed windows.
- **allowlist:** send recipients only.
- **delay thresholds:** intents at or above an amount wait `delayS`.
- **swaps:** on/off, plus separate swap limits.
- **fee caps:** BTC sats; EVM `gas × maxFee` for direct mode.
- **policy change delay:** a new policy lands only after `policyChangeDelayS`.
