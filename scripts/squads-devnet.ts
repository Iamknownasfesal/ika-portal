/**
 * Acceptance: a Squads v4 vault on devnet owns an Ika account and completes a
 * send through vault transactions.
 *
 *   pnpm tsx scripts/squads-devnet.ts        (BROADCAST=1 to broadcast when funded)
 *
 * Flow: create a 1-of-1 Squads multisig → Ika DKG with authority = vault →
 * vault tx #1 create_account → vault tx #2 transfer_ownership + register_dwallet
 * (atomic) → vault tx #3 propose_intent (send) → SDK continues from
 * approve_intent (permissionless) → Ika gRPC sign → verified / broadcast.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionMessage,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { recoverTransactionAddress, type Hex } from 'viem';
import { btc, USDC } from '@ika-portal/chains';
import { IkaPreAlphaSigner } from '@ika-portal/signer';
import { IkaPortal, defaultPolicy, keypairSigner } from '@ika-portal/core';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC, 'confirmed');
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.OWNER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`, 'utf8'))));
const log = (s: string, m: string) => console.log(`\x1b[36m[${s}]\x1b[0m ${m}`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

async function main() {
  // 1. Squads v4 multisig (1-of-1, the local keypair is the member).
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  const sig = await multisig.rpc.multisigCreateV2({
    connection,
    treasury: programConfig.treasury,
    createKey,
    creator: owner,
    multisigPda,
    configAuthority: null,
    threshold: 1,
    members: [{ key: owner.publicKey, permissions: multisig.types.Permissions.all() }],
    timeLock: 0,
    rentCollector: null,
  });
  await connection.confirmTransaction(sig, 'confirmed');
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  log('squads', `multisig ${multisigPda.toBase58()}, vault ${vault.toBase58()}`);
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: vault, lamports: 0.12 * LAMPORTS_PER_SOL })), [owner]);
  ok('vault funded with 0.12 SOL (it pays rent for its own account and intents)');

  async function vaultExec(label: string, instructions: TransactionInstruction[]) {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
    const { blockhash } = await connection.getLatestBlockhash();
    const transactionMessage = new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions });
    await connection.confirmTransaction(
      await multisig.rpc.vaultTransactionCreate({ connection, feePayer: owner, multisigPda, transactionIndex, creator: owner.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage }),
      'confirmed',
    );
    await connection.confirmTransaction(await multisig.rpc.proposalCreate({ connection, feePayer: owner, multisigPda, transactionIndex, creator: owner }), 'confirmed');
    await connection.confirmTransaction(await multisig.rpc.proposalApprove({ connection, feePayer: owner, multisigPda, transactionIndex, member: owner }), 'confirmed');
    const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda, transactionIndex, member: owner.publicKey });
    if (lookupTableAccounts.length) throw new Error('unexpected lookup tables');
    const exec = await sendAndConfirmTransaction(connection, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), instruction), [owner]);
    ok(`vault tx #${transactionIndex} (${label}) executed: ${exec.slice(0, 20)}…`);
  }

  // 2. Ika account owned by the vault.
  const signer = new IkaPreAlphaSigner({ connection, identity: owner });
  const ika = new IkaPortal({
    connection,
    signer,
    wallet: keypairSigner(owner), // pays for permissionless approve_intent; NOT the owner
    chains: {
      bitcoin: { network: 'testnet', backend: new btc.EsploraBackend('https://mempool.space/testnet4/api') },
      ethereum: { rpc: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com', chainId: 11155111, tokens: { USDC: USDC.sepolia } },
      base: { rpc: process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org', chainId: 84532, tokens: { USDC: USDC.baseSepolia } },
    },
    pollMs: 1500,
  });
  log('ika', 'Ika DKG with authority = Squads vault…');
  const prepared = await ika.prepareAccount({ owner: vault, mode: 'enforced', userShare: 'public', policy: defaultPolicy() });
  ok(`dWallet ${prepared.dwallets[0]!.address}; ${prepared.transactions.length} vault transactions to run`);
  await vaultExec('create_account', prepared.transactions[0]!);
  await vaultExec('transfer_ownership + register_dwallet', prepared.transactions[1]!);
  const account = await ika.waitForAccount({ owner: vault, dwallets: prepared.dwallets });
  ok(`account ${account.address.toBase58()} owned by the vault; addresses ${JSON.stringify(account.addresses)}`);

  // 3. Send proposed by the vault; the SDK continues from approve_intent.
  const eoa = account.addresses.ethereum!;
  const intentPda = account.nextIntentAddress();
  const ixs = await account.instructions.send({ chain: 'ethereum', asset: 'ETH', to: eoa, amount: 1n, evmMode: 'direct' });
  await vaultExec('propose_intent (send)', ixs);
  const handle = account.intent(intentPda);
  if (process.env.BROADCAST === '1') {
    const r = await handle.wait();
    ok(`broadcast + confirmed ${r.destinationTx}`);
  } else {
    const s = await handle.signOnly();
    const from = await recoverTransactionAddress({ serializedTransaction: s.rawTransaction as never as Hex & `0x02${string}` });
    if (from.toLowerCase() !== eoa.toLowerCase()) throw new Error('signature does not recover to the vault account EOA');
    ok(`approved (${s.solanaTx?.slice(0, 20)}…) and signed by Ika; tx recovers to the vault's EOA ${eoa}`);
  }
  signer.close();
  console.log('\n\x1b[1m\x1b[32mSquads v4 vault flow complete\x1b[0m');
}

main().catch((e) => {
  console.error('\n\x1b[31mFAILED\x1b[0m', e);
  process.exit(1);
});
