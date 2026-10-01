# Creating accounts

## createAccount

```ts
const created = await ika.createAccount({
  owner: wallet.publicKey,     // must be the connected wallet; for PDAs see prepareAccount
  index: 0,                    // optional, default 0 — lets one owner hold several accounts
  mode: 'enforced',            // 'recoverable' | 'enforced' | 'enforced_recovery'
  userShare: 'public',         // 'public' | 'encrypted'
  policy: defaultPolicy(),
  recovery: { csvBlocks: 6, evmDelayS: 3600 }, // enforced_recovery only
  onDWalletsCreated: (refs) => save(refs),     // recommended, see below
});
// → { account, mnemonic?, recoveryKey?, dwallets }
```

What happens:

1. **Key creation.**
   - `enforced*`: one DKG dWallet (role `both`).
   - `recoverable`: a fresh 12-word mnemonic; the BTC and EVM keys are imported as two dWallets.

   Each dWallet starts with **authority = owner**.
2. **Tx 1:** `create_account`. It validates the policy and recovery params against the mode, and rejects `encrypted` + PDA owner.
3. **Tx 2 (per dWallet):** `transfer_ownership` (owner → program CPI PDA) **and** `register_dwallet` in one transaction. Registration creates a one-per-dWallet claim, so no one can register the same dWallet into another account between the two steps.

The owner signs 2 transactions for `enforced*` accounts and 3 for `recoverable` ones.

### Recovery parameters (`enforced_recovery`)

| Field | Default | Meaning |
| --- | --- | --- |
| `csvBlocks` | 4320 on mainnet (≈30 days), 6 on testnet/regtest | Each BTC UTXO becomes recoverable this many blocks after it confirms |
| `evmDelayS` | 7 days | `IkaAccount.initiateRecovery` → `recoveryExecute` delay (gasless mode) |

## What to show once

| Mode | Secret returned | What to do |
| --- | --- | --- |
| `recoverable` | `mnemonic` (12 words) | Show once, and require a "I saved it" confirmation before continuing. Restores in any BIP84/BIP44 wallet |
| `enforced_recovery` | `recoveryKey: { privateKey, publicKey }` (hex) | Show once / offer an encrypted export. Needed for offline recovery |
| `enforced` | none | — |

The SDK **never persists** these. Don't log them, and zero any copies you make.

## What to persist

`dwallets: DWalletRef[]`: serializable references that contain **no plaintext secrets**:

```ts
interface DWalletRef {
  address: string;        // dWallet account (base58)
  publicKey: string;      // 33-byte compressed key (hex)
  curve: 'secp256k1';
  imported: boolean;
  userShare: 'public' | 'encrypted';
  backend: 'local-mock' | 'ika-pre-alpha';
  session?: string;       // Ika DKG session (pre-alpha needs it to sign)
  attestation?: {...};    // Ika DKG attestation
  encryptedShare?: string;// encrypted user share (encrypted accounts)
  shareDomain?: {...};
}
```

Store them keyed by `(owner, index)` and pass them to `loadAccount`. Without them, `IkaPreAlphaSigner` can't sign for the account. `onDWalletsCreated` fires right after DKG, before any wallet prompt, so the refs survive if the user rejects a later signature.

## Loading

```ts
const account = await ika.loadAccount({ owner, index: 0, dwallets });
account.addresses;          // { bitcoin, ethereum, base }
account.view;               // decoded on-chain state (mode, policy, spend windows, nonces…)
await account.balances();   // { bitcoin: { BTC }, ethereum: { ETH, USDC }, base: { ETH, USDC } }
await account.refresh();    // re-read on-chain state
```

`loadAccount` throws `AccountNotFound` if the PDA doesn't exist, and `DWalletNotFound` if the dWallets were wiped (Ika pre-alpha devnet resets).

## Encrypted user share

```ts
import { SolanaSignatureUnlocker } from '@ika-portal/signer';

const ika = new IkaPortal({
  ...,
  unlocker: new SolanaSignatureUnlocker((msg) => wallet.signMessage(msg)),
});
await ika.createAccount({ owner, mode: 'enforced', userShare: 'encrypted', policy });
```

- The share key is derived from the owner's Ed25519 signature over a fixed, domain-separated message (deterministic, so it re-derives on any device with the same wallet).
- Every signature asks the wallet to `signMessage` once to unlock the share. Without the unlocker (or with a different key) signing fails with `ShareLocked`.
- `PasskeyUnlocker` (WebAuthn PRF) is available but experimental. Your authenticator must support the PRF extension.
- A PDA owner can't use `encrypted`; the program rejects it with `PdaOwnerRequiresPublicShare`.

## Several accounts per user

Use `index` to give a user separate accounts, for example "savings" with a strict policy and "spending" with a loose one:

```ts
await ika.createAccount({ owner, index: 1, mode: 'enforced', userShare: 'public', policy: strict });
ika.accountAddress(owner, 1); // PDA without fetching
```
