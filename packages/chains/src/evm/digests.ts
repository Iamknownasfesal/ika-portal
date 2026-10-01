/**
 * Off-chain mirror of the program's EVM digest construction
 * (programs/ika_account/src/digest.rs). Byte-for-byte parity is enforced by
 * tests/parity against the program and against viem's own hashers.
 */
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  serializeTransaction,
  toBytes,
  toHex,
  toRlp,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export const EXECUTE_TYPE = 'Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)';
export const INIT_TYPE = 'Init(address recoveryKey,uint256 recoveryDelay)';
export const CANCEL_RECOVERY_TYPE = 'CancelRecovery(uint256 nonce,uint256 deadline)';

export const ikaDomain = (chainId: number, account: Address) =>
  ({ name: 'IkaAccount', version: '1', chainId, verifyingContract: account }) as const;

export const executeTypes = {
  Execute: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
export const initTypes = {
  Init: [
    { name: 'recoveryKey', type: 'address' },
    { name: 'recoveryDelay', type: 'uint256' },
  ],
} as const;
export const cancelRecoveryTypes = {
  CancelRecovery: [
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** A preimage Ika signs after applying `scheme`'s hash (always Keccak-256 for EVM). */
export interface EvmSignable {
  preimage: Uint8Array;
  /** keccak256(preimage): both the Ika approval key and the signed digest. */
  digest: Hex;
}

const signable = (preimage: Hex): EvmSignable => ({ preimage: toBytes(preimage), digest: keccak256(preimage) });

export interface EvmCall {
  to: Address;
  value: bigint;
  data: Hex;
}

/** Native sends go to the recipient with empty data; ERC-20 sends call `transfer`. */
export function evmCall(token: Address | null, to: Address, amount: bigint): EvmCall {
  if (!token || token === ZERO_ADDRESS) return { to, value: amount, data: '0x' };
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  };
}

const u256 = (v: bigint | number) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(v)]);
const addr = (a: Address) => encodeAbiParameters([{ type: 'address' }], [a]);

export function domainSeparator(chainId: number, account: Address): Hex {
  return keccak256(
    concat([
      keccak256(toHex(EIP712_DOMAIN_TYPE)),
      keccak256(toHex('IkaAccount')),
      keccak256(toHex('1')),
      u256(chainId),
      addr(account),
    ]),
  );
}

const eip712 = (chainId: number, account: Address, structHash: Hex) =>
  signable(concat(['0x1901', domainSeparator(chainId, account), structHash]));

export function executeSignable(chainId: number, account: Address, call: EvmCall, nonce: bigint, deadline: bigint) {
  const sh = keccak256(
    concat([keccak256(toHex(EXECUTE_TYPE)), addr(call.to), u256(call.value), keccak256(call.data), u256(nonce), u256(deadline)]),
  );
  return eip712(chainId, account, sh);
}

export function initSignable(chainId: number, account: Address, recoveryKey: Address, recoveryDelay: bigint) {
  const sh = keccak256(concat([keccak256(toHex(INIT_TYPE)), addr(recoveryKey), u256(recoveryDelay)]));
  return eip712(chainId, account, sh);
}

export function cancelRecoverySignable(chainId: number, account: Address, nonce: bigint, deadline: bigint) {
  const sh = keccak256(concat([keccak256(toHex(CANCEL_RECOVERY_TYPE)), u256(nonce), u256(deadline)]));
  return eip712(chainId, account, sh);
}

const rlpInt = (n: bigint | number) => (BigInt(n) === 0n ? '0x' : toHex(BigInt(n)));

/** EIP-7702 authorization: `0x05 ‖ rlp([chain_id, address, nonce])`. */
export function authorizationSignable(chainId: number, implementation: Address, eoaNonce: bigint | number) {
  return signable(concat(['0x05', toRlp([rlpInt(chainId), implementation, rlpInt(eoaNonce)])]));
}

export interface DirectTxFields {
  chainId: number;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export function eip1559Tx(f: DirectTxFields, call: EvmCall): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: f.chainId,
    nonce: f.nonce,
    gas: f.gas,
    maxFeePerGas: f.maxFeePerGas,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    to: call.to,
    value: call.value,
    data: call.data,
    accessList: [],
  };
}

/** Unsigned EIP-1559 payload `0x02 ‖ rlp([...])`: exactly what gets signed. */
export function eip1559Signable(tx: TransactionSerializableEIP1559) {
  return signable(serializeTransaction(tx));
}
