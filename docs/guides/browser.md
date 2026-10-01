# Browser integration (web wallets and extensions)

The SDK runs in browsers. `apps/example-wallet` is a working Vite + React reference that's been tested against devnet. This page lists what's different from Node.

## 1. Polyfill Node globals first

Some dependencies (`@solana/web3.js`, bitcoinjs) expect `Buffer`, `process` and `global`. Install them **before** any SDK module loads, as a separate script that runs ahead of your app entry:

```ts
// src/polyfills.ts
import { Buffer } from 'buffer';
import process from 'process';
const g = globalThis as any;
g.Buffer ??= Buffer;
g.process ??= process;
g.global ??= globalThis;
```

```html
<!-- index.html -->
<script type="module" src="/src/polyfills.ts"></script>
<script type="module" src="/src/main.tsx"></script>
```

`vite-plugin-node-polyfills` doesn't work well with pnpm workspaces that consume the SDK as source. The explicit file above is more reliable.

## 2. Bundler config (Vite)

```ts
// vite.config.ts
export default defineConfig({
  resolve: {
    alias: {
      // Node-only gRPC transport; browsers use gRPC-web. Point it at an empty stub.
      '@grpc/grpc-js': fileURLToPath(new URL('./src/shims/grpc-js.ts', import.meta.url)),
    },
  },
  optimizeDeps: {
    // The Ika client ships raw .ts inside node_modules; pre-bundle it.
    include: ['@ika-portal/signer > @ika.xyz/pre-alpha-solana-client/grpc-web'],
  },
  build: { target: 'es2022' },
});
```

```ts
// src/shims/grpc-js.ts
export {};
```

For `tsc`, map the Ika client's types to the SDK's shim (the upstream package has a type error):

```json
"paths": { "@ika.xyz/pre-alpha-solana-client/grpc-web": ["../../packages/signer/types/ika-client-grpc.d.ts"] }
```

## 3. Ika over gRPC-web

`IkaPreAlphaSigner` uses gRPC-web automatically in browsers. The Ika devnet endpoint allows cross-origin requests, so you don't need a proxy:

```ts
new IkaPreAlphaSigner({ connection, identity: sessionKey, transport: 'web' });
```

## 4. The session key

`identity` is an Ed25519 keypair the SDK uses to authenticate Ika gRPC requests. It's stored on the account as `ika_user`.

- It **cannot move funds**: Ika signs only messages the program approved after the owner signed an intent.
- Generate one per install and keep it in extension storage or `localStorage`.
- Don't use the user's main wallet key here. `IkaPreAlphaSigner` holds `identity` in memory as a `Keypair`.

## 5. Wallet adapter as `wallet` and `unlocker`

```ts
const { publicKey, signTransaction, signMessage } = useWallet();

const ika = new IkaPortal({
  connection,
  signer: new IkaPreAlphaSigner({ connection, identity: sessionKey, transport: 'web' }),
  wallet: { publicKey: publicKey!, signTransaction: signTransaction! },
  unlocker: signMessage ? new SolanaSignatureUnlocker((m) => signMessage(m)) : undefined,
  chains: { ... },
});
```

Inside your own wallet you hold the keys, so pass any `TxSigner` (`{ publicKey, signTransaction }`). `keypairSigner(kp)` wraps a `Keypair`.

## 6. Storage

| Data | Where | Sensitive? |
| --- | --- | --- |
| `DWalletRef[]` per (owner, index) | Persistent (extension storage / `localStorage` / your backend) | No plaintext secrets, but needed to sign: losing them means re-creating the account |
| Session key | Persistent, per install | Low (can't move funds) |
| Mnemonic / recovery key | **Never.** Show once | Yes |
| Destination tx hashes | Optional, for activity UI | No |

Persist refs as soon as `onDWalletsCreated` fires. If the user rejects a later prompt, you can retry the remaining transactions without redoing DKG.

## 7. Polling and RPC limits

The SDK polls Solana for intent state and the clock. The public devnet RPC rate-limits heavily (`429`), so use a dedicated RPC and tune `pollMs` (default 1000).

## Prompts per action

| Action | Wallet prompts |
| --- | --- |
| Create (`enforced*`) | 2 transaction signatures (+1 `signMessage` if `encrypted`, to encrypt the share) |
| Create (`recoverable`) | 3 transaction signatures |
| Send / swap | 1 (propose) + 1 (approve, unless `feePayer` is a separate hot key) (+1 `signMessage` per Ika signature if `encrypted`; a BTC send has one per input) |
| Policy change | 1 (propose); apply is permissionless |

`approve_intent` is signed by `feePayer` (defaults to `wallet`). Set `feePayer` to a wallet-controlled hot key to save the user a prompt.
