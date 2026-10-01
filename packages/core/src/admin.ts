/** Program administration (deploy scripts, local tests). */
import { PublicKey, type Connection } from '@solana/web3.js';
import { getAddress, type Address } from 'viem';
import { encChain, hexToBytes } from './codec.js';
import { IkaProgram } from './program.js';
import { sendInstructions } from './tx.js';
import type { BitcoinNetworkName, EvmChain, TxSigner } from './types.js';

export interface ConfigInput {
  dwalletProgram: PublicKey;
  btcNetwork: BitcoinNetworkName;
  maxBtcInputs?: number;
  evmChains: { chain: EvmChain; chainId: number; implementation?: Address }[];
  tokens: { chain: EvmChain; address: Address }[];
}

const addr20 = (a?: Address) => Array.from(a ? hexToBytes(getAddress(a)) : new Uint8Array(20));

export function encodeConfig(c: ConfigInput) {
  return {
    dwalletProgram: c.dwalletProgram,
    btcNetwork: { [c.btcNetwork]: {} },
    maxBtcInputs: c.maxBtcInputs ?? 4,
    evmChains: c.evmChains.map((e) => ({ chain: encChain(e.chain), chainId: new (IkaProgram.bn())(e.chainId), implementation: addr20(e.implementation) })),
    tokens: c.tokens.map((t) => ({ chain: encChain(t.chain), address: addr20(t.address) })),
  };
}

/** Create or update the program Config. */
export async function upsertConfig(connection: Connection, admin: TxSigner, input: ConfigInput, programId?: PublicKey) {
  const program = new IkaProgram(connection, programId);
  const exists = await connection.getAccountInfo(program.configPda());
  const args = encodeConfig(input);
  const ix = exists ? await program.updateConfig(admin.publicKey, args) : await program.initializeConfig(admin.publicKey, args);
  return sendInstructions(connection, [ix], admin);
}
