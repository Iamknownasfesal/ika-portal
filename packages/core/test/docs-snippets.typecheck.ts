// Type-checks the integrator docs' main snippets against the real API (not executed).
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { IkaPortal, keypairSigner, defaultPolicy, IkaPortalError, upsertConfig, sendInstructions } from '../src/index.js';
import { IkaPreAlphaSigner, SolanaSignatureUnlocker, IKA_DEVNET_PROGRAM_ID } from '@ika-portal/signer';
import { btc, evm, recovery, USDC } from '@ika-portal/chains';
import { NearIntentsProvider, RelayProvider, LifiProvider, MockSwapProvider, createNearIntentsProxyHandler } from '@ika-portal/swap';

export async function snippets(owner: Keypair, signMessage: (m: Uint8Array) => Promise<Uint8Array>, vault: PublicKey) {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const ika = new IkaPortal({
    connection,
    signer: new IkaPreAlphaSigner({ connection, identity: Keypair.generate(), transport: 'web' }),
    unlocker: new SolanaSignatureUnlocker(signMessage),
    wallet: keypairSigner(owner),
    chains: {
      bitcoin: { network: 'testnet', backend: new btc.EsploraBackend('https://mempool.space/testnet4/api') },
      ethereum: { rpc: 'https://ethereum-sepolia-rpc.publicnode.com', chainId: 11155111, tokens: { USDC: USDC.sepolia } },
      base: { rpc: 'https://sepolia.base.org', chainId: 84532, tokens: { USDC: USDC.baseSepolia } },
    },
    swap: {
      providers: [new NearIntentsProvider({ baseUrl: 'https://x/1click' }), new RelayProvider({}), new LifiProvider({ integrator: 'w', feeWallet: '0x0' })],
      fees: { integrator: { recipient: 'fees.near', bps: 30 } },
      priority: ['near-intents', 'relay'],
      slippageBps: 100,
    },
  });
  const { account, recoveryKey, dwallets } = await ika.createAccount({
    owner: owner.publicKey, mode: 'enforced_recovery', userShare: 'public', policy: defaultPolicy(),
    recovery: { csvBlocks: 6, evmDelayS: 3600 }, onDWalletsCreated: (refs) => void refs,
  });
  await ika.loadAccount({ owner: owner.publicKey, index: 0, dwallets });
  const prepared = await account.prepareTransfer('send', { chain: 'base', asset: 'USDC', to: '0x0', amount: 1n });
  const check = account.checkPolicy(prepared);
  if (!check.ok) void check.error; else void check.executableAt;
  const intent = await account.send({ chain: 'ethereum', asset: 'ETH', to: '0x0', amount: 1n, evmMode: 'direct', deadlineS: 3600 });
  for await (const e of intent.progress()) void [e.status, e.destinationTxUrl, e.executableAt, e.instructions];
  const signed = await intent.signOnly(); void signed.rawTransaction;
  try { await intent.wait(); } catch (e) { if (e instanceof IkaPortalError) void e.code; }
  const { best } = await account.quoteSwap({ from: { chain: 'bitcoin', asset: 'BTC', amount: 1n }, to: { chain: 'base', asset: 'USDC' } });
  const s = await account.swap(best!); void (await s.wait()).status;
  await account.proposePolicy(defaultPolicy()); await account.applyPolicy(); await account.cancelPolicy();
  void (await account.listIntents())[0]?.publicKey; await account.intent(account.nextIntentAddress()).wait();
  await (await account.setupEvm('base')).wait(); await (await account.cancelEvmRecovery('base')).wait();
  const ixs = [...await account.instructions.send({ chain: 'ethereum', asset: 'ETH', to: '0x0', amount: 1n }), ...await account.instructions.setEvmNonce('base', 1n)];
  await sendInstructions(connection, ixs, keypairSigner(owner), [keypairSigner(owner)]);
  const p = await ika.prepareAccount({ owner: vault, mode: 'enforced', userShare: 'public', policy: defaultPolicy() });
  void p.transactions; await ika.waitForAccount({ owner: vault, dwallets: p.dwallets });
  await upsertConfig(connection, keypairSigner(owner), { dwalletProgram: IKA_DEVNET_PROGRAM_ID, btcNetwork: 'testnet', maxBtcInputs: 4, evmChains: [{ chain: 'base', chainId: 84532 }], tokens: [{ chain: 'base', address: USDC.baseSepolia }] });
  const r = await recovery.bitcoin.buildRecoveryTx({ recoveryKey: new Uint8Array(32), account: { dwalletPubkey: account.view.btcPubkey!, recoveryPubkey: account.view.recoveryPubkey!, csvBlocks: account.view.csvBlocks, network: 'testnet' }, to: 'tb1q', feeRate: 5, backend: new btc.EsploraBackend('x') });
  void r.hex; void recoveryKey?.privateKey;
  await recovery.evm.initiateRecovery({ recoveryKey: '0x00', account: '0x00', rpc: 'x', chainId: 1 });
  void (await new evm.EvmAdapter('base', { rpc: 'x', chainId: 1 }).recoveryState('0x00')).recoveryReadyAt;
  void new MockSwapProvider({ rates: { 'BTC/USDC': '60000' }, depositAddresses: { bitcoin: 'tb1q' }, payout: async () => '0x' });
  void createNearIntentsProxyHandler({ jwt: 'x', enforceAppFees: [{ recipient: 'a.near', fee: 30 }], responseHeaders: {} });
}
