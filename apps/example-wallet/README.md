# Ika Portal example wallet

A Vite + React + Tailwind wallet that exercises the Ika Portal SDK on Solana devnet with the Ika pre-alpha, Bitcoin testnet4, Ethereum Sepolia and Base Sepolia. It's a demo, not a product: no mainnet, no real funds.

```bash
pnpm install
pnpm --filter @ika-portal/example-wallet dev        # http://localhost:5173
pnpm --filter @ika-portal/example-wallet build      # tsc --noEmit + vite build → dist/
pnpm --filter @ika-portal/example-wallet typecheck
```

Connect a Wallet Standard wallet (Phantom, Solflare, Backpack, ...) set to **devnet**, with some devnet SOL for transaction fees.

## Screens

| Screen | What it does |
| --- | --- |
| Create | Pick the key mode and user share, and set a policy. Runs Ika DKG from the browser (gRPC-web), then the wallet signs the create/register transactions. The recovery key (or mnemonic) is shown once, and you tick "I saved it" to continue. |
| Account | Shows addresses with copy buttons, balances, and the policy summary. A pending policy change gets a live countdown and an Apply button. Each EVM chain shows whether it is delegated, with an "Enable gasless (7702)" button when a relayer is configured. |
| Send | Runs `prepareTransfer` + `checkPolicy` live, so the policy result (allowed, delayed, or blocked with a reason) and the fee show before you submit. A stepper follows the `progress()` events. |
| Swap | Quotes from every configured provider: output, minimum, fees and whether each quote is executable. The best quote is preselected. Execute starts a policy-checked `swap` intent, then shows the provider's status. |
| Activity | Lists `listIntents()` with status, a delay countdown, the Solana approval tx and the destination tx (when this browser saw it). Resume re-runs `acct.intent(pk)` (approve, then sign, then broadcast). Proposed intents can be cancelled. |
| Recovery | Only for `enforced_recovery` accounts. **Bitcoin CSV:** build a transaction for the CSV branch and broadcast it. **EVM:** `initiateRecovery`, `recoveryExecute`, and a dWallet-signed cancel. |

## Environment

Copy `.env.example` to `.env.local`. Every variable is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_SOLANA_RPC` | `https://api.devnet.solana.com` | Solana RPC. The public endpoint is rate limited. |
| `VITE_PROGRAM_ID` | `Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje` | `ika_account` program |
| `VITE_IKA_DWALLET_PROGRAM_ID` | `87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY` | Ika pre-alpha dWallet program. Must match the program Config. |
| `VITE_IKA_GRPC_URL` | SDK default (`pre-alpha-dev-1.ika.ika-network.net`) | Ika gRPC-web endpoint |
| `VITE_RELAYER_URL` | – | Relayer for delegated (7702) EVM mode, setup and recovery cancel. Without it, EVM sends use direct mode. |
| `VITE_ESPLORA_URL`, `VITE_BTC_EXPLORER` | mempool.space testnet4 | Bitcoin backend and explorer |
| `VITE_SEPOLIA_RPC`, `VITE_BASE_SEPOLIA_RPC` | publicnode / sepolia.base.org | EVM RPCs |
| `VITE_NEAR_PROXY_URL` | – | Adds `NearIntentsProvider`. It gives mainnet dry quotes only and isn't executable on testnets. |
| `VITE_MOCK_DEPOSIT_BTC`, `VITE_MOCK_DEPOSIT_EVM` | the account's own addresses | Deposit addresses for the demo swap provider. The defaults mean no funds leave the account. |
| `VITE_INTEGRATOR_FEE_RECIPIENT`, `VITE_INTEGRATOR_FEE_BPS` | `0x…dEaD`, `30` | Integrator fee passed to the swap router |

The demo swap provider (`MockSwapProvider`, id `mock`) quotes BTC/USDC at 60000, ETH/USDC at 3000 and BTC/ETH at 20. Its payout only logs to the console and returns a fake hash.

## What the browser stores

Everything is in `localStorage`, and nothing stored is a secret that can move funds:

- **Ika session key.** An Ed25519 keypair generated once per browser. `IkaPreAlphaSigner` uses it to authenticate gRPC requests, and accounts record it as their `ika_user`. It can't move funds, because every Ika signature needs an on-chain approval from the account's policy program. Export and import it from the header to use an account in another browser.
- **dWallet references** (`DWalletRef[]`) per program, owner and index. They hold public keys, the Ika attestation, the DKG session and, for encrypted accounts, the encrypted user share. `IkaPreAlphaSigner` needs them to sign, so an account created in another browser can't sign here until you copy them over.
- A list of recent accounts, UI preferences, and destination tx hashes per intent (for Activity).

Mnemonics and recovery keys are never stored. The Recovery forms keep the key in component state only.

## Squads vault owners

Turn on **Owner is a Squads vault** in the header and paste the vault address. The vault is a PDA, so it owns the account and the connected wallet only pays for permissionless steps (approving intents, applying a policy). Owner actions aren't signed. The app shows the instructions for a Squads vault transaction instead: program id, each account with its signer/writable flags, and base64 data, plus **Copy JSON** (an array of transactions, each an array of `{ programId, keys, data }`).

- **Create.** `ika.prepareAccount()` runs Ika DKG with the vault as the dWallet authority and saves the dWallet refs. It then shows the transactions in order: `create_account`, then `transfer_ownership` + `register_dwallet` for each dWallet (each pair must be one vault transaction). User share is forced to `public`, since PDA owners can't use `encrypted`. Once the vault has executed them all, **Continue** calls `ika.waitForAccount()`.
- **Send and 7702 setup.** `account.instructions.send()` / `.setupEvm()` build the `propose_intent` instruction. The app records the intent PDA it will create (`account.nextIntentAddress()`) before showing the instructions. Once the vault executes the proposal, **Continue** calls `account.intent(pda)`, which waits for the intent, approves it (after any policy delay), has Ika sign, and broadcasts, all shown in the progress stepper.
- **Policy.** `instructions.proposePolicy()` / `.cancelPolicy()` produce vault instructions. `applyPolicy()` is permissionless, so the connected wallet sends it.
- **Cancel intent.** In Activity, `instructions.cancelIntent(pk)`.

This demo doesn't wire up swaps or the dWallet-signed EVM recovery cancel for vault owners, because the SDK has no `instructions.*` builder for them yet.

## Notes

- **Recoverable accounts** fail on devnet with `Unsupported`. The Ika pre-alpha's imported-key flow ignores the supplied key, so they only work with `LocalMockSigner`.
- **Program errors** show as `IkaPortalError` code + message, e.g. `LimitExceeded`, `RecipientNotAllowed` or `NotExecutableYet`, with program logs when there are any.
- **Browser bundling.** `src/polyfills.ts` installs `Buffer` / `process` / `global` before the app loads. `@grpc/grpc-js`, which only the signer's Node transport uses, is aliased to a stub. `@ika.xyz/pre-alpha-solana-client/grpc-web` ships raw `.ts` and is pre-bundled through `optimizeDeps.include`. For `tsc`, `tsconfig.json` maps it to `packages/signer/types/ika-client-grpc.d.ts` to get around an upstream type error.
