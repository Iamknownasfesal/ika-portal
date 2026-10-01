import { PublicKey } from '@solana/web3.js';
import { IKA_ACCOUNT_PROGRAM_ID } from '@ika-portal/core';
import { IKA_DEVNET_PROGRAM_ID } from '@ika-portal/signer';

const env = import.meta.env;
const str = (v: string | undefined, d: string) => (v && v.trim() ? v.trim() : d);
const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export const config = {
  solanaRpc: str(env.VITE_SOLANA_RPC, 'https://api.devnet.solana.com'),
  programId: new PublicKey(str(env.VITE_PROGRAM_ID, IKA_ACCOUNT_PROGRAM_ID.toBase58())),
  dwalletProgramId: new PublicKey(str(env.VITE_IKA_DWALLET_PROGRAM_ID, IKA_DEVNET_PROGRAM_ID.toBase58())),
  ikaGrpcUrl: opt(env.VITE_IKA_GRPC_URL),
  relayerUrl: opt(env.VITE_RELAYER_URL),
  esploraUrl: str(env.VITE_ESPLORA_URL, 'https://mempool.space/testnet4/api'),
  btcExplorer: str(env.VITE_BTC_EXPLORER, 'https://mempool.space/testnet4'),
  sepoliaRpc: str(env.VITE_SEPOLIA_RPC, 'https://ethereum-sepolia-rpc.publicnode.com'),
  baseSepoliaRpc: str(env.VITE_BASE_SEPOLIA_RPC, 'https://sepolia.base.org'),
  nearProxyUrl: opt(env.VITE_NEAR_PROXY_URL),
  mockDepositBtc: opt(env.VITE_MOCK_DEPOSIT_BTC),
  mockDepositEvm: opt(env.VITE_MOCK_DEPOSIT_EVM),
  integratorFeeRecipient: str(env.VITE_INTEGRATOR_FEE_RECIPIENT, '0x000000000000000000000000000000000000dEaD'),
  integratorFeeBps: Number(str(env.VITE_INTEGRATOR_FEE_BPS, '30')),
};

export const EVM = {
  ethereum: { chainId: 11155111, name: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io' },
  base: { chainId: 84532, name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
} as const;

export const solscanTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const solscanAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
export const addrUrl = (chain: 'bitcoin' | 'ethereum' | 'base', a: string) =>
  chain === 'bitcoin' ? `${config.btcExplorer}/address/${a}` : `${EVM[chain].explorer}/address/${a}`;
