/**
 * Local infrastructure for end-to-end tests: solana-test-validator (with
 * ika_account + mock_dwallet + test_cpi_owner), two Prague anvils standing in
 * for Ethereum and Base, bitcoind regtest, and the relayer (in-process).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evm } from '@ika-portal/chains';

export const ROOT = resolve(import.meta.dirname, '../..');
const E2E = join(ROOT, '.e2e');

export const PROGRAMS = {
  ikaAccount: 'Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje',
  mockDwallet: '6sewJoZnLJN1hMzaYLySG61VSLiPoFzbA8Cyd7KJkwv',
  testCpiOwner: 'C86ZbaTdqH5dHZ5sBRrNrpMUYJxjubk8Adt4fNT9RnLA',
};

/** E2E_EXTERNAL=1: use already-running networks (e.g. docker/compose.yaml) instead of spawning them. */
export const EXTERNAL = process.env.E2E_EXTERNAL === '1';
export const SOLANA_RPC = process.env.E2E_SOLANA_RPC ?? 'http://127.0.0.1:8899';
export const ANVIL = { ethereum: { port: 8545, chainId: 31337 }, base: { port: 8546, chainId: 31338 } } as const;
export const BITCOIND = { url: process.env.E2E_BITCOIND_URL ?? 'http://127.0.0.1:18443', user: 'ika', pass: 'ika' };
/** anvil default account #0 */
export const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
/** anvil default account #1 (relayer) */
export const RELAYER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;

export interface InfraInfo {
  solanaRpc: string;
  evm: { ethereum: { rpc: string; chainId: number; impl: Address; usdc: Address }; base: { rpc: string; chainId: number; impl: Address; usdc: Address } };
  bitcoind: typeof BITCOIND;
  relayerUrl: string;
  admin: number[];
}

const procs: ChildProcess[] = [];
const closers: (() => Promise<void>)[] = [];

function start(cmd: string, args: string[], name: string) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr?.on('data', (d) => (err += d.toString()));
  p.on('exit', (code) => {
    if (code && code !== 143 && code !== 0) console.error(`[${name}] exited ${code}: ${err.slice(-2000)}`);
  });
  procs.push(p);
  return p;
}

async function waitFor(fn: () => Promise<unknown>, what: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      await fn();
      return;
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export async function btcRpc<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const url = wallet ? `${BITCOIND.url}/wallet/${wallet}` : BITCOIND.url;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${BITCOIND.user}:${BITCOIND.pass}`).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params }),
  });
  const j = (await res.json()) as { result: T; error: { message: string } | null };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

function forgeArtifact(name: string, file: string) {
  const p = join(ROOT, 'contracts/evm/out', file, `${name}.json`);
  if (!existsSync(p)) execFileSync('forge', ['build'], { cwd: join(ROOT, 'contracts/evm'), stdio: 'ignore' });
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function deployEvm(rpc: string, chainId: number) {
  const chain = { id: chainId, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const account = privateKeyToAccount(ANVIL_PK);
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const deploy = async (abi: unknown[], bytecode: Hex) => {
    const hash = await wallet.deployContract({ abi, bytecode, args: [] });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };
  const impl = await deploy(evm.ikaAccountAbi as unknown as unknown[], evm.ikaAccountBytecode);
  const erc = forgeArtifact('MockERC20', 'Mocks.sol');
  const usdc = await deploy(erc.abi, erc.bytecode);
  return { impl, usdc, mockErc20Abi: erc.abi };
}

/** Contract addresses when deployed by anvil #0 at nonces 0 and 1 on a fresh chain. */
const DETERMINISTIC = { impl: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address, usdc: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as Address };

async function startExternal(opts: { solana?: boolean; evm?: boolean; bitcoin?: boolean }): Promise<InfraInfo> {
  const info: Partial<InfraInfo> = { solanaRpc: SOLANA_RPC, bitcoind: BITCOIND };
  const conn = new Connection(SOLANA_RPC, 'confirmed');
  await waitFor(() => conn.getLatestBlockhash(), `solana at ${SOLANA_RPC}`, 180_000);
  // Fixed admin so reruns against a long-lived validator can update the program Config.
  const admin = Keypair.fromSeed(createHash('sha256').update('ika-portal-e2e-admin').digest());
  await conn.confirmTransaction(await conn.requestAirdrop(admin.publicKey, 1000 * LAMPORTS_PER_SOL), 'confirmed');
  info.admin = Array.from(admin.secretKey);

  if (opts.evm) {
    const rpcs = { ethereum: process.env.E2E_ETH_RPC ?? 'http://127.0.0.1:8545', base: process.env.E2E_BASE_RPC ?? 'http://127.0.0.1:8546' };
    const out: Record<string, unknown> = {};
    for (const [name, rpc] of Object.entries(rpcs)) {
      const pub = createPublicClient({ transport: http(rpc) });
      await waitFor(() => pub.getBlockNumber(), `${name} at ${rpc}`);
      const chainId = await pub.getChainId();
      const existing = (await pub.getCode({ address: DETERMINISTIC.impl })) && (await pub.getCode({ address: DETERMINISTIC.usdc }));
      const d = existing ? DETERMINISTIC : await deployEvm(rpc, chainId);
      out[name] = { rpc, chainId, impl: d.impl, usdc: d.usdc };
    }
    info.evm = out as InfraInfo['evm'];
    if (process.env.E2E_RELAYER_URL) {
      info.relayerUrl = process.env.E2E_RELAYER_URL;
      await waitFor(async () => {
        const r = await fetch(`${info.relayerUrl}/health`);
        if (!r.ok) throw new Error(String(r.status));
      }, `relayer at ${info.relayerUrl}`);
    } else {
      const { createRelayer } = await import('@ika-portal/relayer');
      const relayer = createRelayer({
        privateKey: RELAYER_PK,
        rateLimitPerMinute: 1000,
        chains: Object.fromEntries(Object.values(info.evm).map((c) => [c.chainId, { rpc: c.rpc, implementation: c.impl }])),
      });
      const r = await relayer.listen(0);
      closers.push(r.close);
      info.relayerUrl = r.url;
    }
  }

  if (opts.bitcoin) {
    await waitFor(() => btcRpc('getblockchaininfo'), `bitcoind at ${BITCOIND.url}`);
    await btcRpc('createwallet', ['miner']).catch(async (e: Error) => {
      if (!/already exists/i.test(e.message)) throw e;
      await btcRpc('loadwallet', ['miner']).catch((e2: Error) => {
        if (!/already loaded/i.test(e2.message)) throw e2;
      });
    });
    if ((await btcRpc<number>('getblockcount')) < 101) {
      await btcRpc('generatetoaddress', [101, await btcRpc<string>('getnewaddress', [], 'miner')]);
    }
  }
  return info as InfraInfo;
}

export async function startInfra(opts: { solana?: boolean; evm?: boolean; bitcoin?: boolean } = { solana: true, evm: true, bitcoin: true }): Promise<InfraInfo> {
  if (EXTERNAL) return startExternal(opts);
  mkdirSync(E2E, { recursive: true });
  const info: Partial<InfraInfo> = { solanaRpc: SOLANA_RPC, bitcoind: BITCOIND };

  if (opts.solana) {
    const ledger = join(E2E, 'ledger');
    rmSync(ledger, { recursive: true, force: true });
    const args = ['--reset', '--quiet', '--ledger', ledger, '--rpc-port', '8899'];
    for (const [name, id] of [['ika_account', PROGRAMS.ikaAccount], ['mock_dwallet', PROGRAMS.mockDwallet], ['test_cpi_owner', PROGRAMS.testCpiOwner]] as const) {
      args.push('--bpf-program', id, join(ROOT, 'target/deploy', `${name}.so`));
    }
    start('solana-test-validator', args, 'solana');
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    await waitFor(async () => {
      const h = await fetch(SOLANA_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
      const j = (await h.json()) as { result?: string };
      if (j.result !== 'ok') throw new Error('not healthy');
      await conn.getLatestBlockhash();
    }, 'solana-test-validator', 90_000);
    const admin = Keypair.generate();
    const sig = await conn.requestAirdrop(admin.publicKey, 1000 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    info.admin = Array.from(admin.secretKey);
  }

  if (opts.evm) {
    const out: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(ANVIL)) {
      start('anvil', ['--hardfork', 'prague', '--port', String(cfg.port), '--chain-id', String(cfg.chainId), '--silent'], `anvil-${name}`);
      const rpc = `http://127.0.0.1:${cfg.port}`;
      await waitFor(() => createPublicClient({ transport: http(rpc) }).getBlockNumber(), `anvil ${name}`);
      const d = await deployEvm(rpc, cfg.chainId);
      out[name] = { rpc, chainId: cfg.chainId, impl: d.impl, usdc: d.usdc };
    }
    info.evm = out as InfraInfo['evm'];
    const { createRelayer } = await import('@ika-portal/relayer');
    const relayer = createRelayer({
      privateKey: RELAYER_PK,
      rateLimitPerMinute: 1000,
      chains: Object.fromEntries(Object.values(info.evm).map((c) => [c.chainId, { rpc: c.rpc, implementation: c.impl }])),
    });
    const r = await relayer.listen(0);
    closers.push(r.close);
    info.relayerUrl = r.url;
  }

  if (opts.bitcoin) {
    const datadir = join(E2E, 'bitcoind');
    rmSync(datadir, { recursive: true, force: true });
    mkdirSync(datadir, { recursive: true });
    start(
      'bitcoind',
      ['-regtest', `-datadir=${datadir}`, `-rpcuser=${BITCOIND.user}`, `-rpcpassword=${BITCOIND.pass}`, '-rpcport=18443', '-port=18444', '-fallbackfee=0.0002', '-txindex=1', '-server=1', '-listen=0'],
      'bitcoind',
    );
    await waitFor(() => btcRpc('getblockchaininfo'), 'bitcoind');
    await btcRpc('createwallet', ['miner']);
    const addr = await btcRpc<string>('getnewaddress', [], 'miner');
    await btcRpc('generatetoaddress', [101, addr]);
  }
  return info as InfraInfo;
}

export async function stopInfra() {
  for (const c of closers.splice(0)) await c().catch(() => undefined);
  for (const p of procs.splice(0)) p.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
}

export async function mine(n: number) {
  const addr = await btcRpc<string>('getnewaddress', [], 'miner');
  await btcRpc('generatetoaddress', [n, addr]);
}

export async function fundBtc(address: string, btc: number) {
  const txid = await btcRpc<string>('sendtoaddress', [address, btc], 'miner');
  await mine(1);
  return txid;
}

export { PublicKey };
