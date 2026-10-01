# Getting started

This walkthrough creates an account on devnet, shows its Bitcoin and EVM addresses, and sends from it. You can run it as a Node script; see [Browser integration](guides/browser.md) for a web wallet.

## 1. Install

The packages live in this monorepo (not yet published to npm). From a workspace package:

```json
{
  "dependencies": {
    "@ika-portal/core": "workspace:*",
    "@ika-portal/signer": "workspace:*",
    "@ika-portal/chains": "workspace:*",
    "@ika-portal/swap": "workspace:*",
    "@solana/web3.js": "^1.99"
  }
}
```

The packages ship TypeScript source. Run scripts with `tsx`, or bundle with Vite/esbuild.

## 2. Configure the client

```ts
import { Connection, Keypair } from '@solana/web3.js';
import { IkaPortal, keypairSigner, defaultPolicy } from '@ika-portal/core';
import { IkaPreAlphaSigner } from '@ika-portal/signer';
import { btc, USDC } from '@ika-portal/chains';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const owner = Keypair.fromSecretKey(/* the user's Solana key, or use a wallet adapter */);

const ika = new IkaPortal({
  connection,
  // Talks to the Ika network. `identity` is an Ed25519 key used to authenticate
  // gRPC requests; it cannot move funds by itself (every signature needs an
  // on-chain approval). A per-install session key is fine.
  signer: new IkaPreAlphaSigner({ connection, identity: Keypair.generate() }),
  // Signs owner instructions. In a browser: { publicKey, signTransaction } from the wallet adapter.
  wallet: keypairSigner(owner),
  chains: {
    bitcoin: { network: 'testnet', backend: new btc.EsploraBackend('https://mempool.space/testnet4/api') },
    ethereum: { rpc: 'https://ethereum-sepolia-rpc.publicnode.com', chainId: 11155111, tokens: { USDC: USDC.sepolia } },
    base: { rpc: 'https://sepolia.base.org', chainId: 84532, tokens: { USDC: USDC.baseSepolia } },
  },
});
```

The owner wallet needs a little devnet SOL: about 0.03 SOL of rent per account, plus a few thousand lamports per transaction.

## 3. Create an account

```ts
const { account, recoveryKey, dwallets } = await ika.createAccount({
  owner: owner.publicKey,
  mode: 'enforced_recovery',
  userShare: 'public',
  policy: defaultPolicy(),
  recovery: { csvBlocks: 6, evmDelayS: 3600 },
});

console.log(account.addresses);
// { bitcoin: 'tb1q…', ethereum: '0x…', base: '0x…' }  (Ethereum and Base share one EVM address)
```

This runs Ika DKG (about 5–10 s), creates the on-chain account, hands the new dWallet to the program, and registers it.

Two things to do right away:

1. **Show `recoveryKey` (or `mnemonic` in `recoverable` mode) to the user once.** The SDK never stores it. See [Creating accounts](guides/accounts.md).
2. **Persist `dwallets`** next to the account (e.g. keyed by `owner + index`). `IkaPreAlphaSigner` needs these refs to sign later. They hold no plaintext secrets.

Later sessions load the account instead of creating it:

```ts
const account = await ika.loadAccount({ owner: owner.publicKey, index: 0, dwallets: savedRefs });
```

## 4. Fund and send

Send some testnet coins to `account.addresses.*`, then:

```ts
const intent = await account.send({ chain: 'ethereum', asset: 'ETH', to: '0xRecipient…', amount: 10n ** 15n });

for await (const e of intent.progress()) {
  console.log(e.status, e.destinationTxUrl ?? '');
}
// building → proposed → approved → signed → broadcast → confirmed
```

Amounts are always `bigint` in base units (sats, wei, USDC 6-decimals).

What happened:

1. The owner signed a `propose_intent`, and the program checked policy.
2. Anyone (your fee payer) sent `approve_intent`. The program computed the transaction digest itself and approved it on Ika.
3. Ika signed it, and the SDK assembled and broadcast the Ethereum transaction.

## 5. Handle errors

```ts
import { IkaPortalError } from '@ika-portal/core';

try {
  await (await account.send(args)).wait();
} catch (e) {
  if (e instanceof IkaPortalError) {
    // e.code: 'LimitExceeded' | 'RecipientNotAllowed' | 'FeeTooHigh' | 'ShareLocked' | …
    showToUser(e.code, e.message);
  }
}
```

All codes are listed in [Errors](reference/errors.md).

## Next

- Preview policy before the user confirms: [Sending](guides/sending.md#preview-the-policy-result)
- Add swaps with your integrator fee: [Swaps](guides/swaps.md)
- Make EVM sends gasless: [Gasless EVM](guides/evm-gasless.md)
- Run everything locally without devnet: [FAQ](faq.md#can-i-develop-without-devnet)
