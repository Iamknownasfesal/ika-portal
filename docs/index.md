---
layout: home

hero:
  name: Ika Portal
  text: Bitcoin, Ethereum and Base for every Solana account
  tagline: Give your users native multi-chain addresses controlled by their Solana account, with spending policies enforced on-chain. Powered by Ika dWallets.
  image:
    src: /logo.svg
    alt: Ika Portal
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Concepts
      link: /concepts
    - theme: alt
      text: API reference
      link: /reference/api
    - theme: alt
      text: Try the demo wallet ↗
      link: https://ika-portal-wallet.vercel.app

features:
  - icon: 🔑
    title: Native addresses, Solana control
    details: Every Solana account (keypair, Squads vault, passkey wallet or program) gets real BTC, ETH and Base addresses. No bridges, no wrapped assets.
    link: /concepts
  - icon: 🛡️
    title: Policies enforced on-chain
    details: Spending limits, recipient allowlists, delays above a threshold, fee caps and delayed policy changes. The program computes every digest it approves.
    link: /guides/policies
  - icon: 🔁
    title: Cross-chain swaps with your fee
    details: Route through NEAR Intents 1Click, Relay and LI.FI. Best quote wins, integrator fees included, output delivered to the user's own address.
    link: /guides/swaps
  - icon: ⛽
    title: Gasless EVM, optional
    details: Direct mode works with no contract or relayer. Turn on EIP-7702 delegation for gasless sends and on-chain EVM recovery.
    link: /guides/evm-gasless
  - icon: 🏦
    title: Squads & programs as owners
    details: Instruction builders for multisig vaults and program-owned accounts. The SDK continues automatically after the vault executes.
    link: /guides/pda-owners
  - icon: 🧭
    title: Three key modes
    details: Recoverable (seed phrase), enforced (no full key ever exists) or enforced with a recovery key. Optional zero-trust encrypted user share.
    link: /guides/accounts
---

<div class="vp-doc" style="max-width: 860px; margin: 48px auto 0; padding: 0 24px;">

## Five lines to a multi-chain account

```ts
const ika = new IkaPortal({ connection, signer, wallet, chains });
const { account } = await ika.createAccount({ owner, mode: 'enforced', userShare: 'public', policy: defaultPolicy() });

account.addresses; // { bitcoin: 'tb1q…', ethereum: '0x…', base: '0x…' }
await (await account.send({ chain: 'base', asset: 'USDC', to, amount: 25_000_000n })).wait();
```

::: warning Testnet / devnet only
This runs on the Ika Solana pre-alpha, which uses a single mock signer, not MPC. Don't hold real funds. See [Security & trust model](/security).
:::

</div>
