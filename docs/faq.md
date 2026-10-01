# FAQ and troubleshooting

### Can I develop without devnet?
Yes. The easiest way is Docker: `pnpm stack:up` starts Solana (with the programs), two EVM chains, Bitcoin regtest and the relayer, and `pnpm test:e2e:docker` runs the suites against them. See [Operations](operations.md#local-networks-with-docker). Without Docker, `pnpm test:e2e` starts everything locally:
- `solana-test-validator` with `ika_account` and `mock_dwallet`;
- two Prague anvils standing in for Ethereum and Base;
- `bitcoind -regtest`;
- the relayer.

Use `LocalMockSigner` in place of `IkaPreAlphaSigner`, and point Config at `mock_dwallet`. See `tests/e2e/helpers.ts` for a complete setup.

### Do I need the EVM contract and relayer?
No. Direct mode works with neither: the dWallet address pays its own gas. Add the contract and relayer for gasless sends or EVM recovery. See [Gasless EVM](guides/evm-gasless.md).

### Why do Ethereum and Base show the same address?
It's the same secp256k1 key, so the EVM address is identical on every EVM chain. Balances and nonces are per chain.

### Which chains and assets are supported?
BTC (P2WPKH / P2WSH), native ETH, and the ERC-20s listed in Config (USDC by default) on Ethereum and Base. Solana assets stay in the owner's own Solana account.

### Can users bring an existing seed phrase?
Not on the pre-alpha: Ika's key import doesn't take key material yet. `recoverable` mode generates a new phrase and works with `LocalMockSigner` only, for now.

### How long does a send take?
- Ika DKG at account creation: about 5–10 s.
- Per intent: two Solana transactions plus an Ika presign + sign (a few seconds), then destination-chain confirmation.
- Delays from policy come on top of that.

### `DWalletNotFound` on load
The Ika pre-alpha devnet was reset. Create a new account. If you see it at sign time with a fresh account, the `DWalletRef` was missing its `session`: pass the refs returned by `createAccount` to `loadAccount`.

### `ShareLocked`
The account uses an encrypted share. Pass an `unlocker` built from the **same** wallet that created the account.

### `NotExecutableYet`, or a send sits in `delayed`
A delay threshold applies. The SDK waits on the Solana clock (which can lag wall time on local validators) and approves automatically.

### `FeeTooHigh` for EVM direct
`gas × maxFeePerGas` exceeds `policy.maxEvmFeeWei`. Fees spiked or the cap is too low: raise the cap with a policy change, or use delegated mode.

### `429 Too Many Requests`
The public Solana devnet RPC rate-limits. Use a dedicated RPC and/or increase `pollMs`.

### A delegated send failed at the relayer with "simulation reverted"
Usually a nonce drift (an approved `execute` that was never submitted) or an expired deadline. Resync with `instructions.setEvmNonce`; see [Gasless EVM](guides/evm-gasless.md#nonces).

### The browser build fails on `@grpc/grpc-js`, `Buffer` or `.ts` in `node_modules`
Follow [Browser integration](guides/browser.md): load the polyfills first, alias `@grpc/grpc-js` to a stub, and pre-bundle the Ika client.

### Where can I see a complete integration?
- `apps/example-wallet`: React app with every screen.
- `scripts/devnet-e2e.ts`: Node, real Ika.
- `scripts/squads-devnet.ts`: Squads.
- `tests/e2e/*.test.ts`: every flow.
