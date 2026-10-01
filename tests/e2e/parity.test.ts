/**
 * Digest parity: on-chain digests (program return data from
 * `preview_digests`) must equal viem `hashTypedData` / `hashAuthorization` /
 * EIP-1559 hashes and bitcoinjs `hashForWitnessV0`, for randomized vectors.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import BN from 'bn.js';
import * as bitcoin from 'bitcoinjs-lib';
import { hashTypedData, keccak256, serializeTransaction, getAddress, type Address } from 'viem';
import { hashAuthorization } from 'viem/utils';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { btc, evm } from '@ika-portal/chains';
import { buildFromIntent, defaultPolicy, type IkaAccountHandle, type IkaPortal } from '@ika-portal/core';
import { fundedKeypair, sdk } from './helpers.js';

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const rnd = (n: number) => BigInt(`0x${bytesToHex(randomBytes(n))}`);
const addr = () => getAddress(`0x${bytesToHex(randomBytes(20))}`);
const bn = (v: bigint | number) => new BN(v.toString());
const chainEnum = (c: string) => ({ [c]: {} });

let ika: IkaPortal;
let enforced: IkaAccountHandle;
let recovery: IkaAccountHandle;
let recoverable: IkaAccountHandle;

beforeAll(async () => {
  const owner = await fundedKeypair();
  ika = sdk(owner);
  const policy = defaultPolicy({ policyChangeDelayS: 0 });
  enforced = (await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'public', policy })).account;
  recovery = (await ika.createAccount({ owner: owner.publicKey, index: 1, mode: 'enforced_recovery', userShare: 'public', policy, recovery: { csvBlocks: 6, evmDelayS: 3600 } })).account;
  recoverable = (await ika.createAccount({ owner: owner.publicKey, index: 2, mode: 'recoverable', userShare: 'public', policy })).account;
});

async function onchain(account: IkaAccountHandle, params: object, evmNonce: bigint) {
  return ika.program.previewDigests(account.address, params, evmNonce, account.owner);
}

describe('EVM digest parity', () => {
  for (const chain of ['ethereum', 'base'] as const) {
    it(`${chain}: direct EIP-1559 / delegated Execute / setup / cancel (randomized)`, async () => {
      const cfg = await ika.init();
      const ec = cfg.evmChains.find((c) => c.chain === chain)!;
      const usdc = cfg.tokens.find((t) => t.chain === chain)!.address;
      for (let i = 0; i < 6; i++) {
        const account = i % 2 ? recovery : enforced;
        const eoa = account.view.evmAddress!;
        const token = i % 3 === 0 ? usdc : null;
        const to = addr();
        const amount = rnd(7) + 1n;
        const base = { kind: { send: {} }, chain: chainEnum(chain), asset: Array.from(Buffer.from((token ?? '0x' + '00'.repeat(20)).slice(2), 'hex')), to: Buffer.from(to.slice(2), 'hex'), amount: bn(amount), btc: null };
        const call = evm.evmCall(token, to, amount);

        // Direct
        const d = { nonce: rnd(2), gas: 21_000n + rnd(2), maxFeePerGas: rnd(5), maxPriorityFeePerGas: rnd(4) };
        const direct = { ...base, evm: { direct: { nonce: bn(d.nonce), gasLimit: bn(d.gas), maxFeePerGas: bn(d.maxFeePerGas), maxPriorityFeePerGas: bn(d.maxPriorityFeePerGas) } } };
        const [pd] = await onchain(account, direct, 0n);
        const viemDirect = keccak256(
          serializeTransaction({ type: 'eip1559', chainId: ec.chainId, nonce: Number(d.nonce), gas: d.gas, maxFeePerGas: d.maxFeePerGas, maxPriorityFeePerGas: d.maxPriorityFeePerGas, to: call.to, value: call.value, data: call.data, accessList: [] }),
        );
        expect(hex(pd!.finalDigest)).toBe(viemDirect);
        const sdkBuilt = buildFromIntent((ika as unknown as { ctx: never }).ctx, account.view, { params: direct, evmNonce: bn(0) });
        expect(keccak256(sdkBuilt.preimages[0]!)).toBe(viemDirect);

        // Delegated Execute
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600) + rnd(2);
        const nonce = rnd(3);
        const [pe] = await onchain(account, { ...base, evm: { delegated: { deadline: bn(deadline) } } }, nonce);
        expect(hex(pe!.finalDigest)).toBe(
          hashTypedData({ domain: evm.ikaDomain(ec.chainId, eoa), types: evm.executeTypes, primaryType: 'Execute', message: { ...call, nonce, deadline } }),
        );

        // Setup: authorization + Init
        const eoaNonce = Number(rnd(1));
        const setup = { ...base, kind: { evmSetup: {} }, to: Buffer.alloc(0), amount: bn(0), asset: new Array(20).fill(0), evm: { setup: { eoaNonce: bn(eoaNonce) } } };
        const [pa, pi] = await onchain(account, setup, 0n);
        expect(hex(pa!.finalDigest)).toBe(hashAuthorization({ chainId: ec.chainId, address: ec.implementation, nonce: eoaNonce }));
        const rk: Address = account.mode === 'enforced_recovery' ? account.view.recoveryEvmAddress! : '0x0000000000000000000000000000000000000000';
        const rd = account.mode === 'enforced_recovery' ? BigInt(account.view.recoveryDelayS) : 0n;
        expect(hex(pi!.finalDigest)).toBe(
          hashTypedData({ domain: evm.ikaDomain(ec.chainId, eoa), types: evm.initTypes, primaryType: 'Init', message: { recoveryKey: rk, recoveryDelay: rd } }),
        );

        // CancelRecovery (recovery accounts only)
        if (account === recovery) {
          const [pc] = await onchain(account, { ...setup, kind: { evmCancelRecovery: {} }, evm: { cancelRecovery: { deadline: bn(deadline) } } }, nonce);
          expect(hex(pc!.finalDigest)).toBe(
            hashTypedData({ domain: evm.ikaDomain(ec.chainId, eoa), types: evm.cancelRecoveryTypes, primaryType: 'CancelRecovery', message: { nonce, deadline } }),
          );
        }
      }
    });
  }
});

describe('Bitcoin BIP143 parity', () => {
  for (const which of ['p2wpkh', 'p2wsh-dwallet-branch'] as const) {
    it(`${which} (randomized, 1–4 inputs, with and without change)`, async () => {
      const account = which === 'p2wpkh' ? enforced : recovery;
      for (const acct of which === 'p2wpkh' ? [enforced, recoverable] : [recovery]) {
        const lock = (ika as unknown as { ctx: { btcLock: (v: unknown) => btc.BtcLock } }).ctx.btcLock(acct.view);
        for (let i = 0; i < 6; i++) {
          const n = 1 + (i % 4);
          const inputs = Array.from({ length: n }, () => ({ txid: bytesToHex(randomBytes(32)), vout: Number(rnd(1)), value: 20_000n + rnd(3) }));
          const total = inputs.reduce((s, x) => s + x.value, 0n);
          const fee = 500n + rnd(1);
          const amount = i % 2 ? total - fee - 100n : total / 3n; // sub-dust change vs real change
          const toScript = i % 3 ? Uint8Array.from([0x00, 0x14, ...randomBytes(20)]) : Uint8Array.from([0x00, 0x20, ...randomBytes(32)]);
          const params = {
            kind: { send: {} },
            chain: { bitcoin: {} },
            asset: new Array(20).fill(0),
            to: Buffer.from(toScript),
            amount: bn(amount),
            evm: null,
            btc: { inputs: inputs.map((u) => ({ txid: Array.from(btc.txidToInternal(u.txid)), vout: u.vout, value: bn(u.value) })), fee: bn(fee) },
          };
          const got = await onchain(acct, params, 0n);
          const plan = btc.planSpend(inputs, toScript, amount, fee, lock);
          const tx = btc.unsignedTx(plan);
          expect(got.length).toBe(n);
          inputs.forEach((u, k) => {
            const expected = tx.hashForWitnessV0(k, btc.scriptCode(lock), u.value, bitcoin.Transaction.SIGHASH_ALL);
            expect(bytesToHex(got[k]!.finalDigest)).toBe(bytesToHex(expected));
            expect(got[k]!.scheme).toBe(2);
          });
        }
      }
      expect(account).toBeTruthy();
    });
  }
});
