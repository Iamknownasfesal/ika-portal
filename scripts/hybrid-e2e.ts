/**
 * Hybrid end-to-end: real Ika pre-alpha on Solana devnet (DKG, approvals, MPC
 * signing) + local destination chains from docker/compose.yaml (Anvil
 * "Ethereum"/"Base", Bitcoin regtest, relayer). Every Ika signature ends up in
 * a real transaction accepted by a real EVM / Bitcoin node.
 *
 *   pnpm stack:up && pnpm tsx scripts/hybrid-e2e.ts
 *
 * Temporarily points the devnet program Config at the local chain ids
 * (31337 / 31338 / regtest) and restores Sepolia / Base Sepolia / testnet4 at
 * the end (set KEEP_LOCAL_CONFIG=1 to skip the restore).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Connection, Keypair } from '@solana/web3.js';
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { btc, evm, recovery, USDC } from '@ika-portal/chains';
import { IKA_DEVNET_PROGRAM_ID, IkaPreAlphaSigner, SolanaSignatureUnlocker } from '@ika-portal/signer';
import { MockSwapProvider } from '@ika-portal/swap';
import { IkaPortal, defaultPolicy, keypairSigner, upsertConfig, type IntentHandle, type IkaAccountHandle } from '@ika-portal/core';

const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const LOCAL = {
  ethereum: { rpc: process.env.ETH_RPC ?? 'http://127.0.0.1:8545', chainId: 31337 },
  base: { rpc: process.env.BASE_RPC ?? 'http://127.0.0.1:8546', chainId: 31338 },
  bitcoind: process.env.BITCOIND_URL ?? 'http://127.0.0.1:18443',
  relayer: process.env.RELAYER_URL ?? 'http://127.0.0.1:8787',
};
// Deployed by anvil #0 at nonces 0/1 (see tests/e2e/infra.ts); anvil #0 is a public dev key.
const IMPL = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address;
const LOCAL_USDC = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as Address;
const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.OWNER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`, 'utf8'))));
const connection = new Connection(SOLANA_RPC, 'confirmed');
const admin = keypairSigner(owner);

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (m: string) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
async function check(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  \x1b[32m✓\x1b[0m ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s): ${detail}`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${(e as Error).message}`);
  }
}
const assert = (c: unknown, m: string) => {
  if (!c) throw new Error(m);
};

// ── Local chain tools ──
function evmTools(chain: 'ethereum' | 'base') {
  const c = LOCAL[chain];
  const vchain = { id: c.chainId, name: chain, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } };
  const pub = createPublicClient({ chain: vchain, transport: http(c.rpc) });
  const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_PK), chain: vchain, transport: http(c.rpc) });
  const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);
  return {
    ...c,
    pub,
    fundEth: async (to: Address, wei: bigint) => void (await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, value: wei }) })),
    mintUsdc: async (to: Address, amt: bigint) =>
      void (await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: LOCAL_USDC, abi: mintAbi, functionName: 'mint', args: [to, amt] }) })),
    usdc: (a: Address) => pub.readContract({ address: LOCAL_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] }),
    eth: (a: Address) => pub.getBalance({ address: a }),
  };
}
const btcBackend = new btc.BitcoindRpcBackend(LOCAL.bitcoind, { username: 'ika', password: 'ika' }, { fallbackFeeRate: 2 });
const btcRpc = <T>(m: string, p: unknown[] = [], w?: string) => btcBackend.rpc<T>(m, p, w);
const randomEvm = () => privateKeyToAccount(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`).address;

async function mine(n = 1) {
  await btcRpc('generatetoaddress', [n, await btcRpc<string>('getnewaddress', [], 'miner')]);
}
async function withMiner<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const m = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!done) await mine(1).catch(() => undefined);
    }
  })();
  try {
    return await p;
  } finally {
    done = true;
    await m;
  }
}
async function run(h: IntentHandle, label: string) {
  for await (const e of h.progress()) if (e.status === 'failed') throw e.error;
  const r = await h.wait();
  log(`${label}: Solana approval ${r.solanaTx?.slice(0, 16)}… → destination ${r.destinationTx}`);
  return r;
}

async function setConfig(local: boolean) {
  await upsertConfig(connection, admin, local
    ? {
        dwalletProgram: IKA_DEVNET_PROGRAM_ID,
        btcNetwork: 'regtest',
        evmChains: [
          { chain: 'ethereum', chainId: LOCAL.ethereum.chainId, implementation: IMPL },
          { chain: 'base', chainId: LOCAL.base.chainId, implementation: IMPL },
        ],
        tokens: [
          { chain: 'ethereum', address: LOCAL_USDC },
          { chain: 'base', address: LOCAL_USDC },
        ],
      }
    : {
        dwalletProgram: IKA_DEVNET_PROGRAM_ID,
        btcNetwork: 'testnet',
        evmChains: [
          { chain: 'ethereum', chainId: 11155111 },
          { chain: 'base', chainId: 84532 },
        ],
        tokens: [
          { chain: 'ethereum', address: USDC.sepolia },
          { chain: 'base', address: USDC.baseSepolia },
        ],
      });
}

async function main() {
  console.log(`\n\x1b[1mHybrid e2e: Ika devnet signing → local EVM + Bitcoin nodes\x1b[0m`);
  log(`owner ${owner.publicKey.toBase58()} (${(await connection.getBalance(owner.publicKey)) / 1e9} SOL)`);
  // Local stack preflight
  const eth = evmTools('ethereum');
  const base = evmTools('base');
  assert(await eth.pub.getCode({ address: IMPL }), 'IkaAccount not deployed on local ethereum: run pnpm stack:up and the e2e suite once');
  await btcRpc('loadwallet', ['miner']).catch(() => undefined);
  await btcRpc('createwallet', ['miner']).catch(() => undefined);
  if ((await btcRpc<number>('getblockcount')) < 101) await mine(101);

  await setConfig(true);
  log('devnet Config → Ika devnet dWallet program + local chains (31337 / 31338 / regtest)');

  const signer = new IkaPreAlphaSigner({ connection, identity: owner });
  const unlocker = new SolanaSignatureUnlocker(async (m) => ed25519.sign(m, owner.secretKey.slice(0, 32)));
  const depositAddress = await btcRpc<string>('getnewaddress', [], 'miner');
  const swapProvider = new MockSwapProvider({
    id: 'mock',
    rates: { 'BTC/USDC': '60000' },
    depositAddresses: { bitcoin: depositAddress },
    payout: async ({ to, amount }) => {
      await base.mintUsdc(to as Address, amount);
      return '0xmock';
    },
  });
  const portal = (withUnlocker: boolean) =>
    new IkaPortal({
      connection,
      signer,
      unlocker: withUnlocker ? unlocker : undefined,
      wallet: admin,
      chains: {
        bitcoin: { network: 'regtest', backend: btcBackend },
        ethereum: { rpc: LOCAL.ethereum.rpc, chainId: LOCAL.ethereum.chainId, tokens: { USDC: LOCAL_USDC } },
        base: { rpc: LOCAL.base.rpc, chainId: LOCAL.base.chainId, tokens: { USDC: LOCAL_USDC } },
      },
      relayerUrl: LOCAL.relayer,
      swap: { providers: [swapProvider], fees: { integrator: { recipient: randomEvm(), bps: 30 } } },
      pollMs: 2000,
    });
  const ika = portal(true);

  try {
    const idx = Math.floor(Math.random() * 60_000);
    let A!: IkaAccountHandle;
    await check('create enforced account (Ika DKG on devnet)', async () => {
      A = (await ika.createAccount({ owner: owner.publicKey, index: idx, mode: 'enforced', userShare: 'public', policy: defaultPolicy() })).account;
      return `${A.address.toBase58()} → ${JSON.stringify(A.addresses)}`;
    });
    if (!A) throw new Error('account creation failed');

    await check('Ethereum: direct ETH send, Ika-signed EIP-1559 tx mined by anvil', async () => {
      await eth.fundEth(A.addresses.ethereum!, parseEther('1'));
      const to = randomEvm();
      await run(await A.send({ chain: 'ethereum', asset: 'ETH', to, amount: parseEther('0.1'), evmMode: 'direct' }), 'eth direct');
      const got = await eth.eth(to);
      assert(got === parseEther('0.1'), `recipient has ${got}`);
      return 'recipient received 0.1 ETH';
    });

    await check('Base: EIP-7702 setup with Ika-signed authorization + Init, via relayer', async () => {
      await run(await A.setupEvm('base'), 'base 7702 setup');
      const target = evm.delegationTarget(await base.pub.getCode({ address: A.addresses.base! }));
      assert(target?.toLowerCase() === IMPL.toLowerCase(), `delegation target ${target}`);
      return `EOA delegated to IkaAccount ${IMPL}`;
    });

    await check('Base: gasless USDC send (Ika-signed EIP-712 Execute, relayed)', async () => {
      await A.refresh();
      await base.mintUsdc(A.addresses.base!, 5_000_000n);
      const to = randomEvm();
      await run(await A.send({ chain: 'base', asset: 'USDC', to, amount: 1_250_000n }), 'base usdc relayed');
      assert((await base.usdc(to)) === 1_250_000n, 'USDC not received');
      const ethBal = await base.eth(A.addresses.base!);
      assert(ethBal === 0n, `dWallet EOA holds ${ethBal} wei`);
      return 'recipient got 1.25 USDC; dWallet address holds 0 ETH';
    });

    await check('Bitcoin: P2WPKH send, Ika DoubleSHA256 BIP143 signature accepted by bitcoind', async () => {
      await btcRpc('sendtoaddress', [A.addresses.bitcoin!, 0.5], 'miner');
      await mine(1);
      const to = await btcRpc<string>('getnewaddress', [], 'miner');
      const r = await withMiner(run(await A.send({ chain: 'bitcoin', asset: 'BTC', to, amount: 20_000_000n }), 'btc p2wpkh'));
      const tx = await btcRpc<{ confirmations: number }>('getrawtransaction', [r.destinationTx, true]);
      assert(tx.confirmations >= 1, 'not confirmed');
      return `tx ${r.destinationTx?.slice(0, 16)}… confirmed`;
    });

    await check('Swap: BTC → Base USDC (Ika-signed deposit, mock provider payout)', async () => {
      await A.refresh();
      const q = await A.quoteSwap({ from: { chain: 'bitcoin', asset: 'BTC', amount: 1_000_000n }, to: { chain: 'base', asset: 'USDC' } });
      const before = await base.usdc(A.addresses.base!);
      const s = await A.swap(q.best!);
      const st = await withMiner(s.wait());
      assert(st.status === 'success', `swap ${st.status}`);
      const got = (await base.usdc(A.addresses.base!)) - before;
      assert(got === q.best!.amountOut, `received ${got}, quoted ${q.best!.amountOut}`);
      return `0.01 BTC → ${Number(got) / 1e6} USDC (after 30 bps integrator fee)`;
    });

    let B!: IkaAccountHandle;
    let recoveryKey!: Hex;
    await check('create enforced_recovery account (Ika DKG + recovery key)', async () => {
      const c = await ika.createAccount({ owner: owner.publicKey, index: idx + 1, mode: 'enforced_recovery', userShare: 'public', policy: defaultPolicy(), recovery: { csvBlocks: 6, evmDelayS: 3600 } });
      B = c.account;
      recoveryKey = c.recoveryKey!.privateKey;
      return `BTC P2WSH ${B.addresses.bitcoin}`;
    });

    if (B) {
      await check('Bitcoin: P2WSH (recovery script) send, Ika signs the dWallet branch', async () => {
        await btcRpc('sendtoaddress', [B.addresses.bitcoin!, 0.3], 'miner');
        await mine(1);
        const to = await btcRpc<string>('getnewaddress', [], 'miner');
        const r = await withMiner(run(await B.send({ chain: 'bitcoin', asset: 'BTC', to, amount: 10_000_000n }), 'btc p2wsh'));
        return `tx ${r.destinationTx?.slice(0, 16)}… confirmed`;
      });

      await check('Ethereum: recovery initiated by recovery key, cancelled by Ika-signed cancelRecovery', async () => {
        await run(await B.setupEvm('ethereum'), 'eth 7702 setup (recovery)');
        const rkAddr = privateKeyToAccount(recoveryKey).address;
        await eth.fundEth(rkAddr, parseEther('1'));
        const args = { recoveryKey, account: B.addresses.ethereum!, rpc: LOCAL.ethereum.rpc, chainId: LOCAL.ethereum.chainId };
        const { readyAt } = await recovery.evm.initiateRecovery(args);
        assert(readyAt > 0n, 'recovery not initiated');
        await B.refresh();
        await run(await B.cancelEvmRecovery('ethereum'), 'eth cancelRecovery');
        const st = await new evm.EvmAdapter('ethereum', LOCAL.ethereum).recoveryState(B.addresses.ethereum!);
        assert(st.recoveryReadyAt === 0n, 'recovery still pending');
        return 'pending recovery cleared on-chain by the dWallet';
      });
    }

    let C!: IkaAccountHandle;
    let cRefs: Parameters<IkaPortal['loadAccount']>[0]['dwallets'];
    await check('create encrypted-share account', async () => {
      const c = await ika.createAccount({ owner: owner.publicKey, index: idx + 2, mode: 'enforced', userShare: 'encrypted', policy: defaultPolicy() });
      C = c.account;
      cRefs = c.dwallets;
      return C.addresses.base!;
    });
    if (C) {
      await check('Encrypted share: no unlocker → ShareLocked; with unlocker → Ika-signed Base tx mined', async () => {
        await base.fundEth(C.addresses.base!, parseEther('1'));
        const locked = await portal(false).loadAccount({ owner: owner.publicKey, index: idx + 2, dwallets: cRefs });
        const h = await locked.send({ chain: 'base', asset: 'ETH', to: randomEvm(), amount: parseEther('0.01'), evmMode: 'direct' });
        const err = await h.wait().then(() => null, (e) => e);
        assert(err?.code === 'ShareLocked', `expected ShareLocked, got ${err?.code ?? 'success'}`);
        const r = await run(C.intent(h.intent), 'base direct (encrypted)');
        return `locked without unlocker; with unlocker → ${r.destinationTx?.slice(0, 18)}…`;
      });
    }
  } finally {
    signer.close();
    if (process.env.KEEP_LOCAL_CONFIG !== '1') {
      await setConfig(false);
      log('devnet Config restored → Sepolia / Base Sepolia / testnet4');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m${results.length - failed.length}/${results.length} passed\x1b[0m`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('\nFAILED', e);
  process.exit(1);
});

export { encodeFunctionData };
