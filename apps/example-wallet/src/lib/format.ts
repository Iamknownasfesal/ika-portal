import { formatUnits, parseUnits } from 'viem';
import type { AssetSymbol, Chain } from '@ika-portal/core';

export const DECIMALS: Record<AssetSymbol, number> = { BTC: 8, ETH: 18, USDC: 6 };
export const CHAINS: Chain[] = ['bitcoin', 'ethereum', 'base'];
export const CHAIN_LABEL: Record<Chain, string> = { bitcoin: 'Bitcoin testnet4', ethereum: 'Ethereum Sepolia', base: 'Base Sepolia' };
export const ASSETS_ON: Record<Chain, AssetSymbol[]> = { bitcoin: ['BTC'], ethereum: ['ETH', 'USDC'], base: ['ETH', 'USDC'] };

export const fmt = (v: bigint | undefined, asset: AssetSymbol, maxFrac = 8): string => {
  if (v === undefined) return '—';
  const s = formatUnits(v, DECIMALS[asset]);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i!;
};

/** Parse a human amount; returns null for invalid input. */
export const parseAmount = (s: string, asset: AssetSymbol): bigint | null => {
  const t = s.trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  try {
    return parseUnits(t.replace(/\.$/, ''), DECIMALS[asset]);
  } catch {
    return null;
  }
};

export const short = (s: string, n = 6) => (s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);

export function duration(s: number): string {
  if (s <= 0) return '0s';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && sec && `${sec}s`].filter(Boolean);
  return parts.slice(0, 3).join(' ') || '0s';
}

export const now = () => Math.floor(Date.now() / 1000);

export const isHex = (s: string) => /^(0x)?[0-9a-fA-F]*$/.test(s);
export const hexToBytes = (h: string) => {
  const s = h.trim().replace(/^0x/, '');
  if (s.length % 2 || !isHex(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
