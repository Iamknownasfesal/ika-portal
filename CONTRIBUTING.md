# Contributing

## Setup

Requires Rust (stable), Anchor 1.2, Solana CLI 4.x, Foundry, Bitcoin Core, Node 24 and pnpm.

```bash
pnpm install
pnpm build:programs     # anchor build + sync the IDL into packages/core
```

## Checks (run before opening a PR)

```bash
pnpm test:programs      # Solana program (LiteSVM)
pnpm test:contracts     # IkaAccount.sol (Foundry)
pnpm typecheck
pnpm test               # unit
pnpm test:e2e           # local validator + anvil + bitcoind
pnpm docs:build         # docs site; fails on dead links
```

## Local networks with Docker

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

## Guidelines

- The program is the authority: anything it signs must be computed on-chain from intent fields. Off-chain builders in `packages/chains` must stay byte-for-byte identical, and the parity suite (`tests/e2e/parity.test.ts`) enforces this.
- After changing program instructions or accounts, run `pnpm build:programs` and commit the synced IDL.
- Keep docs in `docs/` in sync with the API. `packages/core/test/docs-snippets.typecheck.ts` type-checks the main examples.
