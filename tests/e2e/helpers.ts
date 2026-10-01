import { inject } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { btc } from '@ika-portal/chains';
import { LocalMockSigner, MemoryKeyStore, SolanaSignatureUnlocker, type ShareUnlocker } from '@ika-portal/signer';
import { IkaPortal, keypairSigner, type IkaPortalOptions } from '@ika-portal/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ANVIL_PK, BITCOIND } from './infra.js';

export const infra = () => inject('infra');
export const connection = () => new Connection(infra().solanaRpc, 'confirmed');

export async function fundedKeypair(sol = 100) {
  const kp = Keypair.generate();
  const c = connection();
  await c.confirmTransaction(await c.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

/** Shared mock key store so different SDK instances (with/without unlocker) see the same dWallets. */
export const mockStore = new MemoryKeyStore();

export function unlockerFor(kp: Keypair): ShareUnlocker {
  return new SolanaSignatureUnlocker(async (m) => ed25519.sign(m, kp.secretKey.slice(0, 32)));
}

export function sdk(owner: Keypair, extra: Partial<IkaPortalOptions> = {}) {
  const i = infra();
  const signer = new LocalMockSigner({ connection: connection(), payer: owner, store: mockStore });
  return new IkaPortal({
    connection: connection(),
    signer,
    wallet: keypairSigner(owner),
    chains: {
      bitcoin: { network: 'regtest', backend: new btc.BitcoindRpcBackend(BITCOIND.url, { username: BITCOIND.user, password: BITCOIND.pass }, { fallbackFeeRate: 2 }) },
      ...(i.evm
        ? {
            ethereum: { rpc: i.evm.ethereum.rpc, chainId: i.evm.ethereum.chainId, tokens: { USDC: i.evm.ethereum.usdc }, implementation: i.evm.ethereum.impl },
            base: { rpc: i.evm.base.rpc, chainId: i.evm.base.chainId, tokens: { USDC: i.evm.base.usdc }, implementation: i.evm.base.impl },
          }
        : {}),
    },
    relayerUrl: i.relayerUrl,
    pollMs: 300,
    ...extra,
  });
}

const erc20 = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);

export function evmTools(chain: 'ethereum' | 'base') {
  const c = infra().evm[chain];
  const vchain = { id: c.chainId, name: chain, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } };
  const pub = createPublicClient({ chain: vchain, transport: http(c.rpc) });
  const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_PK), chain: vchain, transport: http(c.rpc) });
  return {
    ...c,
    pub,
    async fundEth(to: Address, wei: bigint) {
      await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, value: wei }) });
    },
    async mintUsdc(to: Address, amount: bigint) {
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: c.usdc, abi: erc20, functionName: 'mint', args: [to, amount] }) });
    },
    usdcBalance: (a: Address) => pub.readContract({ address: c.usdc, abi: erc20, functionName: 'balanceOf', args: [a] }),
    ethBalance: (a: Address) => pub.getBalance({ address: a }),
    async increaseTime(s: number) {
      await pub.request({ method: 'evm_increaseTime' as never, params: [s] as never });
      await pub.request({ method: 'evm_mine' as never, params: [] as never });
    },
    wallet,
  };
}

export const randomEvmAddress = () => privateKeyToAccount(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex).address;
