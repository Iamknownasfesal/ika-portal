# Gasless EVM (EIP-7702 delegated mode)

By default an account's EVM address sends ordinary EIP-1559 transactions and pays its own gas (**direct mode**). Users then need ETH on each chain they use.

**Delegated mode** removes that requirement. The dWallet address is EIP-7702-delegated to `IkaAccount.sol`, the dWallet signs EIP-712 `Execute` messages, and **your relayer** submits them and pays the gas. It also enables EVM recovery for `enforced_recovery` accounts.

## What you need

1. `IkaAccount.sol` deployed once per chain (it's a shared implementation; every account delegates to the same address).
2. That address set as the chain's `implementation` in the program `Config`. The program will only approve a 7702 authorization for the configured implementation.
3. A running relayer (`services/relayer`) with a funded key, and `relayerUrl` in the SDK.

### Deploy the implementation

```bash
cd contracts/evm
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC --private-key $DEPLOYER_PK --broadcast
```

Then update the program `Config` (admin only; see [Operations](../operations.md)):

```ts
await upsertConfig(connection, admin, {
  dwalletProgram: IKA_DEVNET_PROGRAM_ID,
  btcNetwork: 'testnet',
  evmChains: [
    { chain: 'ethereum', chainId: 11155111, implementation: '0xIkaAccountOnSepolia' },
    { chain: 'base', chainId: 84532, implementation: '0xIkaAccountOnBaseSepolia' },
  ],
  tokens: [{ chain: 'ethereum', address: USDC.sepolia }, { chain: 'base', address: USDC.baseSepolia }],
});
```

### Run the relayer

```bash
RELAYER_PRIVATE_KEY=0x… \
RELAYER_CHAINS='{"11155111":{"rpc":"https://…","implementation":"0x…"},"84532":{"rpc":"https://…","implementation":"0x…"}}' \
PORT=8787 pnpm --filter @ika-portal/relayer start
```

Or embed it:

```ts
import { createRelayer } from '@ika-portal/relayer';
const relayer = createRelayer({ privateKey, chains, rateLimitPerMinute: 20 });
await relayer.listen(8787);           // or use relayer.handle(req, res) in your own server
```

| Endpoint | Body | Does |
| --- | --- | --- |
| `POST /setup` | `{ chainId, account, authorization, initArgs }` | Sends one type-4 transaction carrying the 7702 authorization and the `initialize` call |
| `POST /execute` | `{ chainId, account, to, value, data, deadline, sig }` | Calls `IkaAccount.execute` on the account |
| `POST /cancel-recovery` | `{ chainId, account, deadline, sig }` | Calls `IkaAccount.cancelRecovery` |
| `GET /health` | — | Relayer address and chains |

The relayer simulates every request before sending. It only relays to accounts delegated to the configured implementation, and it rate-limits per account. It has no authentication in the MVP, so put it behind your own auth or gateway in production.

## Enable it per account

```ts
await (await account.setupEvm('base')).wait();   // one-time, per chain
account.isDelegated('base');                      // true
await account.send({ chain: 'base', asset: 'USDC', to, amount });   // now relayed automatically
```

`setupEvm` proposes an `evm_setup` intent. The program approves two digests: the 7702 authorization (to the Config implementation, at the EOA's current nonce) and `Init(recoveryKey, recoveryDelay)`. The relayer submits both in one transaction.

## Nonces

`IkaAccount` keeps its own nonce. The program tracks the nonce it will sign next and binds it into each `Execute` at approval time. If an approved `execute` is never submitted before its deadline, the two can drift. Resync with:

```ts
const onchain = await new evm.EvmAdapter('base', cfg).ikaNonce(account.addresses.base!);
await sendInstructions(connection, await account.instructions.setEvmNonce('base', onchain), feePayer, [wallet]);
```

This is safe: the contract nonce still prevents replay, and a wrong program nonce only produces unusable signatures.

## Direct mode still works

A delegated EOA can still send direct transactions. Pass `evmMode: 'direct'` to `send()`; this needs ETH on the address.
