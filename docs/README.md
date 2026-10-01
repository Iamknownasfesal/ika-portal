# Ika Portal: integrator documentation

Ika Portal lets a Solana wallet give each user a native **Bitcoin**, **Ethereum** and **Base** address, controlled by the user's Solana account. Keys on those chains are [Ika](https://ika.xyz) dWallets. An on-chain Solana program (`ika_account`) decides what they may sign, so spending limits, allowlists and delays hold no matter which app or device asks.

> **Status: testnet / devnet only.** It runs on the Ika Solana pre-alpha, which signs with a single mock signer, not real MPC. Don't hold real funds. See [Security and trust model](security.md).

## Start here

| If you want to… | Read |
| --- | --- |
| Get an account created and a send working in 15 minutes | [Getting started](getting-started.md) |
| Understand intents, modes, user shares and the lifecycle | [Concepts](concepts.md) |
| Ship it in a browser extension or web wallet | [Browser integration](guides/browser.md) |
| Support Squads vaults / program-owned accounts | [Squads and PDA owners](guides/pda-owners.md) |
| Offer cross-chain swaps with your fee | [Swaps](guides/swaps.md) |
| Look up a method, type or error code | [API reference](reference/api.md) · [Errors](reference/errors.md) |

## Guides

1. [Creating accounts](guides/accounts.md): modes, user share, what to persist, what to show once
2. [Sending](guides/sending.md): BTC, ETH, USDC; progress events; resuming; broadcasting yourself
3. [Policies](guides/policies.md): limits, allowlists, delays, fee caps, changing policy
4. [Swaps](guides/swaps.md): NEAR Intents 1Click, Relay, LI.FI, the router, integrator fees
5. [Gasless EVM (EIP-7702)](guides/evm-gasless.md): delegated mode and the relayer
6. [Recovery](guides/recovery.md): mnemonic restore, BTC CSV branch, EVM recovery
7. [Squads and PDA owners](guides/pda-owners.md): instruction builders and vault transactions
8. [Browser integration](guides/browser.md): polyfills, gRPC-web, session key, storage

## Reference

- [API reference](reference/api.md): `IkaPortal`, `IkaAccountHandle`, `IntentHandle`, signers, unlockers, chain helpers
- [Error codes](reference/errors.md): program errors (6000–6032) and SDK errors
- [Program reference](reference/program.md): instructions, accounts, PDAs, and the digests the program signs
- [Operations](operations.md): deploying the program, Config, relayer, NEAR proxy
- [Security and trust model](security.md)
- [FAQ and troubleshooting](faq.md)

## Packages

| Package | What it's for |
| --- | --- |
| `@ika-portal/core` | The client you integrate: `IkaPortal`, accounts, intents, policy preview |
| `@ika-portal/signer` | Signer backends (`IkaPreAlphaSigner`, `LocalMockSigner`) and share unlockers |
| `@ika-portal/chains` | Bitcoin/EVM helpers, backends (bitcoind, Esplora), offline recovery tools |
| `@ika-portal/swap` | Swap providers, router, NEAR 1Click proxy handler |
| `@ika-portal/relayer` | Optional EVM gas relayer for gasless (delegated) mode |

## Devnet endpoints

| | |
| --- | --- |
| `ika_account` program | `Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje` (Solana devnet) |
| Ika dWallet program | `87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY` |
| Ika gRPC / gRPC-web | `pre-alpha-dev-1.ika.ika-network.net:443` |
| EVM testnets | Sepolia (`11155111`), Base Sepolia (`84532`) |
| Bitcoin | testnet4 (Esplora: `https://mempool.space/testnet4/api`) |

The Ika pre-alpha devnet is **wiped periodically**. Accounts whose dWallets were wiped fail to load with `DWalletNotFound`.
