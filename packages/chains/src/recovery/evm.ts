/**
 * Offline EVM recovery for `enforced_recovery` accounts, sent directly from
 * the recovery key (it pays its own gas). No Ika, no Solana.
 */
import { createWalletClient, createPublicClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ikaAccountAbi } from '../evm/ikaAccountArtifact.js';

export interface EvmRecoveryArgs {
  recoveryKey: Hex; // 0x-prefixed 32-byte private key
  account: Address; // the dWallet EOA delegated to IkaAccount
  rpc: string;
  chainId: number;
}

function clients(a: EvmRecoveryArgs) {
  const signer = privateKeyToAccount(a.recoveryKey);
  const chain = { id: a.chainId, name: `chain-${a.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [a.rpc] } } };
  return {
    signer,
    wallet: createWalletClient({ account: signer, chain, transport: http(a.rpc) }),
    pub: createPublicClient({ chain, transport: http(a.rpc) }),
  };
}

export async function initiateRecovery(a: EvmRecoveryArgs): Promise<{ hash: Hex; readyAt: bigint }> {
  const { wallet, pub } = clients(a);
  const hash = await wallet.writeContract({ address: a.account, abi: ikaAccountAbi, functionName: 'initiateRecovery', args: [] });
  await pub.waitForTransactionReceipt({ hash });
  const [, , readyAt] = (await pub.readContract({ address: a.account, abi: ikaAccountAbi, functionName: 'recoveryState' })) as readonly [Address, bigint, bigint, boolean];
  return { hash, readyAt };
}

export async function recoveryExecute(a: EvmRecoveryArgs & { to: Address; value: bigint; data?: Hex }): Promise<Hex> {
  const { wallet, pub } = clients(a);
  const hash = await wallet.writeContract({
    address: a.account,
    abi: ikaAccountAbi,
    functionName: 'recoveryExecute',
    args: [a.to, a.value, a.data ?? '0x'],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`recoveryExecute reverted: ${hash}`);
  return hash;
}
