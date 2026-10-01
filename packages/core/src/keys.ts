/** Secrets generated on device and returned once. The SDK never persists them. */
import { Buffer } from 'buffer';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { BitcoinNetworkName } from '@ika-portal/chains';

export const btcPath = (network: BitcoinNetworkName) => `m/84'/${network === 'mainnet' ? 0 : 1}'/0'/0/0`;
export const EVM_PATH = "m/44'/60'/0'/0/0";

export interface RecoverableKeys {
  mnemonic: string;
  btc: Uint8Array;
  evm: Uint8Array;
}

/** Standard derivation paths so the phrase restores in any BIP84 / BIP44 wallet. */
export function deriveRecoverableKeys(mnemonic: string, network: BitcoinNetworkName): RecoverableKeys {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid mnemonic');
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const btc = root.derive(btcPath(network)).privateKey;
  const evm = root.derive(EVM_PATH).privateKey;
  if (!btc || !evm) throw new Error('derivation failed');
  return { mnemonic, btc, evm };
}

export function newRecoverableKeys(network: BitcoinNetworkName): RecoverableKeys {
  return deriveRecoverableKeys(generateMnemonic(wordlist, 128), network);
}

export interface RecoveryKey {
  /** 32-byte private key, hex. Keep offline. */
  privateKey: `0x${string}`;
  /** 33-byte compressed public key, hex. */
  publicKey: string;
}

export function newRecoveryKey(): RecoveryKey {
  const sk = secp256k1.utils.randomSecretKey();
  return {
    privateKey: `0x${Buffer.from(sk).toString('hex')}`,
    publicKey: Buffer.from(secp256k1.getPublicKey(sk, true)).toString('hex'),
  };
}
