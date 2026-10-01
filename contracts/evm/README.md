# contracts/evm — IkaAccount

`IkaAccount.sol` is the EIP-7702 delegate for Ika dWallet EOAs. The EOA delegates its
code to one shared `IkaAccount` deployment; every privileged action is authorized by an EIP-712 signature that
recovers to `address(this)` (the EOA itself), so a relayer can submit it and pay gas.

## Layout

| Path | Purpose |
| --- | --- |
| `src/IkaAccount.sol` | The delegate contract |
| `test/IkaAccount.t.sol` | Foundry suite (uses Prague 7702 cheatcodes `signDelegation` / `attachDelegation`) |
| `test/mocks/Mocks.sol` | `MockERC20`, `Reverter`, `Target`, `Reentrant` |
| `script/Deploy.s.sol` | Deploys the implementation (no constructor args) |
| `scripts/export-artifact.mjs` | Regenerates `packages/chains/src/evm/ikaAccountArtifact.ts` |

Toolchain: Foundry, solc 0.8.28, `evm_version = "prague"`. forge-std is vendored in `lib/forge-std`.

```sh
forge build
forge test          # add -vv to see the test-vector logs
```

## Spec

EIP-712 domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with
`name = "IkaAccount"`, `version = "1"`, `chainId = block.chainid`, `verifyingContract = address(this)` (the EOA).
The domain separator is computed on every call (never cached), because the same code runs at many addresses.

| Struct | Type string |
| --- | --- |
| Execute | `Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)` (`data` hashed as `keccak256(data)`) |
| Init | `Init(address recoveryKey,uint256 recoveryDelay)` |
| CancelRecovery | `CancelRecovery(uint256 nonce,uint256 deadline)` |

Digest = `keccak256(0x1901 ‖ domainSeparator ‖ structHash)`.

Signatures: 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}` (0/1 accepted and normalized). High-s (`s > n/2`) is rejected,
as is an `ecrecover` result of `address(0)`.

| Function | Caller | Behavior |
| --- | --- | --- |
| `initialize(recoveryKey, recoveryDelay, sig)` | anyone | Once only. `sig` over `Init` from the EOA. If `recoveryKey != 0`, `recoveryDelay > 0` |
| `execute(to, value, data, deadline, sig)` | anyone (relayer) | Initialized; sig over `Execute` at the current nonce; `block.timestamp <= deadline`; nonce++ before the call; bubbles revert data |
| `initiateRecovery()` | `recoveryKey` | `recoveryReadyAt = now + recoveryDelay` (calling again restarts the timer) |
| `cancelRecovery(deadline, sig)` | anyone | Initialized; sig over `CancelRecovery` at the current nonce; deadline; nonce++; `recoveryReadyAt = 0` |
| `recoveryExecute(to, value, data)` | `recoveryKey` | Only when `recoveryReadyAt != 0 && now >= recoveryReadyAt`; stays active after use |
| `nonce()`, `recoveryState()` | view | `recoveryState()` returns `(recoveryKey, recoveryDelay, recoveryReadyAt, initialized)` |
| `domainSeparator()`, `hashExecute(...)`, `hashInit(...)`, `hashCancelRecovery(...)` | view | Digest helpers for parity tests |
| `isValidSignature(hash, sig)` | view | ERC-1271: `0x1626ba7e` if `sig` over the raw `hash` recovers to the EOA, else `0xffffffff` |

Also: `receive()`, `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`, `supportsInterface`.

Errors: `InvalidSignature`, `Expired`, `AlreadyInitialized`, `NotInitialized`, `NotRecoveryKey`,
`RecoveryNotReady`, `InvalidRecoveryDelay`, `CallFailed` (only when the callee reverts with empty data; otherwise
the callee's revert data is bubbled verbatim).

Events: `Initialized(recoveryKey, recoveryDelay)`, `Executed(nonce, to, value, data)` (nonce = the one consumed),
`RecoveryInitiated(readyAt)`, `RecoveryCancelled(nonce)` (nonce = the one consumed), `RecoveryExecuted(to, value, data)`.

### Storage (ERC-7201)

Namespace `ika.account.storage.v1`:

```
slot = keccak256(abi.encode(uint256(keccak256("ika.account.storage.v1")) - 1)) & ~bytes32(uint256(0xff))
     = 0x10dce290ee6a5ccb456adea9a31119a94bdce8f84b9abcd1d30b488166565d00
```

| Slot | Field |
| --- | --- |
| `slot + 0` | `bool initialized` (byte 0), `address recoveryKey` (bytes 1..20) |
| `slot + 1` | `uint256 recoveryDelay` |
| `slot + 2` | `uint256 nonce` |
| `slot + 3` | `uint256 recoveryReadyAt` |

### Security notes

- The EOA key (the dWallet) can still send raw transactions from the EOA. Accepted by design: the dWallet only signs
  what the Solana policy approves.
- `execute` consumes the nonce before the external call, so a re-entrant call cannot replay the signature
  (`test_execute_reentrancyCannotReplay`).
- `initialize` cannot be front-run: the `Init` signature is bound to the EOA address and chain id through the domain.
- `cancelRecovery` consumes the shared nonce, so any `Execute` signed at the old nonce is invalidated.

## Test vectors

`forge test --mt test_knownVectors -vv` prints these. They are pinned in the test and were reproduced with
`cast keccak` / `cast abi-encode`. Account `0x1111111111111111111111111111111111111111`, chainId `31337`:

| Item | Value |
| --- | --- |
| domainSeparator | `0x92e4c6e5bbda3c3ddbe213605c97bef4e00bdb62d2bc3dfb79e20f37e5808f99` |
| `Execute(to=0x2222…2222, value=1 ether, data=0x, nonce=0, deadline=1700000000)` digest | `0x1f00b6a1ffc9240c0b8595df34ee26502762a951ea2e6c257bb01f551c65249e` |
| `Init(recoveryKey=0x3333…3333, recoveryDelay=259200)` digest | `0x503b07cf428298c95c086409b5f51c4938437ed7a4a4a4da3bd3ea9e2094c99b` |
| `CancelRecovery(nonce=5, deadline=1700000000)` digest | `0xcb0d63fd68c7873cdfe141c7164be121db356b5f8364d5ed4fccf5561f22e1b2` |

viem equivalent:

```ts
hashTypedData({
  domain: { name: 'IkaAccount', version: '1', chainId: 31337, verifyingContract: '0x1111111111111111111111111111111111111111' },
  types: { Execute: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ] },
  primaryType: 'Execute',
  message: { to: '0x2222222222222222222222222222222222222222', value: 10n ** 18n, data: '0x', nonce: 0n, deadline: 1700000000n },
}) // => 0x1f00b6a1ffc9240c0b8595df34ee26502762a951ea2e6c257bb01f551c65249e
```

## Deploy

The implementation has no constructor args and no owner. One deployment per chain serves every account.

```sh
# Local anvil (Prague is required for EIP-7702)
anvil --hardfork prague
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast

# Sepolia
forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL --private-key $PK --broadcast \
  --verify --etherscan-api-key $ETHERSCAN_API_KEY

# Base Sepolia
forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PK --broadcast \
  --verify --etherscan-api-key $BASESCAN_API_KEY
```

(The anvil key above is anvil's default account 0. Drop `--verify` if you have no explorer API key.) The script
logs `IkaAccount deployed at: 0x…`; put that address in the SDK/relayer chain config.

## TypeScript artifact

`packages/chains/src/evm/ikaAccountArtifact.ts` exports `ikaAccountAbi` (a viem-friendly `as const` ABI) and
`ikaAccountBytecode` (creation bytecode). Regenerate it after changing the contract:

```sh
forge build && node scripts/export-artifact.mjs
```

The build uses `bytecode_hash = "none"` and `cbor_metadata = false`, so the bytecode is reproducible.
