# API reference

All amounts are `bigint` in base units. `Chain = 'bitcoin' | 'ethereum' | 'base'`, `AssetSymbol = 'BTC' | 'ETH' | 'USDC'`.

## `@ika-portal/core`

### `new IkaPortal(options)`

| Option | Type | Notes |
| --- | --- | --- |
| `connection` | `Connection` | Solana RPC |
| `programId?` | `PublicKey` | Defaults to the IDL address (`Dx7P74…`) |
| `signer` | `SignerBackend` | `IkaPreAlphaSigner` (devnet) or `LocalMockSigner` (local) |
| `unlocker?` | `ShareUnlocker` | Required for `encrypted` accounts |
| `wallet?` | `TxSigner` | Owner signer `{ publicKey, signTransaction }`. Omit for instruction-building only |
| `feePayer?` | `TxSigner` | Pays for permissionless `approve_intent`. Default: `wallet` |
| `chains` | `{ bitcoin?, ethereum?, base? }` | See below |
| `relayerUrl?` | `string` | Delegated (gasless) EVM mode |
| `swap?` | `{ providers, fees, priority?, slippageBps? }` | See [Swaps](../guides/swaps.md) |
| `pollMs?` | `number` | Default 1000 |

`chains.bitcoin = { network: 'mainnet' | 'testnet' | 'regtest', backend: BitcoinBackend, explorer? }`
`chains.ethereum | base = { rpc, chainId, tokens?: { USDC: '0x…' }, implementation?, explorer? }`

Token addresses must also be in the program `Config` token list.

| Method | Returns |
| --- | --- |
| `init()` | `Promise<ConfigView>`. Loads the program Config; called lazily. Throws `DWalletProgramMismatch` if Config and signer disagree |
| `createAccount(args)` | `Promise<{ account, mnemonic?, recoveryKey?, dwallets }>`. Owner must be `wallet` |
| `prepareAccount(args)` | `Promise<{ account: PublicKey, transactions: TransactionInstruction[][], dwallets, mnemonic?, recoveryKey? }>`. For PDA owners |
| `loadAccount({ owner, index?, dwallets? })` | `Promise<IkaAccountHandle>` |
| `waitForAccount({ owner, index?, dwallets?, timeoutMs? })` | Polls until the account exists with dWallets registered |
| `accountAddress(owner, index?)` | `PublicKey` |
| `program` | `IkaProgram` (low-level instruction builders) |

`CreateAccountArgs = { owner, mode, userShare, policy, index?, recovery?: { csvBlocks?, evmDelayS? }, onDWalletsCreated?(refs) }`

### `IkaAccountHandle`

| Member | Description |
| --- | --- |
| `address`, `owner`, `mode`, `policy` | Basics |
| `addresses` | `{ bitcoin?, ethereum?, base? }` |
| `view` | `AccountView`: decoded on-chain state (`userShare`, `dwallets`, `btcPubkey`, `evmAddress`, `recoveryPubkey`, `recoveryEvmAddress`, `csvBlocks`, `recoveryDelayS`, `pendingPolicy`, `pendingPolicyAt`, `spend`, `intentNonce`, `evmNonces`) |
| `dwallets` | `DWalletRef[]` passed at load/create |
| `refresh()` | Re-read on-chain state |
| `balances()` | `{ bitcoin: { BTC }, ethereum: { ETH, USDC }, base: { ETH, USDC } }` |
| `isDelegated(chain)` | Gasless mode set up on that chain |
| `prepareTransfer(kind, SendArgs)` | `PreparedIntent` with resolved params and `fee` |
| `checkPolicy(prepared)` | `PolicyResult` (off-chain preview) |
| `send(SendArgs)` | `IntentHandle` |
| `setupEvm(chain)` | `IntentHandle` (7702 setup through the relayer) |
| `cancelEvmRecovery(chain, deadlineS?)` | `IntentHandle` |
| `quoteSwap({ from, to, slippageBps? })` | `{ best, quotes, errors }` |
| `swap(quote)` | `SwapHandle { prepared, intent, wait(): Promise<SwapStatus> }` |
| `proposePolicy(p)` / `applyPolicy()` / `cancelPolicy()` | Send the respective instruction |
| `intent(pubkey)` | Resume an `IntentHandle` |
| `cancelIntent(pubkey)` | Owner cancels a proposed intent |
| `listIntents()` | `[{ publicKey, account }]`, newest first (raw Anchor objects; decode with `decStatus`, `decKind`, `decChain`, `decAddress`) |
| `nextIntentAddress()` | PDA the next proposal will create |
| `instructions.*` | `send`, `swap`, `setupEvm`, `cancelEvmRecovery`, `cancelIntent`, `proposePolicy`, `applyPolicy`, `cancelPolicy`, `setEvmNonce`. Each returns `TransactionInstruction[]` |

`SendArgs = { chain, asset, to, amount, evmMode?: 'direct' | 'delegated', deadlineS? }`

`PolicyResult = { ok: true, delayed, executableAt } | { ok: false, error, message }`

### `IntentHandle`

| Member | Description |
| --- | --- |
| `intent` | Intent PDA |
| `progress()` | `AsyncGenerator<ProgressEvent>` |
| `wait()` | `Promise<{ intent, solanaTx?, destinationTx?, destinationTxUrl? }>` |
| `signOnly()` | `Promise<SignedIntent>`: `{ preimages, digests, signatures, rawTransaction?, solanaTx }`. No broadcast |
| `status` | Last status |

`ProgressEvent = { status, intent?, executableAt?, solanaTx?, destinationTx?, destinationTxUrl?, instructions?, error? }`
Statuses: `building`, `awaiting_owner`, `proposed`, `delayed`, `approved`, `signed`, `broadcast`, `confirmed`, `cancelled`, `failed`.

### Helpers

| Export | Purpose |
| --- | --- |
| `defaultPolicy(overrides?)` | Sensible defaults (no limits, swaps on, 50k sat / 0.005 ETH fee caps, 1-day change delay) |
| `previewPolicy(policy, spend, input)` | Off-chain policy evaluation |
| `keypairSigner(kp)` | `Keypair` → `TxSigner` |
| `sendInstructions(connection, ixs, feePayer, signers?)` | Send + confirm, errors decoded to `IkaPortalError` |
| `upsertConfig(connection, admin, ConfigInput)` | Create/update the program Config (admin) |
| `deriveRecoverableKeys(mnemonic, network)`, `newRecoveryKey()` | Key utilities |
| `IkaPortalError` | `.code`, `.message`, `.logs?` |
| `decodeProgramError(e)`, `programErrors()` | Map raw errors / list program error codes |
| `IkaProgram` | Low-level: PDAs (`accountPda`, `intentPda`, `claimPda`, `configPda`), instruction builders, `previewDigests` |
| `buildFromIntent(ctx, account, intent)` | Rebuild preimages from an on-chain intent (advanced) |
| `chainNow(ctx)` | Solana Clock unix time |

## `@ika-portal/signer`

### `SignerBackend`

```ts
interface SignerBackend {
  kind: 'local-mock' | 'ika-pre-alpha';
  dwalletProgramId: PublicKey;
  identity: PublicKey;                      // stored as the account's ika_user
  createDkgDwallet(curve, userShare, { authority, unlock?, domain? }): Promise<DWalletRef>;
  importKeyDwallet(privateKey, curve, userShare, opts): Promise<DWalletRef>;
  transferOwnership(dwallet, newAuthority): Promise<void>;
  publicKey(dwallet): Promise<Uint8Array>;
  sign(dwallet, { approval, message, scheme, approvalTx, approvalSlot? }, unlock?): Promise<Uint8Array>; // 64-byte r‖s
}
```

| Class | Options |
| --- | --- |
| `IkaPreAlphaSigner` | `{ connection, identity: Keypair, grpcUrl?, programId?, transport?: 'node' \| 'web', commitTimeoutMs? }`. Also exposes `gasDeposit()` and `close()` |
| `LocalMockSigner` | `{ connection, payer: Keypair, programId?, store?: MockKeyStore, commitSignatures? }`. Also exposes `ensureInitialized()`. Keys stay in memory or `store` |
| `SolanaSignatureUnlocker` | `new SolanaSignatureUnlocker(signMessage)` |
| `PasskeyUnlocker` | `{ credentialId, rpId?, evaluatePrf? }` (experimental) |

Ika program helpers: `dwalletPda`, `messageApprovalPda`, `parseDWallet`, `parseMessageApproval`, `transferOwnershipIx`, `IKA_DEVNET_PROGRAM_ID`, `IKA_DEVNET_GRPC`.

## `@ika-portal/chains`

| Namespace | Highlights |
| --- | --- |
| `evm` | `evmKeyInfo`, `evmCall`, `executeSignable`, `initSignable`, `cancelRecoverySignable`, `authorizationSignable`, `eip1559Tx`, `eip1559Signable`, `toEvmSignature`, `EvmAdapter` (balances, nonces, `delegation`, `ikaNonce`, `recoveryState`), `RelayerClient`, `ikaAccountAbi`, `ikaAccountBytecode` |
| `btc` | `lockAddress`, `addressToScript`, `recoveryWitnessScript`, `planSpend`, `bip143Preimages`, `btcSignables`, `unsignedTx`, `toBitcoinSignature`, `finalizeTx`, `selectCoins`, `BitcoindRpcBackend`, `EsploraBackend` |
| `recovery` | `recovery.bitcoin.buildRecoveryTx`, `recovery.evm.initiateRecovery`, `recovery.evm.recoveryExecute` |
| constants | `USDC` (mainnet + testnet addresses), `DECIMALS`, `NATIVE` |

`BitcoinBackend` (implement it for your own indexer): `utxos(address)`, `feeRate()`, `broadcast(hex)`, `tx(txid)`, `tipHeight()`.

## `@ika-portal/swap`

`SwapRouter`, `NearIntentsProvider`, `RelayProvider`, `LifiProvider`, `MockSwapProvider`, `createNearIntentsProxyHandler`, `assertOwnAddresses`, and the `SwapProvider` interface (`quote`, `prepare`, `submitDeposit?`, `status`, `supportsFees`). See [Swaps](../guides/swaps.md).

## `@ika-portal/relayer`

`createRelayer({ privateKey, chains: { [chainId]: { rpc, implementation } }, rateLimitPerMinute? })` → `{ address, handle(req, res), listen(port, host?) }`.
