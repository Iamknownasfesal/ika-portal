import { describe, expect, it } from 'vitest';
import { hashTypedData, keccak256, type Address } from 'viem';
import { hashAuthorization } from 'viem/utils';
import * as bitcoin from 'bitcoinjs-lib';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { evm, btc } from '../src/index.js';

const rand = (n: number) => randomBytes(n);
const randAddr = () => `0x${bytesToHex(rand(20))}` as Address;
const randBig = (bytes: number) => BigInt(`0x${bytesToHex(rand(bytes))}`);

describe('EVM digests vs viem', () => {
  it('matches the Foundry Execute vector', () => {
    const call = evm.evmCall(null, '0x2222222222222222222222222222222222222222', 10n ** 18n);
    const s = evm.executeSignable(31337, '0x1111111111111111111111111111111111111111', call, 0n, 1_700_000_000n);
    expect(s.digest).toBe('0x1f00b6a1ffc9240c0b8595df34ee26502762a951ea2e6c257bb01f551c65249e');
  });

  it('Execute / Init / CancelRecovery match hashTypedData (randomized)', () => {
    for (let i = 0; i < 50; i++) {
      const chainId = Number(randBig(3)) + 1;
      const account = randAddr();
      const token = i % 2 ? randAddr() : null;
      const call = evm.evmCall(token, randAddr(), randBig(8));
      const nonce = randBig(4);
      const deadline = randBig(4);
      const domain = evm.ikaDomain(chainId, account);
      expect(evm.executeSignable(chainId, account, call, nonce, deadline).digest).toBe(
        hashTypedData({ domain, types: evm.executeTypes, primaryType: 'Execute', message: { ...call, nonce, deadline } }),
      );
      const rk = randAddr();
      const delay = randBig(4);
      expect(evm.initSignable(chainId, account, rk, delay).digest).toBe(
        hashTypedData({ domain, types: evm.initTypes, primaryType: 'Init', message: { recoveryKey: rk, recoveryDelay: delay } }),
      );
      expect(evm.cancelRecoverySignable(chainId, account, nonce, deadline).digest).toBe(
        hashTypedData({ domain, types: evm.cancelRecoveryTypes, primaryType: 'CancelRecovery', message: { nonce, deadline } }),
      );
    }
  });

  it('7702 authorization matches hashAuthorization, including zero nonce', () => {
    for (const nonce of [0, 1, 127, 128, 70000]) {
      const impl = randAddr();
      const s = evm.authorizationSignable(11155111, impl, nonce);
      expect(s.digest).toBe(hashAuthorization({ chainId: 11155111, address: impl, nonce }));
    }
  });

  it('derives the EVM address from a compressed key', () => {
    const sk = secp256k1.utils.randomSecretKey();
    const info = evm.evmKeyInfo(secp256k1.getPublicKey(sk, true));
    const uncompressed = secp256k1.getPublicKey(sk, false);
    expect(info.address.toLowerCase()).toBe(`0x${keccak256(uncompressed.slice(1)).slice(-40)}`);
    expect(bytesToHex(info.y)).toBe(bytesToHex(uncompressed.slice(33)));
  });

  it('normalizes high-S and finds the recovery id', async () => {
    const sk = secp256k1.utils.randomSecretKey();
    const addr = evm.evmAddress(secp256k1.getPublicKey(sk, true));
    const digest = keccak256('0x1234');
    const sig = secp256k1.Signature.fromBytes(secp256k1.sign(Buffer.from(digest.slice(2), 'hex'), sk, { prehash: false }), 'compact');
    const N = secp256k1.Point.CURVE().n;
    const high = new secp256k1.Signature(sig.r, sig.s > N / 2n ? sig.s : N - sig.s);
    const out = await evm.toEvmSignature(high.toBytes('compact'), digest, addr);
    expect(BigInt(out.s) <= N / 2n).toBe(true);
  });
});

describe('BIP143 vs bitcoinjs', () => {
  const locks = (): btc.BtcLock[] => {
    const pk = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    const rk = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    return [
      { type: 'p2wpkh', pubkey: pk },
      { type: 'p2wsh', dwalletPubkey: pk, recoveryPubkey: rk, csvBlocks: 6 },
      { type: 'p2wsh', dwalletPubkey: pk, recoveryPubkey: rk, csvBlocks: 4320 },
      { type: 'p2wsh', dwalletPubkey: pk, recoveryPubkey: rk, csvBlocks: 128 },
    ];
  };

  it('sighash matches hashForWitnessV0 for P2WPKH and P2WSH (randomized)', () => {
    for (let round = 0; round < 20; round++) {
      for (const lock of locks()) {
        const n = 1 + (round % 4);
        const inputs = Array.from({ length: n }, () => ({ txid: bytesToHex(rand(32)), vout: Number(randBig(1)), value: 10_000n + randBig(3) }));
        const total = inputs.reduce((s, i) => s + i.value, 0n);
        const toScript = Uint8Array.from([0x00, 0x14, ...rand(20)]);
        const plan = btc.planSpend(inputs, toScript, total / 2n, 700n, lock);
        const tx = btc.unsignedTx(plan);
        const sc = btc.scriptCode(lock);
        const got = btc.btcSignables(plan, lock);
        inputs.forEach((inp, i) => {
          const expected = tx.hashForWitnessV0(i, sc, inp.value, bitcoin.Transaction.SIGHASH_ALL);
          expect(bytesToHex(got[i]!.sighash)).toBe(bytesToHex(expected));
        });
      }
    }
  });

  it('witness script encodes CSV minimally (matches program vectors)', () => {
    const [, six, big, b128] = locks() as [btc.BtcLock, btc.BtcLock & { type: 'p2wsh' }, btc.BtcLock & { type: 'p2wsh' }, btc.BtcLock & { type: 'p2wsh' }];
    const csvBytes = (l: btc.BtcLock) => btc.witnessScript(l)!.slice(37, -38);
    expect(bytesToHex(csvBytes(six))).toBe('56');
    expect(bytesToHex(csvBytes(big))).toBe('02e010');
    expect(bytesToHex(csvBytes(b128))).toBe('028000');
  });

  it('drops sub-dust change into the fee', () => {
    const lock = locks()[0]!;
    const plan = btc.planSpend([{ txid: '00'.repeat(32), vout: 0, value: 11_000n }], new Uint8Array(22), 10_000n, 500n, lock);
    expect(plan.outputs.length).toBe(1);
    expect(plan.fee).toBe(1_000n);
  });
});
