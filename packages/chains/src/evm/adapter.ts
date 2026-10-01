import {
  createPublicClient,
  erc20Abi,
  http,
  serializeTransaction,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializableEIP1559,
} from 'viem';
import type { AssetSymbol, EvmChain } from '../types.js';
import { ikaAccountAbi } from './ikaAccountArtifact.js';
import type { EvmCall } from './digests.js';
import type { EvmSignature } from './signature.js';

export interface EvmChainConfig {
  rpc: string;
  chainId: number;
  /** ERC-20 addresses by symbol (must also be in the program Config's token list). */
  tokens?: Partial<Record<AssetSymbol, Address>>;
  /** `IkaAccount` implementation (EIP-7702 delegate) on this chain, if delegated mode is used. */
  implementation?: Address;
  explorer?: string;
}

/** EIP-7702 delegation indicator: `0xef0100 ‖ address`. */
export function delegationTarget(code: Hex | undefined): Address | null {
  if (!code || !code.toLowerCase().startsWith('0xef0100') || code.length !== 2 + 46) return null;
  return `0x${code.slice(8)}` as Address;
}

export class EvmAdapter {
  readonly client: PublicClient;

  constructor(
    readonly chain: EvmChain,
    readonly config: EvmChainConfig,
  ) {
    this.client = createPublicClient({ transport: http(config.rpc) }) as PublicClient;
  }

  get chainId() {
    return this.config.chainId;
  }

  token(asset: AssetSymbol): Address | null {
    if (asset === 'ETH') return null;
    const t = this.config.tokens?.[asset];
    if (!t) throw new Error(`asset ${asset} is not configured on ${this.chain}`);
    return t;
  }

  async balance(address: Address, asset: AssetSymbol): Promise<bigint> {
    const token = this.token(asset);
    if (!token) return this.client.getBalance({ address });
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  }

  txNonce(address: Address): Promise<number> {
    return this.client.getTransactionCount({ address, blockTag: 'pending' });
  }

  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const f = await this.client.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  }

  async estimateGas(from: Address, call: EvmCall): Promise<bigint> {
    const g = await this.client.estimateGas({ account: from, to: call.to, value: call.value, data: call.data });
    return (g * 12n) / 10n; // 20% headroom
  }

  async delegation(address: Address): Promise<Address | null> {
    return delegationTarget(await this.client.getCode({ address }));
  }

  /** `IkaAccount.nonce()` at the EOA (only meaningful once delegated). */
  async ikaNonce(address: Address): Promise<bigint> {
    return this.client.readContract({ address, abi: ikaAccountAbi, functionName: 'nonce' }) as Promise<bigint>;
  }

  async recoveryState(address: Address) {
    const [recoveryKey, recoveryDelay, recoveryReadyAt, initialized] = (await this.client.readContract({
      address,
      abi: ikaAccountAbi,
      functionName: 'recoveryState',
    })) as readonly [Address, bigint, bigint, boolean];
    return { recoveryKey, recoveryDelay, recoveryReadyAt, initialized };
  }

  /** Broadcast a dWallet-signed EIP-1559 transaction (direct mode). */
  async broadcastDirect(tx: TransactionSerializableEIP1559, sig: EvmSignature): Promise<Hex> {
    const raw = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.yParity });
    return this.client.sendRawTransaction({ serializedTransaction: raw });
  }

  async waitForReceipt(hash: Hex, confirmations = 1) {
    return this.client.waitForTransactionReceipt({ hash, confirmations });
  }

  txUrl(hash: string): string | undefined {
    return this.config.explorer ? `${this.config.explorer.replace(/\/$/, '')}/tx/${hash}` : undefined;
  }
}
