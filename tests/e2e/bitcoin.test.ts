import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { recovery as recoveryTools, btc } from '@ika-portal/chains';
import { defaultPolicy, type IntentHandle } from '@ika-portal/core';
import { BITCOIND, btcRpc, fundBtc, mine } from './infra.js';
import { fundedKeypair, sdk } from './helpers.js';

const backend = new btc.BitcoindRpcBackend(BITCOIND.url, { username: BITCOIND.user, password: BITCOIND.pass });
const sats = (btcAmount: number) => BigInt(Math.round(btcAmount * 1e8));

/** Keep mining while an intent waits for its confirmation. */
async function waitMining(h: IntentHandle) {
  let done = false;
  const miner = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 700));
      if (!done) await mine(1);
    }
  })();
  try {
    return await h.wait();
  } finally {
    done = true;
    await miner;
  }
}

async function receivedBy(address: string) {
  const u = await backend.utxos(address);
  return u.reduce((s, x) => s + x.value, 0n);
}

describe('Bitcoin (regtest)', () => {
  for (const mode of ['enforced', 'recoverable', 'enforced_recovery'] as const) {
    it(`${mode}: send BTC (${mode === 'enforced_recovery' ? 'P2WSH dWallet branch' : 'P2WPKH'})`, async () => {
      const owner = await fundedKeypair();
      const ika = sdk(owner);
      const { account } = await ika.createAccount({ owner: owner.publicKey, mode, userShare: 'public', policy: defaultPolicy(), recovery: { csvBlocks: 6 } });
      const from = account.addresses.bitcoin!;
      expect(from.startsWith('bcrt1q')).toBe(true);
      if (mode === 'enforced_recovery') expect(from.length).toBe(64); // P2WSH
      await fundBtc(from, 0.5);
      await fundBtc(from, 0.3);

      const to = await btcRpc<string>('getnewaddress', [], 'miner');
      const r = await waitMining(await account.send({ chain: 'bitcoin', asset: 'BTC', to, amount: sats(0.6) }));
      const tx = await btcRpc<{ vout: { value: number; scriptPubKey: { address: string } }[] }>('getrawtransaction', [r.destinationTx, true]);
      expect(tx.vout.find((o) => o.scriptPubKey.address === to)?.value).toBe(0.6);
      // Change returns to the account's own address.
      expect(tx.vout.some((o) => o.scriptPubKey.address === from)).toBe(true);
    });
  }

  it('recoverable: the mnemonic restores the same BIP84 address', async () => {
    const owner = await fundedKeypair();
    const { account, mnemonic } = await sdk(owner).createAccount({ owner: owner.publicKey, mode: 'recoverable', userShare: 'public', policy: defaultPolicy() });
    const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic!)).derive("m/84'/1'/0'/0/0");
    const addr = bitcoin.payments.p2wpkh({ pubkey: node.publicKey!, network: bitcoin.networks.regtest }).address;
    expect(addr).toBe(account.addresses.bitcoin);
  });

  it('enforced_recovery: CSV recovery fails one block early, succeeds at csv_blocks', async () => {
    const owner = await fundedKeypair();
    const created = await sdk(owner).createAccount({ owner: owner.publicKey, mode: 'enforced_recovery', userShare: 'public', policy: defaultPolicy(), recovery: { csvBlocks: 6 } });
    const { account } = created;
    const from = account.addresses.bitcoin!;
    await fundBtc(from, 0.25); // 1 confirmation
    await mine(4); // 5 confirmations = csv_blocks - 1

    const recoveryKey = Buffer.from(created.recoveryKey!.privateKey.slice(2), 'hex');
    const info = { dwalletPubkey: account.view.btcPubkey!, recoveryPubkey: account.view.recoveryPubkey!, csvBlocks: 6, network: 'regtest' as const };
    const sink = await btcRpc<string>('getnewaddress', [], 'miner');
    const args = { recoveryKey, account: info, to: sink, feeRate: 2, backend };

    await expect(recoveryTools.bitcoin.buildRecoveryTx(args)).rejects.toThrow(/confirmations/);
    const early = await recoveryTools.bitcoin.buildRecoveryTx({ ...args, minConfirmations: 1 });
    await expect(backend.broadcast(early.hex)).rejects.toThrow(/non-BIP68-final/);

    await mine(1); // 6 confirmations
    const ok = await recoveryTools.bitcoin.buildRecoveryTx(args);
    await backend.broadcast(ok.hex);
    await mine(1);
    expect(await receivedBy(from)).toBe(0n);
    const t = await backend.tx(ok.txid);
    expect(t?.confirmations).toBe(1);
  });

  it('policy: BTC fee cap rejects on-chain', async () => {
    const owner = await fundedKeypair();
    const ika = sdk(owner);
    const { account } = await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'public', policy: defaultPolicy({ maxBtcFeeSats: 100n }) });
    await fundBtc(account.addresses.bitcoin!, 0.1);
    const to = await btcRpc<string>('getnewaddress', [], 'miner');
    await expect(account.send({ chain: 'bitcoin', asset: 'BTC', to, amount: sats(0.01) })).rejects.toThrow(/exceeds policy cap|FeeTooHigh/);
  });
});
