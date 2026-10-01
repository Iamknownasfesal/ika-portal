# Operations

What a wallet team runs on its own infrastructure.

## Components

| Component | Required? | Notes |
| --- | --- | --- |
| `ika_account` program | Yes | Use the shared devnet deployment, or deploy your own |
| Solana RPC | Yes | Use a dedicated endpoint; the public devnet RPC rate-limits |
| Bitcoin indexer | Yes for BTC | Any `BitcoinBackend`: Esplora (`EsploraBackend`), Bitcoin Core (`BitcoindRpcBackend`), or your own |
| EVM RPCs | Yes for EVM | Sepolia / Base Sepolia (mainnet later) |
| Relayer | Only for gasless EVM | `services/relayer`, plus a funded key per chain |
| `IkaAccount.sol` | Only for gasless EVM | One deployment per chain, set in Config |
| 1Click proxy | Only for NEAR swaps | Holds the partner JWT server-side |

## Deploying the program (your own instance)

```bash
anchor build && ./scripts/sync-idl.sh
solana program deploy -u devnet --program-id <your-keypair.json> target/deploy/ika_account.so
```

If you use your own program keypair, run `anchor keys sync` first so `declare_id!` matches, rebuild, and pass `programId` to `IkaPortal`. The program is about 390 KB, so a deploy needs about 2 SOL of rent plus an equal-sized temporary buffer.

**Initialize the Config in the same session as the deploy.** `initialize_config` makes its first caller the admin.

```ts
import { upsertConfig } from '@ika-portal/core';
import { IKA_DEVNET_PROGRAM_ID } from '@ika-portal/signer';
import { USDC } from '@ika-portal/chains';

await upsertConfig(connection, adminSigner, {
  dwalletProgram: IKA_DEVNET_PROGRAM_ID,   // or mock_dwallet for local tests
  btcNetwork: 'testnet',
  maxBtcInputs: 4,
  evmChains: [
    { chain: 'ethereum', chainId: 11155111, implementation: '0x…optional' },
    { chain: 'base', chainId: 84532, implementation: '0x…optional' },
  ],
  tokens: [
    { chain: 'ethereum', address: USDC.sepolia },
    { chain: 'base', address: USDC.baseSepolia },
  ],
}, programId);
```

Config changes take effect immediately for all accounts. Removing a chain or token stops new intents that use it (`UnknownChain` / `UnknownAsset`). Changing an `implementation` changes what future `evm_setup` intents authorize.

## Relayer

See [Gasless EVM](guides/evm-gasless.md#run-the-relayer). Production checklist:

- Put it behind authentication (your wallet session) and a gateway. The built-in rate limit is per account only.
- Monitor the relayer key's balance on every chain.
- Only add chains whose `implementation` matches the program Config.

## NEAR 1Click proxy

Deploy `createNearIntentsProxyHandler({ jwt, enforceAppFees })` on any fetch-style runtime (Workers, Next.js, Bun). See [Swaps](guides/swaps.md#keep-the-1click-jwt-on-your-server).

## Costs (Solana devnet, approximate)

| Item | SOL |
| --- | --- |
| Account (rent) | ~0.028 |
| dWallet claim (rent) | ~0.0011 per dWallet |
| Intent (rent) | ~0.004 |
| Ika MessageApproval (rent) | ~0.003 per digest (BTC: per input) |
| Transaction fees | 5,000 lamports per signature |

Rent is paid by `feePayer` (or by the vault, for PDA owners).

## Testing your integration

### Local networks with Docker

`docker/compose.yaml` runs every network the SDK talks to, so you don't need Solana, Foundry or Bitcoin Core installed:

| Service | Port | What |
| --- | --- | --- |
| `solana` | 8899 / 8900 | `solana-test-validator` (Agave 4.3) with `ika_account`, `mock_dwallet`, `test_cpi_owner` preloaded |
| `ethereum` | 8545 | Anvil, Prague hardfork, chain id 31337 |
| `base` | 8546 | Anvil, Prague hardfork, chain id 31338 |
| `bitcoind` | 18443 | Bitcoin Core 30 regtest (RPC `ika` / `ika`) |
| `relayer` | 8787 | EVM gas relayer for gasless (EIP-7702) mode |

```bash
pnpm build:programs     # the validator image bakes in target/deploy/*.so
pnpm stack:up           # docker compose up --build --wait
pnpm test:e2e:docker    # e2e suites from the host against the stack (rerunnable)
pnpm stack:down         # stop and wipe
```

To run the tests inside a container as well: `docker compose -f docker/compose.yaml --profile test run --rm tests`.

Apple Silicon: Anza only publishes x86_64 Linux validator binaries, and Agave 4.x needs io_uring, which emulation doesn't provide. So the `solana` image compiles Agave natively for arm64 on first build (roughly 20–40 minutes, cached afterwards). On x86_64 hosts it downloads the release binary.

### Real Ika signing, local chains

`pnpm test:hybrid` uses the **real Ika pre-alpha on Solana devnet** for DKG, approvals and signing, and broadcasts every resulting transaction to the **local Docker chains**:
- direct ETH sends;
- EIP-7702 setup and gasless USDC sends through the relayer;
- BTC P2WPKH and P2WSH sends;
- an Ika-signed `cancelRecovery`;
- the encrypted-share lock;
- a BTC → Base USDC swap.

It needs `pnpm stack:up` and a devnet keypair with about 0.2 SOL (it's also the program Config admin). It temporarily points the devnet Config at the local chain ids and restores it afterwards.

### Other test entry points

```bash
pnpm test:e2e                          # local validator + anvil + bitcoind; no devnet needed
pnpm tsx scripts/devnet-e2e.ts         # real Ika pre-alpha; BROADCAST=1 once addresses are funded
pnpm tsx scripts/squads-devnet.ts      # Squads v4 vault flow
```

## Pre-alpha operational notes

- **The Ika devnet is wiped periodically.** Detect `DWalletNotFound` on load and prompt users to recreate the account.
- `GasDeposit` funding isn't available yet (layouts unpublished), and isn't required on devnet today.
