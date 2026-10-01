import type { AssetSymbol, Chain } from './types.js';

export const ASSET_DECIMALS: Record<AssetSymbol, number> = {
  BTC: 8,
  ETH: 18,
  USDC: 6,
};

/** Which assets exist natively on which chain in the MVP. */
export const CHAIN_ASSETS: Record<Chain, readonly AssetSymbol[]> = {
  bitcoin: ['BTC'],
  ethereum: ['ETH', 'USDC'],
  base: ['ETH', 'USDC'],
};

/** Mainnet ERC-20 contracts (lowercase). Native assets are absent. */
export const EVM_TOKEN_ADDRESSES: Partial<Record<`${Chain}:${AssetSymbol}`, string>> = {
  'ethereum:USDC': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  'base:USDC': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};

export const EVM_CHAIN_IDS: Record<Exclude<Chain, 'bitcoin'>, number> = {
  ethereum: 1,
  base: 8453,
};

export type AssetKey = `${Chain}:${AssetSymbol}`;

export function assetKey(chain: Chain, asset: AssetSymbol): AssetKey {
  return `${chain}:${asset}`;
}

export function isSupportedAsset(chain: Chain, asset: AssetSymbol): boolean {
  return CHAIN_ASSETS[chain].includes(asset);
}

export function isNative(chain: Chain, asset: AssetSymbol): boolean {
  return (chain === 'bitcoin' && asset === 'BTC') || (chain !== 'bitcoin' && asset === 'ETH');
}
