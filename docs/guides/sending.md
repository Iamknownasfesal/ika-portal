# Sending

```ts
const intent = await account.send({
  chain: 'base',              // 'bitcoin' | 'ethereum' | 'base'
  asset: 'USDC',              // 'BTC' | 'ETH' | 'USDC'
  to: '0xRecipient…',         // EVM 0x address or Bitcoin address
  amount: 25_000_000n,        // base units (USDC has 6 decimals)
  evmMode: 'direct',          // optional: 'direct' | 'delegated'
  deadlineS: 3600,            // optional: delegated-mode signature lifetime
});
await intent.wait();          // or iterate intent.progress()
```

## Preview the policy result

Show the user whether the send will pass before they sign:

```ts
const prepared = await account.prepareTransfer('send', { chain, asset, to, amount });
const check = account.checkPolicy(prepared);
if (!check.ok) {
  // check.error: 'LimitExceeded' | 'RecipientNotAllowed' | 'SwapsDisabled' | 'SwapLimitExceeded' | 'FeeTooHigh'
  showError(check.message);
} else if (check.delayed) {
  showInfo(`Needs a ${policy.delayS}s delay; approvable at ${new Date(check.executableAt * 1000)}`);
}
```

`prepareTransfer` resolves everything the intent needs: BTC UTXOs and fee, EVM nonce, gas and fee caps. `prepared.fee` holds the BTC fee in sats or the EVM max fee in wei. `account.send()` runs the same check and throws `IkaPortalError` before asking the wallet to sign. The program enforces policy again on-chain regardless.

## Progress events

```ts
for await (const e of intent.progress()) {
  switch (e.status) {
    case 'building':       // proposing (owner signs)
    case 'awaiting_owner': // PDA owner: e.instructions must be executed by the owner (see Squads guide)
    case 'proposed':       // policy passed
    case 'delayed':        // e.executableAt: unix seconds (Solana clock)
    case 'approved':       // e.solanaTx: approval transaction
    case 'signed':         // Ika signed
    case 'broadcast':      // e.destinationTx / e.destinationTxUrl
    case 'confirmed':
    case 'cancelled':
    case 'failed':         // e.error
  }
}
```

`wait()` resolves with `{ intent, solanaTx, destinationTx, destinationTxUrl }` or throws. `progress()` and `wait()` can both be used on the same handle; the flow runs only once.

## Who signs and pays

| Step | Signer | Fee payer |
| --- | --- | --- |
| `propose_intent` | owner (`wallet`) | `feePayer` (defaults to `wallet`); rent for the Intent PDA |
| `approve_intent` | anyone | `feePayer`. Rent for Ika `MessageApproval` accounts (~0.003 SOL each) |
| Destination tx | — | BTC: the account's UTXOs · EVM direct: the dWallet address · EVM delegated: your relayer |

Set `feePayer` to a wallet-owned hot key if you want to sponsor Solana fees for users.

## Bitcoin details

- Coin selection is largest-first, up to `Config.max_btc_inputs` (4), at the backend's fee rate. The fee must be within `policy.maxBtcFeeSats`.
- The transaction shape is fixed:
  - version 2, locktime 0, RBF sequence;
  - outputs `[recipient, change]`, with change going back to the account's own address;
  - change below 546 sats is added to the fee.
- The program builds the outputs itself, so change always returns to the account.

## EVM details

- **Direct:** the dWallet address pays gas and needs ETH. The fee cap is `gas × maxFeePerGas ≤ policy.maxEvmFeeWei`.
- **Delegated:** requires `setupEvm(chain)` and a relayer; the dWallet address needs no ETH. See [Gasless EVM](evm-gasless.md).
- Only native ETH and ERC-20s listed in the program `Config` (e.g. USDC) can be sent. Others fail with `UnknownAsset`.

## Resuming

Intents live on-chain, so a crash or reload doesn't lose them:

```ts
const intents = await account.listIntents();       // newest first: [{ publicKey, account: raw }]
await account.intent(intents[0].publicKey).wait(); // continues from where it stopped
```

Resuming an intent that was already broadcast is safe: the SDK recognizes "already known" responses for BTC and direct EVM transactions.

## Cancelling

A `proposed` intent (for example, one waiting on a delay) can be cancelled by the owner. This releases its spend-window usage:

```ts
await account.cancelIntent(intentPubkey);
```

## Broadcasting yourself

To use your own node or broadcaster:

```ts
const signed = await intent.signOnly();
// signed.rawTransaction — hex, ready to broadcast (BTC and EVM direct)
// signed.signatures / signed.digests / signed.preimages for anything else
```
