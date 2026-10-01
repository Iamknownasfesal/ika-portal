import { describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { encodeFunctionData, erc20Abi, parseEther, type Hex } from 'viem';
import { recovery as recoveryTools, evm } from '@ika-portal/chains';
import { defaultPolicy, sendInstructions, type IkaPortalError, type ProgressEvent } from '@ika-portal/core';
import { evmTools, fundedKeypair, infra, randomEvmAddress, sdk, unlockerFor } from './helpers.js';

const collect = async (it: AsyncIterable<ProgressEvent>) => {
  const out: ProgressEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe('EVM (anvil, Prague)', () => {
  it('direct mode: the dWallet EOA pays its own gas, no contract needed', async () => {
    const owner = await fundedKeypair();
    const ika = sdk(owner);
    const { account } = await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'public', policy: defaultPolicy() });
    const eth = evmTools('ethereum');
    const eoa = account.addresses.ethereum!;
    await eth.fundEth(eoa, parseEther('1'));
    const to = randomEvmAddress();

    const intent = await account.send({ chain: 'ethereum', asset: 'ETH', to, amount: parseEther('0.1') });
    const events = await collect(intent.progress());
    expect(events.map((e) => e.status)).toEqual(['building', 'proposed', 'approved', 'signed', 'broadcast', 'confirmed']);
    expect(await eth.ethBalance(to)).toBe(parseEther('0.1'));
  });

  it('delegated mode: 7702 setup + relayed USDC send; the dWallet address holds no ETH', async () => {
    const owner = await fundedKeypair();
    const ika = sdk(owner);
    const { account } = await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'public', policy: defaultPolicy() });
    const base = evmTools('base');
    const eoa = account.addresses.base!;
    await base.mintUsdc(eoa, 5_000_000n);

    await (await account.setupEvm('base')).wait();
    expect(evm.delegationTarget(await base.pub.getCode({ address: eoa }))?.toLowerCase()).toBe(base.impl.toLowerCase());
    await account.refresh();
    expect(account.isDelegated('base')).toBe(true);

    const to = randomEvmAddress();
    for (const amount of [1_250_000n, 750_000n]) {
      const r = await (await account.send({ chain: 'base', asset: 'USDC', to, amount })).wait();
      expect(r.destinationTx).toMatch(/^0x/);
    }
    expect(await base.usdcBalance(to)).toBe(2_000_000n);
    expect(await base.ethBalance(eoa)).toBe(0n);
  });

  it('policy: each rule rejects on-chain with its own error, and the SDK previews it first', async () => {
    const owner = await fundedKeypair();
    const ika = sdk(owner);
    const allowed = randomEvmAddress();
    const policy = defaultPolicy({
      allowlistEnabled: true,
      allowlist: [{ chain: 'ethereum', address: allowed }],
      limits: [{ chain: 'ethereum', asset: 'ETH', maxPerWindow: parseEther('0.5'), windowS: 3600 }],
      policyChangeDelayS: 0,
    });
    const { account } = await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'public', policy });
    const eth = evmTools('ethereum');
    await eth.fundEth(account.addresses.ethereum!, parseEther('2'));

    await expect(account.send({ chain: 'ethereum', asset: 'ETH', to: randomEvmAddress(), amount: 1n })).rejects.toMatchObject({ code: 'RecipientNotAllowed' });

    // Bypass the SDK preview: the program itself rejects.
    const ixs = await account.instructions.send({ chain: 'ethereum', asset: 'ETH', to: randomEvmAddress(), amount: 1n });
    const signer = { publicKey: owner.publicKey, signTransaction: async <T>(t: T) => ((t as { partialSign: (k: unknown) => void }).partialSign(owner), t) };
    await expect(sendInstructions(ika.program.connection, ixs, signer)).rejects.toMatchObject({ code: 'RecipientNotAllowed' });
    const over = await account.instructions.send({ chain: 'ethereum', asset: 'ETH', to: allowed, amount: parseEther('0.6') });
    await expect(sendInstructions(ika.program.connection, over, signer)).rejects.toMatchObject({ code: 'LimitExceeded' });

    await (await account.send({ chain: 'ethereum', asset: 'ETH', to: allowed, amount: parseEther('0.4') })).wait();
    expect(await eth.ethBalance(allowed)).toBe(parseEther('0.4'));
  });

  it('delay threshold: the intent waits, then completes', async () => {
    const owner = await fundedKeypair();
    const ika = sdk(owner);
    const policy = defaultPolicy({ delayThresholds: [{ chain: 'ethereum', asset: 'ETH', amount: parseEther('0.1') }], delayS: 4 });
    const { account } = await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'public', policy });
    await evmTools('ethereum').fundEth(account.addresses.ethereum!, parseEther('1'));
    const events = await collect((await account.send({ chain: 'ethereum', asset: 'ETH', to: randomEvmAddress(), amount: parseEther('0.2') })).progress());
    const delayed = events.find((e) => e.status === 'delayed');
    expect(delayed?.executableAt).toBeGreaterThan(0);
    const order = events.map((e) => e.status);
    expect(order.indexOf('delayed')).toBeLessThan(order.indexOf('approved'));
    expect(events.at(-1)?.status).toBe('confirmed');
  });

  it('enforced_recovery: recovery initiate → dWallet cancel → initiate → too early fails → execute after delay', async () => {
    const owner = await fundedKeypair();
    const ika = sdk(owner);
    const created = await ika.createAccount({
      owner: owner.publicKey,
      mode: 'enforced_recovery',
      userShare: 'public',
      policy: defaultPolicy(),
      recovery: { csvBlocks: 6, evmDelayS: 3600 },
    });
    const { account } = created;
    const eth = evmTools('ethereum');
    const eoa = account.addresses.ethereum!;
    await eth.mintUsdc(eoa, 10_000_000n);
    await (await account.setupEvm('ethereum')).wait();

    const rk = created.recoveryKey!.privateKey as Hex;
    const rkAddr = account.view.recoveryEvmAddress!;
    await eth.fundEth(rkAddr, parseEther('1'));
    const args = { recoveryKey: rk, account: eoa, rpc: eth.rpc, chainId: eth.chainId };

    const first = await recoveryTools.evm.initiateRecovery(args);
    expect(first.readyAt).toBeGreaterThan(0n);
    await account.refresh();
    await (await account.cancelEvmRecovery('ethereum')).wait();
    const adapter = new evm.EvmAdapter('ethereum', { rpc: eth.rpc, chainId: eth.chainId });
    expect((await adapter.recoveryState(eoa)).recoveryReadyAt).toBe(0n);

    await recoveryTools.evm.initiateRecovery(args);
    const sink = randomEvmAddress();
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [sink, 10_000_000n],
    });
    await expect(recoveryTools.evm.recoveryExecute({ ...args, to: eth.usdc, value: 0n, data })).rejects.toThrow();
    await eth.increaseTime(3601);
    await recoveryTools.evm.recoveryExecute({ ...args, to: eth.usdc, value: 0n, data });
    expect(await eth.usdcBalance(sink)).toBe(10_000_000n);
  });

  it('encrypted user share: no signature without the unlocker', async () => {
    const owner = await fundedKeypair();
    const unlocker = unlockerFor(owner);
    const ika = sdk(owner, { unlocker });
    const created = await ika.createAccount({ owner: owner.publicKey, mode: 'enforced', userShare: 'encrypted', policy: defaultPolicy() });
    const eth = evmTools('ethereum');
    await eth.fundEth(created.account.addresses.ethereum!, parseEther('1'));

    const locked = await sdk(owner).loadAccount({ owner: owner.publicKey, dwallets: created.dwallets });
    const h = await locked.send({ chain: 'ethereum', asset: 'ETH', to: randomEvmAddress(), amount: 1000n });
    await expect(h.wait()).rejects.toMatchObject({ code: 'ShareLocked' });

    // A different Solana key derives a different share key.
    const wrong = await sdk(owner, { unlocker: unlockerFor(await fundedKeypair(1)) }).loadAccount({ owner: owner.publicKey, dwallets: created.dwallets });
    await expect(wrong.intent(h.intent).wait()).rejects.toMatchObject({ code: 'ShareLocked' });

    // With the right unlocker the same approved intent completes.
    const ok = await ika.loadAccount({ owner: owner.publicKey, dwallets: created.dwallets });
    const r = await ok.intent(h.intent).wait();
    expect(r.destinationTx).toMatch(/^0x/);
  });

  it('recoverable: the mnemonic restores the same EVM address in a standard derivation', async () => {
    const owner = await fundedKeypair();
    const ika = sdk(owner);
    const { account, mnemonic } = await ika.createAccount({ owner: owner.publicKey, mode: 'recoverable', userShare: 'public', policy: defaultPolicy() });
    expect(mnemonic!.split(' ')).toHaveLength(12);
    expect(mnemonicToAccount(mnemonic!).address).toBe(account.addresses.ethereum);
    expect(infra().evm).toBeTruthy();
  });
});

export type { IkaPortalError };
