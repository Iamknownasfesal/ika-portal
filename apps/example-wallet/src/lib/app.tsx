import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { IkaPortal, IkaPortalError, type Chain, type IkaAccountHandle } from '@ika-portal/core';
import { IkaPreAlphaSigner, SolanaSignatureUnlocker } from '@ika-portal/signer';
import { btc, USDC } from '@ika-portal/chains';
import { MockSwapProvider, NearIntentsProvider, type SwapProvider } from '@ika-portal/swap';
import { config, EVM } from '../config';
import { loadRefs, prefs, rememberAccount, sessionKey } from './storage';

export type AccountStatus = 'idle' | 'loading' | 'missing' | 'ready' | 'error';

interface AppState {
  ika: IkaPortal | null;
  signer: IkaPreAlphaSigner | null;
  initState: 'idle' | 'loading' | 'ready' | 'error';
  initError: unknown;
  walletConnected: boolean;
  vaultMode: boolean;
  setVaultMode(v: boolean): void;
  vaultAddress: string;
  setVaultAddress(v: string): void;
  /** The account owner: the connected wallet, or the Squads vault PDA. */
  owner: PublicKey | null;
  ownerError: string | null;
  /** True when the owner is off-curve (PDA): actions produce instructions instead of signing. */
  ownerIsPda: boolean;
  index: number;
  setIndex(i: number): void;
  account: IkaAccountHandle | null;
  accountStatus: AccountStatus;
  accountError: unknown;
  reloadAccount(): Promise<void>;
  setAccount(a: IkaAccountHandle): void;
  /** Mutable deposit map for the demo swap provider (filled with the account's own addresses). */
  mockDeposits: Partial<Record<Chain, string>>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export const PROVIDER_LABEL: Record<string, string> = {
  mock: 'Demo provider',
  'near-intents': 'NEAR Intents: mainnet dry quotes only; not executable on testnets',
};

function mockPayoutHash() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const [vaultMode, setVaultModeState] = useState<boolean>(() => prefs.get('vaultMode', false));
  const [vaultAddress, setVaultAddressState] = useState<string>(() => prefs.get('vaultAddress', ''));
  const [index, setIndexState] = useState<number>(() => prefs.get('index', 0));
  const setVaultMode = (v: boolean) => (setVaultModeState(v), prefs.set('vaultMode', v));
  const setVaultAddress = (v: string) => (setVaultAddressState(v), prefs.set('vaultAddress', v));
  const setIndex = (i: number) => (setIndexState(i), prefs.set('index', i));

  const walletKey = wallet.publicKey?.toBase58() ?? null;
  const mockDeposits = useMemo<Partial<Record<Chain, string>>>(() => ({}), []);

  const { ika, signer } = useMemo(() => {
    if (!walletKey) return { ika: null, signer: null };
    const signer = new IkaPreAlphaSigner({
      connection,
      identity: sessionKey(),
      transport: 'web',
      grpcUrl: config.ikaGrpcUrl,
      programId: config.dwalletProgramId,
    });
    const providers: SwapProvider[] = [
      new MockSwapProvider({
        id: 'mock',
        rates: { 'BTC/USDC': '60000', 'ETH/USDC': '3000', 'BTC/ETH': '20' },
        depositAddresses: mockDeposits,
        payout: async (p) => {
          const hash = mockPayoutHash();
          console.info('[demo swap provider] would pay out', { ...p, amount: p.amount.toString() }, '→ fake tx', hash);
          return hash;
        },
      }),
    ];
    if (config.nearProxyUrl) providers.push(new NearIntentsProvider({ baseUrl: config.nearProxyUrl }));
    const ika = new IkaPortal({
      connection,
      programId: config.programId,
      signer,
      unlocker: new SolanaSignatureUnlocker(async (msg) => {
        const w = walletRef.current;
        if (!w.signMessage) throw new IkaPortalError('ShareLocked', 'this wallet cannot sign messages, so it cannot unlock an encrypted user share');
        return w.signMessage(msg);
      }),
      wallet: {
        publicKey: new PublicKey(walletKey),
        signTransaction: <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
          const w = walletRef.current;
          if (!w.signTransaction) throw new IkaPortalError('WalletCannotSign', 'the connected wallet cannot sign transactions');
          return w.signTransaction(tx);
        },
      },
      chains: {
        bitcoin: { network: 'testnet', backend: new btc.EsploraBackend(config.esploraUrl), explorer: config.btcExplorer },
        ethereum: { rpc: config.sepoliaRpc, chainId: EVM.ethereum.chainId, tokens: { USDC: USDC.sepolia }, explorer: EVM.ethereum.explorer },
        base: { rpc: config.baseSepoliaRpc, chainId: EVM.base.chainId, tokens: { USDC: USDC.baseSepolia }, explorer: EVM.base.explorer },
      },
      relayerUrl: config.relayerUrl,
      swap: { providers, fees: { integrator: { recipient: config.integratorFeeRecipient, bps: config.integratorFeeBps } } },
      pollMs: 1500,
    });
    return { ika, signer };
  }, [connection, walletKey, mockDeposits]);

  const [initState, setInitState] = useState<AppState['initState']>('idle');
  const [initError, setInitError] = useState<unknown>(null);
  useEffect(() => {
    if (!ika) {
      setInitState('idle');
      return;
    }
    let live = true;
    setInitState('loading');
    ika.init().then(
      () => live && setInitState('ready'),
      (e) => {
        if (!live) return;
        setInitError(e);
        setInitState('error');
      },
    );
    return () => {
      live = false;
    };
  }, [ika]);

  let owner: PublicKey | null = null;
  let ownerError: string | null = null;
  if (vaultMode) {
    try {
      owner = vaultAddress.trim() ? new PublicKey(vaultAddress.trim()) : null;
      if (!owner) ownerError = 'Enter the Squads vault address';
    } catch {
      ownerError = 'Invalid vault address';
    }
  } else if (wallet.publicKey) {
    owner = wallet.publicKey;
  }
  const ownerKey = owner?.toBase58() ?? null;
  const ownerIsPda = !!owner && !PublicKey.isOnCurve(owner.toBytes());

  const [account, setAccountState] = useState<IkaAccountHandle | null>(null);
  const [accountStatus, setAccountStatus] = useState<AccountStatus>('idle');
  const [accountError, setAccountError] = useState<unknown>(null);
  const loadSeq = useRef(0);

  const fillDeposits = useCallback(
    (a: IkaAccountHandle) => {
      const addrs = a.addresses;
      mockDeposits.bitcoin = config.mockDepositBtc ?? addrs.bitcoin;
      mockDeposits.ethereum = config.mockDepositEvm ?? addrs.ethereum;
      mockDeposits.base = config.mockDepositEvm ?? addrs.base;
    },
    [mockDeposits],
  );

  const setAccount = useCallback(
    (a: IkaAccountHandle) => {
      fillDeposits(a);
      rememberAccount({ owner: a.owner.toBase58(), index: a.view.index });
      setAccountState(a);
      setAccountStatus('ready');
      setAccountError(null);
    },
    [fillDeposits],
  );

  const reloadAccount = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!ika || initState !== 'ready' || !ownerKey) {
      setAccountState(null);
      setAccountStatus('idle');
      return;
    }
    setAccountStatus('loading');
    try {
      const a = await ika.loadAccount({ owner: new PublicKey(ownerKey), index, dwallets: loadRefs(ownerKey, index) });
      if (seq !== loadSeq.current) return;
      setAccount(a);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setAccountState(null);
      if (e instanceof IkaPortalError && e.code === 'AccountNotFound') {
        setAccountStatus('missing');
        setAccountError(null);
      } else {
        setAccountStatus('error');
        setAccountError(e);
      }
    }
  }, [ika, initState, ownerKey, index, setAccount]);

  useEffect(() => {
    void reloadAccount();
  }, [reloadAccount]);

  const value: AppState = {
    ika,
    signer,
    initState,
    initError,
    walletConnected: !!wallet.publicKey,
    vaultMode,
    setVaultMode,
    vaultAddress,
    setVaultAddress,
    owner,
    ownerError,
    ownerIsPda,
    index,
    setIndex,
    account,
    accountStatus,
    accountError,
    reloadAccount,
    setAccount,
    mockDeposits,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
