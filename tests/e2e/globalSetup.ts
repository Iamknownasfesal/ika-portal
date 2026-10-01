import type { TestProject } from 'vitest/node';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { LocalMockSigner } from '@ika-portal/signer';
import { keypairSigner, upsertConfig } from '@ika-portal/core';
import { startInfra, stopInfra, PROGRAMS, type InfraInfo } from './infra.js';

declare module 'vitest' {
  export interface ProvidedContext {
    infra: InfraInfo;
  }
}

export default async function setup(project: TestProject) {
  const suites = (process.env.E2E_SUITES ?? 'solana,evm,bitcoin').split(',');
  const info = await startInfra({ solana: true, evm: suites.includes('evm'), bitcoin: suites.includes('bitcoin') });
  const conn = new Connection(info.solanaRpc, 'confirmed');
  const admin = Keypair.fromSecretKey(Uint8Array.from(info.admin));
  await new LocalMockSigner({ connection: conn, payer: admin }).ensureInitialized();
  await upsertConfig(conn, keypairSigner(admin), {
    dwalletProgram: new PublicKey(PROGRAMS.mockDwallet),
    btcNetwork: 'regtest',
    evmChains: info.evm
      ? [
          { chain: 'ethereum', chainId: info.evm.ethereum.chainId, implementation: info.evm.ethereum.impl },
          { chain: 'base', chainId: info.evm.base.chainId, implementation: info.evm.base.impl },
        ]
      : [
          { chain: 'ethereum', chainId: 31337, implementation: '0x00000000000000000000000000000000000000E1' },
          { chain: 'base', chainId: 31338, implementation: '0x00000000000000000000000000000000000000BA' },
        ],
    tokens: info.evm
      ? [
          { chain: 'ethereum', address: info.evm.ethereum.usdc },
          { chain: 'base', address: info.evm.base.usdc },
        ]
      : [
          { chain: 'ethereum', address: '0x00000000000000000000000000000000000000c1' },
          { chain: 'base', address: '0x00000000000000000000000000000000000000c0' },
        ],
  });
  project.provide('infra', info);
  return async () => stopInfra();
}
