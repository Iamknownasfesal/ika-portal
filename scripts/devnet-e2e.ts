/**
 * M4 devnet end-to-end against the real Ika Solana pre-alpha.
 *
 *   pnpm tsx scripts/devnet-e2e.ts
 *
 * Env (all optional):
 *   OWNER_KEYPAIR      path to a Solana keypair (default ~/.config/solana/id.json); also config admin
 *   SEPOLIA_RPC        default https://ethereum-sepolia-rpc.publicnode.com
 *   BASE_SEPOLIA_RPC   default https://sepolia.base.org
 *   ESPLORA_URL        default https://mempool.space/testnet4/api
 *   ACCOUNT_INDEX      default: random
 *   BROADCAST=1        broadcast when the dWallet addresses are funded
 *
 * Without testnet funds, every step up to and including Ika signing runs for
 * real (DKG, ownership transfer to the program's CPI PDA, approval CPI into
 * the Ika program, gRPC presign + sign), and the signatures are verified
 * offline against the dWallet keys and the exact digests.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { createPublicClient, http, parseTransaction, recoverTransactionAddress, formatEther, type Hex } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { btc, USDC } from '@ika-portal/chains';
import { IKA_DEVNET_PROGRAM_ID, IkaPreAlphaSigner, SolanaSignatureUnlocker } from '@ika-portal/signer';
import { IkaPortal, defaultPolicy, keypairSigner, upsertConfig, sendInstructions, type IkaAccountHandle } from '@ika-portal/core';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const ESPLORA = process.env.ESPLORA_URL ?? 'https://mempool.space/testnet4/api';
const BROADCAST = process.env.BROADCAST === '1';

const log = (step: string, msg: string) => console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg: string) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.OWNER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`, 'utf8'))));
const connection = new Connection(RPC, 'confirmed');
const esplora = new btc.EsploraBackend(ESPLORA);

async function main() {
  log('setup', `owner ${owner.publicKey.toBase58()} (${(await connection.getBalance(owner.publicKey)) / 1e9} SOL)`);

  // Program Config: switch dWallet program to Ika devnet (config-only change).
  await upsertConfig(connection, keypairSigner(owner), {
    dwalletProgram: IKA_DEVNET_PROGRAM_ID,
    btcNetwork: 'testnet',
    evmChains: [
      { chain: 'ethereum', chainId: 11155111, implementation: process.env.SEPOLIA_IMPL as Hex | undefined },
      { chain: 'base', chainId: 84532, implementation: process.env.BASE_SEPOLIA_IMPL as Hex | undefined },
    ],
    tokens: [
      { chain: 'ethereum', address: USDC.sepolia },
      { chain: 'base', address: USDC.baseSepolia },
    ],
  });
  ok('Config points at Ika devnet program 87W54k…');

  const signer = new IkaPreAlphaSigner({ connection, identity: owner });
  const unlocker = new SolanaSignatureUnlocker(async (m) => ed25519.sign(m, owner.secretKey.slice(0, 32)));
  const ika = new IkaPortal({
    connection,
    signer,
    unlocker,
    wallet: keypairSigner(owner),
    chains: {
      bitcoin: { network: 'testnet', backend: esplora, explorer: 'https://mempool.space/testnet4' },
      ethereum: { rpc: SEPOLIA_RPC, chainId: 11155111, tokens: { USDC: USDC.sepolia }, explorer: 'https://sepolia.etherscan.io' },
      base: { rpc: BASE_SEPOLIA_RPC, chainId: 84532, tokens: { USDC: USDC.baseSepolia }, explorer: 'https://sepolia.basescan.org' },
    },
    relayerUrl: process.env.RELAYER_URL,
    pollMs: 1500,
  });

  const index = Number(process.env.ACCOUNT_INDEX ?? Math.floor(Math.random() * 60_000));
  for (const userShare of ['public', 'encrypted'] as const) {
    log('create', `enforced account #${index + (userShare === 'encrypted' ? 1 : 0)}, userShare=${userShare}: Ika DKG on devnet…`);
    const t0 = Date.now();
    const { account, dwallets } = await ika.createAccount({
      owner: owner.publicKey,
      index: index + (userShare === 'encrypted' ? 1 : 0),
      mode: 'enforced',
      userShare,
      policy: defaultPolicy({ maxEvmFeeWei: 10n ** 16n }),
    });
    ok(`account ${account.address.toBase58()} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    ok(`dWallet ${dwallets[0]!.address} (pk ${dwallets[0]!.publicKey.slice(0, 16)}…), authority → ika_account CPI PDA`);
    console.log('  addresses:', account.addresses);

    await evmStep(account, 'ethereum', SEPOLIA_RPC);
    await evmStep(account, 'base', BASE_SEPOLIA_RPC);
    await btcStep(ika, account);
    if (userShare === 'public') console.log();
  }
  signer.close();
  console.log('\n\x1b[1m\x1b[32mDevnet e2e complete\x1b[0m');
}

async function evmStep(account: IkaAccountHandle, chain: 'ethereum' | 'base', rpc: string) {
  const client = createPublicClient({ transport: http(rpc) });
  const eoa = account.addresses[chain]!;
  const bal = await client.getBalance({ address: eoa });
  log(chain, `EOA ${eoa} balance ${formatEther(bal)} ETH`);
  const handle = await account.send({ chain, asset: 'ETH', to: eoa, amount: 1n, evmMode: 'direct' });
  const funded = bal > 10n ** 15n;
  if (BROADCAST && funded) {
    const r = await handle.wait();
    ok(`broadcast + confirmed: ${r.destinationTxUrl ?? r.destinationTx}`);
    return;
  }
  const s = await handle.signOnly();
  ok(`Ika approval tx ${s.solanaTx}`);
  const tx = parseTransaction(s.rawTransaction as Hex);
  const signerAddr = await recoverTransactionAddress({ serializedTransaction: s.rawTransaction as never });
  if (signerAddr.toLowerCase() !== eoa.toLowerCase()) throw new Error(`recovered ${signerAddr} != ${eoa}`);
  ok(`Ika ECDSA(Keccak256) signature recovers to the dWallet EOA; signed EIP-1559 tx on chain ${tx.chainId} ready`);
  if (!funded) warn(`unfunded: send ≥0.001 test ETH to ${eoa} and rerun with BROADCAST=1 to broadcast`);
}

async function btcStep(ika: IkaPortal, account: IkaAccountHandle) {
  const address = account.addresses.bitcoin!;
  const utxos = await esplora.utxos(address).catch(() => []);
  const bal = utxos.reduce((s, u) => s + u.value, 0n);
  log('bitcoin', `testnet4 ${address} balance ${bal} sats`);
  if (BROADCAST && bal > 20_000n) {
    const r = await (await account.send({ chain: 'bitcoin', asset: 'BTC', to: address, amount: 10_000n })).wait();
    ok(`broadcast + confirmed: ${r.destinationTxUrl ?? r.destinationTx}`);
    return;
  }
  // Unfunded: sign a BIP143 spend of a synthetic UTXO to prove Ika signs
  // EcdsaDoubleSha256 over our on-chain-computed sighash.
  const toScript = btc.addressToScript(address, 'testnet');
  const params = {
    kind: { send: {} },
    chain: { bitcoin: {} },
    asset: new Array(20).fill(0),
    to: Buffer.from(toScript),
    amount: new BN(10_000),
    evm: null,
    btc: { inputs: [{ txid: Array.from(randomBytes(32)), vout: 0, value: new BN(50_000) }], fee: new BN(500) },
  };
  await account.refresh();
  const nonce = account.view.intentNonce;
  const ix = await ika.program.proposeIntent(owner.publicKey, owner.publicKey, account.address, nonce, params);
  await sendInstructions(connection, [ix], keypairSigner(owner));
  const s = await account.intent(ika.program.intentPda(account.address, nonce)).signOnly();
  // toBitcoinSignature (inside rawTransaction) verifies each signature against the sighash + pubkey.
  ok(`Ika ECDSA(DoubleSHA256) BIP143 signature verified; raw tx ${s.rawTransaction!.slice(0, 24)}… (synthetic input, not broadcast)`);
  if (bal <= 20_000n) warn(`unfunded: send testnet4 coins to ${address} and rerun with BROADCAST=1`);
}

main().catch((e) => {
  console.error('\n\x1b[31mFAILED\x1b[0m', e);
  process.exit(1);
});

export { PublicKey };
