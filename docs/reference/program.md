# Program reference: `ika_account`

Anchor 1.2 program. Devnet id `Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje`. The IDL is in `packages/core/src/idl/ika_account.json`.

## Accounts

| Account | Seeds | Contents |
| --- | --- | --- |
| `Config` | `["config"]` | admin, `dwallet_program`, BTC network, `max_btc_inputs`, EVM chains `{chain, chain_id, implementation}` (max 4), tokens `{chain, address}` (max 8) |
| `IkaAccount` | `["account", owner, index_u16_le]` | owner, index, mode, user_share, `ika_user`, dWallets (max 3), BTC pubkey + pkh, EVM address, recovery pubkey/EVM address, csv_blocks, recovery_delay_s, policy, pending policy, spend windows, intent nonce, EVM nonces |
| `Intent` | `["intent", account, nonce_u64_le]` | params, status, created_at, executable_at, bound EVM nonce, spend charges, approvals `{message_digest, final_digest, scheme, message_approval}` |
| `DWalletClaim` | `["claim", dwallet]` | Binds a dWallet to exactly one account |
| CPI authority | `["__ika_cpi_authority"]` | dWallet authority for every registered dWallet |

## Instructions

| Instruction | Signer | Effect |
| --- | --- | --- |
| `initialize_config(args)` | admin (first caller) | Create Config |
| `update_config(args)` | admin | Replace Config fields |
| `create_account(args)` | owner (+ payer) | Validate policy and recovery against the mode; reject encrypted + PDA owner |
| `register_dwallet(role, evm_pubkey_y)` | owner (+ payer) | Require authority = CPI PDA, secp256k1, Active; verify Y; create the claim |
| `propose_intent(params)` | owner (+ payer) | Validate, evaluate policy, record spend, set `executable_at` |
| `cancel_intent` | owner | proposed → cancelled; release spend |
| `approve_intent` | anyone | Require `now ≥ executable_at`; compute digests; CPI `approve_message` per digest (remaining accounts = MessageApproval PDAs) |
| `preview_digests(params, evm_nonce)` | none | Read-only; returns `Vec<{message_digest, final_digest, scheme}>` as return data |
| `propose_policy(policy)` | owner | Pending, effective at now + current `policy_change_delay_s` |
| `apply_policy` | anyone | After the delay |
| `cancel_policy` | owner | Clear the pending policy |
| `set_evm_nonce(chain_id, nonce)` | owner | Resync the IkaAccount nonce |

`IntentParams = { kind, chain, asset: [u8;20] (zero = native), to: bytes (EVM 20-byte address | BTC scriptPubKey ≤ 34), amount: u64, evm?: EvmParams, btc?: { inputs: [{txid (internal order), vout, value}] ≤ 4, fee } }`

`EvmParams = Direct { nonce, gas_limit, max_fee_per_gas, max_priority_fee_per_gas } | Delegated { deadline } | Setup { eoa_nonce } | CancelRecovery { deadline }`

## What gets signed

The program builds each **preimage**. Ika keys the approval by `keccak256(preimage)` and signs `hash_scheme(preimage)`.

| Intent | Preimage | Scheme | Signed digest |
| --- | --- | --- | --- |
| EVM direct | `0x02 ‖ rlp([chainId, nonce, maxPriorityFee, maxFee, gas, to, value, data, []])` | `EcdsaKeccak256` (0) | EIP-1559 signing hash |
| EVM delegated | `0x1901 ‖ domainSeparator ‖ hashStruct(Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline))` | 0 | EIP-712 digest |
| EVM setup #1 | `0x05 ‖ rlp([chainId, Config.implementation, eoa_nonce])` | 0 | EIP-7702 authorization hash |
| EVM setup #2 | EIP-712 `Init(address recoveryKey,uint256 recoveryDelay)` | 0 | EIP-712 digest |
| EVM cancel recovery | EIP-712 `CancelRecovery(uint256 nonce,uint256 deadline)` | 0 | EIP-712 digest |
| BTC (per input) | BIP143 preimage, `SIGHASH_ALL` | `EcdsaDoubleSha256` (2) | BIP143 sighash |

- EIP-712 domain: `{ name: "IkaAccount", version: "1", chainId, verifyingContract: <account EOA> }`.
- ERC-20 sends: `to = token`, `value = 0`, `data = transfer(recipient, amount)`. Native: `to = recipient`, `data = 0x`.
- BTC transaction: version 2, locktime 0, nSequence `0xfffffffd`, outputs `[recipient, change ≥ 546 → own address]`.
  - Script code: P2WPKH `76a914{hash160}88ac`.
  - P2WSH witness script: `OP_IF <dwallet> OP_CHECKSIG OP_ELSE <csv> OP_CSV OP_DROP <recovery> OP_CHECKSIG OP_ENDIF`.

The off-chain mirrors in `@ika-portal/chains` are tested byte for byte against the program (`tests/e2e/parity.test.ts`) and against viem and bitcoinjs.

## Ika dWallet program interface used

- `approve_message` (disc 8), CPI path, 7 accounts: coordinator, message_approval, dwallet, caller_program, cpi_authority (signer), payer, system.
- `transfer_ownership` (disc 24), signer path.
- `MessageApproval` PDA: `["dwallet", chunk(curve_le‖pk)[0..32], chunk[32..35], "message_approval", scheme_u16_le, keccak(preimage)]`.

`mock_dwallet` implements the same wire format for local testing. Switching between it and Ika is a `Config.dwallet_program` change.
