import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak256, getAddress, bytesToHex, type Address } from 'viem';

export interface EvmKeyInfo {
  address: Address;
  /** Uncompressed Y coordinate (32 bytes); `register_dwallet` verifies it on-chain. */
  y: Uint8Array;
  uncompressed: Uint8Array; // 65 bytes, 0x04-prefixed
}

export function evmKeyInfo(compressed: Uint8Array): EvmKeyInfo {
  if (compressed.length !== 33) throw new Error('expected a 33-byte compressed secp256k1 key');
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
  const hash = keccak256(uncompressed.slice(1));
  return {
    address: getAddress(`0x${hash.slice(-40)}`),
    y: uncompressed.slice(33, 65),
    uncompressed,
  };
}

export const evmAddress = (compressed: Uint8Array): Address => evmKeyInfo(compressed).address;

export const hex = (b: Uint8Array) => bytesToHex(b);
