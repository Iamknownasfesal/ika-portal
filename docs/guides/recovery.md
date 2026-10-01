# Recovery

Each mode has a different answer to "what if Ika, the program or the wallet is gone?" The recovery tools in `@ika-portal/chains` run **offline**, with no Ika and no Solana.

## `recoverable`: restore the mnemonic anywhere

The 12-word phrase uses standard paths, so any wallet restores the same addresses:

| Chain | Path | Address type |
| --- | --- | --- |
| Bitcoin | `m/84'/0'/0'/0/0` mainnet, `m/84'/1'/0'/0/0` test networks | P2WPKH (BIP84) |
| EVM | `m/44'/60'/0'/0/0` | Standard EOA |

```ts
import { deriveRecoverableKeys } from '@ika-portal/core';
const keys = deriveRecoverableKeys(mnemonic, 'testnet'); // { btc, evm } private keys
```

Note that the mnemonic **bypasses all policies**. That's the trade-off of this mode.

## `enforced_recovery`: Bitcoin CSV branch

Coins sit in a P2WSH script:

```
OP_IF <dwallet_pubkey> OP_CHECKSIG
OP_ELSE <csv_blocks> OP_CHECKSEQUENCEVERIFY OP_DROP <recovery_pubkey> OP_CHECKSIG
OP_ENDIF
```

Each UTXO becomes spendable with the recovery key `csvBlocks` after it confirms.

```ts
import { recovery, btc } from '@ika-portal/chains';

const { hex, txid } = await recovery.bitcoin.buildRecoveryTx({
  recoveryKey: hexToBytes(recoveryKey.privateKey),         // 32 bytes
  account: {
    dwalletPubkey: account.view.btcPubkey!,                // or from your records
    recoveryPubkey: account.view.recoveryPubkey!,
    csvBlocks: account.view.csvBlocks,
    network: 'testnet',
  },
  to: 'tb1qDestination…',
  feeRate: 5,                                              // sat/vB
  backend: new btc.EsploraBackend('https://mempool.space/testnet4/api'),
});
await backend.broadcast(hex);
```

Only UTXOs with at least `csvBlocks` confirmations are spent; younger ones are left alone. Keep the account's two public keys and `csvBlocks` somewhere durable. With those and the recovery key, you can rebuild the script with no access to Solana.

## `enforced_recovery`: EVM recovery (delegated mode)

EVM recovery requires the account to be in [gasless mode](evm-gasless.md) on that chain, because the logic lives in `IkaAccount.sol`.

```ts
const args = { recoveryKey: '0x…', account: account.addresses.base!, rpc, chainId: 84532 };
const { readyAt } = await recovery.evm.initiateRecovery(args);   // starts the delay
// …after evmDelayS:
await recovery.evm.recoveryExecute({ ...args, to, value: 0n, data }); // any call, e.g. ERC-20 transfer
```

Transactions are sent from the recovery key's own address, which pays its own gas.

**The owner can cancel** a recovery they didn't start (for example, a stolen recovery key) through a dWallet-signed message. That's normal policy-governed signing:

```ts
await (await account.cancelEvmRecovery('base')).wait();
```

Show pending recoveries in your UI: `new evm.EvmAdapter(chain, cfg).recoveryState(address)` returns `{ recoveryKey, recoveryDelay, recoveryReadyAt, initialized }`.

## `enforced`

There is no recovery path. If Ika is permanently unavailable, funds can't move. Make sure users understand this before they choose the mode.
