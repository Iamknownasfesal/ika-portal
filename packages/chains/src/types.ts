export type Chain = 'bitcoin' | 'ethereum' | 'base';
export type EvmChain = Exclude<Chain, 'bitcoin'>;
export type AssetSymbol = 'BTC' | 'ETH' | 'USDC';
export type BitcoinNetworkName = 'mainnet' | 'testnet' | 'regtest';

export const CHAINS: readonly Chain[] = ['bitcoin', 'ethereum', 'base'] as const;
export const EVM_CHAINS: readonly EvmChain[] = ['ethereum', 'base'] as const;

export const isEvmChain = (c: Chain): c is EvmChain => c !== 'bitcoin';

export const NATIVE: Record<Chain, AssetSymbol> = { bitcoin: 'BTC', ethereum: 'ETH', base: 'ETH' };

export const DECIMALS: Record<AssetSymbol, number> = { BTC: 8, ETH: 18, USDC: 6 };

/** ERC-20 addresses per EVM chain, e.g. `{ base: { USDC: '0x…' } }`. */
export type TokenRegistry = Partial<Record<EvmChain, Partial<Record<AssetSymbol, `0x${string}`>>>>;

/** Well-known USDC deployments. */
export const USDC = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  baseSepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const;

export class ChainsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ChainsError';
  }
}
