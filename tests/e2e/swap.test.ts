/**
 * Swap e2e: BTC (regtest) → USDC on "Base" (anvil) through the router with two
 * mock providers. Checks best-quote routing, integrator fees, delivery to the
 * account's own address, and the swap intent path (policy + swap limits).
 */
import { describe, expect, it } from 'vitest';
import { MockSwapProvider, type MockPayout } from '@ika-portal/swap';
import { defaultPolicy, type IntentHandle } from '@ika-portal/core';
import { btcRpc, fundBtc, mine } from './infra.js';
import { evmTools, fundedKeypair, randomEvmAddress, sdk } from './helpers.js';
import type { Address } from 'viem';

async function withMiner<T>(p: Promise<T>) {
  let done = false;
  const miner = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 700));
      if (!done) await mine(1);
    }
  })();
  try {
    return await p;
  } finally {
    done = true;
    await miner;
  }
}

describe('Swaps (mock providers, local chains)', () => {
  it('routes BTC → Base USDC to the best quote, applies integrator fees, delivers to the account', async () => {
    const base = evmTools('base');
    const depositAddress = await btcRpc<string>('getnewaddress', [], 'miner');
    const payout: MockPayout = async ({ chain, asset, to, amount }) => {
      expect([chain, asset]).toEqual(['base', 'USDC']);
      await base.mintUsdc(to as Address, amount);
      return '0xmockpayout';
    };
    const good = new MockSwapProvider({ id: 'mock-good', rates: { 'BTC/USDC': '60000' }, payout, depositAddresses: { bitcoin: depositAddress } });
    const worse = new MockSwapProvider({ id: 'mock-worse', rates: { 'BTC/USDC': '59000' }, payout, depositAddresses: { bitcoin: depositAddress } });
    const integrator = randomEvmAddress();

    const owner = await fundedKeypair();
    const ika = sdk(owner, { swap: { providers: [worse, good], fees: { integrator: { recipient: integrator, bps: 30 } } } });
    const { account } = await ika.createAccount({
      owner: owner.publicKey,
      mode: 'enforced',
      userShare: 'public',
      policy: defaultPolicy({ swapLimits: [{ chain: 'bitcoin', asset: 'BTC', maxPerWindow: 5_000_000n, windowS: 86_400 }] }),
    });
    await fundBtc(account.addresses.bitcoin!, 0.1);

    const quotes = await account.quoteSwap({ from: { chain: 'bitcoin', asset: 'BTC', amount: 1_000_000n }, to: { chain: 'base', asset: 'USDC' } });
    expect(quotes.quotes).toHaveLength(2);
    expect(quotes.best?.providerId).toBe('mock-good');
    // 0.01 BTC × 60,000 = 600 USDC, minus 30 bps integrator fee on output.
    expect(quotes.best!.amountOut).toBe(598_200_000n);
    expect(quotes.best!.fees.integrator?.amount).toBe(1_800_000n);
    expect(quotes.best!.recipient).toBe(account.addresses.base);

    const swap = await account.swap(quotes.best!);
    expect(swap.prepared.depositAddress).toBe(depositAddress);
    const status = await withMiner(swap.wait());
    expect(status.status).toBe('success');
    expect(await base.usdcBalance(account.addresses.base!)).toBe(598_200_000n);

    // The deposit went out as a `swap` intent and counted toward the swap limit.
    await account.refresh();
    expect(account.view.spend.swaps[0]!.used).toBe(1_000_000n);
    await expect(
      account.swap((await account.quoteSwap({ from: { chain: 'bitcoin', asset: 'BTC', amount: 4_500_000n }, to: { chain: 'base', asset: 'USDC' } })).best!),
    ).rejects.toMatchObject({ code: 'SwapLimitExceeded' });
  });

  it('swapsEnabled=false blocks swap intents', async () => {
    const payout: MockPayout = async () => '0x';
    const provider = new MockSwapProvider({ rates: { 'BTC/USDC': '60000' }, payout, depositAddresses: { bitcoin: await btcRpc<string>('getnewaddress', [], 'miner') } });
    const owner = await fundedKeypair();
    const ika = sdk(owner, { swap: { providers: [provider], fees: { integrator: { recipient: randomEvmAddress(), bps: 0 } } } });
    const { account } = await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'public', policy: defaultPolicy({ swapsEnabled: false }) });
    await fundBtc(account.addresses.bitcoin!, 0.05);
    const q = await account.quoteSwap({ from: { chain: 'bitcoin', asset: 'BTC', amount: 100_000n }, to: { chain: 'base', asset: 'USDC' } });
    await expect(account.swap(q.best!)).rejects.toMatchObject({ code: 'SwapsDisabled' });
  });
});

export type { IntentHandle };
