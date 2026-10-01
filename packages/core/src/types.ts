import type { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { AssetSymbol, BitcoinNetworkName, Chain, EvmChain } from '@ika-portal/chains';
import type { btc, evm } from '@ika-portal/chains';
import type { ShareUnlocker, SignerBackend, UserShareMode } from '@ika-portal/signer';
import type { FeeConfig, SwapProvider } from '@ika-portal/swap';

export type { AssetSymbol, Chain, EvmChain, BitcoinNetworkName } from '@ika-portal/chains';
export type { UserShareMode } from '@ika-portal/signer';

export type Mode = 'recoverable' | 'enforced' | 'enforced_recovery';
export type IntentKind = 'send' | 'swap' | 'evm_setup' | 'evm_cancel_recovery';
export type IntentStatus = 'proposed' | 'approved' | 'cancelled';

/** Anything that can sign Solana transactions: a Keypair wrapper or a wallet-adapter wallet. */
export interface TxSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

export interface Limit {
  chain: Chain;
  asset: AssetSymbol;
  maxPerWindow: bigint;
  windowS: number;
}

export interface AllowEntry {
  chain: Chain;
  /** EVM 0x address or Bitcoin address. */
  address: string;
}

export interface DelayThreshold {
  chain: Chain;
  asset: AssetSymbol;
  amount: bigint;
}

export interface Policy {
  limits: Limit[];
  allowlistEnabled: boolean;
  allowlist: AllowEntry[];
  delayThresholds: DelayThreshold[];
  delayS: number;
  swapsEnabled: boolean;
  swapLimits: Limit[];
  maxBtcFeeSats: bigint;
  /** Cap on gas_limit × max_fee_per_gas for direct (self-paid) EVM transactions. */
  maxEvmFeeWei: bigint;
  policyChangeDelayS: number;
}

export const defaultPolicy = (overrides: Partial<Policy> = {}): Policy => ({
  limits: [],
  allowlistEnabled: false,
  allowlist: [],
  delayThresholds: [],
  delayS: 0,
  swapsEnabled: true,
  swapLimits: [],
  maxBtcFeeSats: 50_000n,
  maxEvmFeeWei: 5_000_000_000_000_000n, // 0.005 ETH
  policyChangeDelayS: 86_400,
  ...overrides,
});

export interface RecoveryConfig {
  /** Bitcoin CSV delay in blocks (default 4320 ≈ 30 days; 6 on test networks). */
  csvBlocks?: number;
  /** EVM `IkaAccount` recovery delay in seconds. */
  evmDelayS?: number;
}

export interface BitcoinChainConfig {
  network: BitcoinNetworkName;
  backend: btc.BitcoinBackend;
  explorer?: string;
}

export interface ChainsConfig {
  bitcoin?: BitcoinChainConfig;
  ethereum?: evm.EvmChainConfig;
  base?: evm.EvmChainConfig;
}

export interface IkaPortalOptions {
  connection: Connection;
  programId?: PublicKey;
  signer: SignerBackend;
  /** Required for encrypted-share accounts. */
  unlocker?: ShareUnlocker;
  /** The owner's wallet (signs owner instructions). Omit for instruction-building only. */
  wallet?: TxSigner;
  /** Pays for permissionless instructions (approve_intent). Defaults to `wallet`. */
  feePayer?: TxSigner;
  chains: ChainsConfig;
  relayerUrl?: string;
  swap?: { providers: SwapProvider[]; fees: FeeConfig; priority?: string[]; slippageBps?: number };
  /** Poll interval for waiting on chain state (ms). */
  pollMs?: number;
}

export interface CreateAccountArgs {
  owner: PublicKey;
  mode: Mode;
  userShare: UserShareMode;
  policy: Policy;
  index?: number;
  recovery?: RecoveryConfig;
  /** Called as soon as dWallets exist (before any owner signature), so refs can be persisted even if a later step fails. */
  onDWalletsCreated?: (refs: import('@ika-portal/signer').DWalletRef[]) => void | Promise<void>;
}

export interface Addresses {
  bitcoin?: string;
  ethereum?: `0x${string}`;
  base?: `0x${string}`;
}

export interface SendArgs {
  chain: Chain;
  asset: AssetSymbol;
  to: string;
  amount: bigint;
  /** EVM only. Default: `delegated` if the account is set up on that chain, else `direct`. */
  evmMode?: 'direct' | 'delegated';
  /** EVM delegated only: seconds until the signed Execute expires (default 3600). */
  deadlineS?: number;
}

export type ProgressStatus =
  | 'building'
  | 'awaiting_owner'
  | 'proposed'
  | 'delayed'
  | 'approved'
  | 'signed'
  | 'broadcast'
  | 'confirmed'
  | 'cancelled'
  | 'failed';

export interface ProgressEvent {
  status: ProgressStatus;
  intent?: PublicKey;
  /** Unix seconds when a delayed intent becomes approvable. */
  executableAt?: number;
  solanaTx?: string;
  destinationTx?: string;
  destinationTxUrl?: string;
  /** For PDA owners: the instructions to execute from the owner (e.g. a Squads vault transaction). */
  instructions?: import('@solana/web3.js').TransactionInstruction[];
  error?: Error;
}

export type { EvmChain as EvmChainName };
