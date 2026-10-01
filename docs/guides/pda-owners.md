# Squads and other PDA owners

Any Solana pubkey can own an account, including a **Squads v4 vault**, a passkey smart wallet or another program. A PDA can't sign a transaction directly, so the SDK gives you the instructions and the owner executes them (for example inside a Squads vault transaction). Everything after the owner's step (approval, Ika signing, broadcast) is permissionless, and the SDK continues it.

Rules:

- PDA owners must use `userShare: 'public'`. The program rejects `encrypted` because a PDA has no device to unlock a share.
- The owner (vault) pays rent for its own account and intents, so keep about 0.05–0.1 SOL in the vault.

## Create an account owned by a vault

```ts
const prepared = await ika.prepareAccount({
  owner: vaultPda,
  mode: 'enforced',
  userShare: 'public',
  policy: defaultPolicy(),
});
// prepared.transactions: TransactionInstruction[][] — run each inner array as ONE vault transaction, in order:
//   [create_account]
//   [transfer_ownership, register_dwallet]   (one per dWallet; must stay together)
// prepared.dwallets: persist these
```

The dWallet is created with **authority = vault**. Only a vault transaction can hand it to the program, and the hand-off and registration happen atomically.

Then wait for it:

```ts
const account = await ika.waitForAccount({ owner: vaultPda, dwallets: prepared.dwallets });
```

## Send from a vault-owned account

```ts
const intentPda = account.nextIntentAddress();   // capture BEFORE building
const ixs = await account.instructions.send({ chain: 'ethereum', asset: 'ETH', to, amount });
// → execute `ixs` as a vault transaction (propose, approve by members, execute)
await account.intent(intentPda).wait();          // SDK takes over at approve_intent
```

Or use `account.send(...)` directly. Its `progress()` emits `awaiting_owner` with `e.instructions`, then polls until the vault executes them and continues on its own.

Other builders: `instructions.setupEvm(chain)`, `instructions.swap(prepared)`, `instructions.cancelEvmRecovery(chain)`, `instructions.cancelIntent(pk)`, `instructions.proposePolicy(p)`, `instructions.applyPolicy()`, `instructions.cancelPolicy()`, `instructions.setEvmNonce(chain, n)`.

## Example with the Squads SDK

```ts
import * as multisig from '@sqds/multisig';
import { TransactionMessage } from '@solana/web3.js';

async function vaultExec(instructions) {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const transactionMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions,
  });
  await multisig.rpc.vaultTransactionCreate({ connection, feePayer: member, multisigPda, transactionIndex,
    creator: member.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage });
  await multisig.rpc.proposalCreate({ connection, feePayer: member, multisigPda, transactionIndex, creator: member });
  await multisig.rpc.proposalApprove({ connection, feePayer: member, multisigPda, transactionIndex, member });
  // …other members approve…
  await multisig.rpc.vaultTransactionExecute({ connection, feePayer: member, multisigPda, transactionIndex,
    member: member.publicKey, signers: [member] });
}
```

`scripts/squads-devnet.ts` runs this whole flow on devnet. Executing a vault transaction that creates an account can need more than 200k compute units, so add a `ComputeBudgetProgram.setComputeUnitLimit` instruction when you execute.

## In a UI

When the owner is a vault, show the instructions instead of asking for a signature. Include the program id, each account with its signer/writable flags, and base64 data, plus copyable JSON. Members can then paste them into the Squads app. `apps/example-wallet` has an "Owner is a Squads vault" toggle that does exactly this.

## Your own program as owner

A program can own accounts by signing with one of its PDAs (`invoke_signed`). Build the instructions with the SDK, then CPI them from your program with the PDA as signer. `programs/test_cpi_owner` is a minimal example.
