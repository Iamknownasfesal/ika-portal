import { useEffect, useState } from 'react';
import { createPublicClient, http, isAddress, type Address, type Hex } from 'viem';
import type { EvmChain, IntentHandle } from '@ika-portal/core';
import { btc, evm, recovery } from '@ika-portal/chains';
import { useApp } from '../lib/app';
import { config, EVM } from '../config';
import { CHAIN_LABEL, bytesToHex, duration, hexToBytes, parseAmount, short } from '../lib/format';
import { useNow } from '../lib/tracker';
import { IntentProgress } from '../components/progress';
import { Badge, Button, Card, ErrorBox, ExtLink, Field, Input, KV, Mono, Notice, Select } from '../components/ui';

const RPC: Record<EvmChain, string> = { ethereum: config.sepoliaRpc, base: config.baseSepoliaRpc };

export function RecoveryScreen() {
  const app = useApp();
  const acct = app.account!;
  const v = acct.view;

  if (v.mode !== 'enforced_recovery') {
    return (
      <Card title="Recovery">
        <Notice>
          Recovery tools are for <b>Enforced with recovery</b> accounts. This account is <b>{v.mode}</b>
          {v.mode === 'recoverable' ? ': restore its recovery phrase in any BIP84 / BIP44 wallet instead.' : ': no full key or recovery key exists.'}
        </Notice>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card title="Recovery parameters" subtitle="These tools work without Ika or Solana: they only need your recovery key and the destination chain.">
        <dl>
          <KV k="Recovery public key">
            <Mono>{v.recoveryPubkey ? bytesToHex(v.recoveryPubkey) : '—'}</Mono>
          </KV>
          <KV k="Recovery EVM address">
            <Mono>{v.recoveryEvmAddress ?? '—'}</Mono>
          </KV>
          <KV k="Bitcoin CSV delay">{v.csvBlocks} blocks after each UTXO confirms</KV>
          <KV k="EVM recovery delay">{duration(v.recoveryDelayS)}</KV>
        </dl>
      </Card>
      <BtcRecovery />
      <EvmRecovery />
    </div>
  );
}

function KeyInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <Field label="Recovery private key (hex)" hint="Kept in memory only for this form; never stored.">
      <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
    </Field>
  );
}

function BtcRecovery() {
  const { account } = useApp();
  const v = account!.view;
  const [key, setKey] = useState('');
  const [to, setTo] = useState('');
  const [feeRate, setFeeRate] = useState('');
  const [built, setBuilt] = useState<{ hex: string; txid: string; fee: bigint; inputs: number } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState<'build' | 'send' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const backend = new btc.EsploraBackend(config.esploraUrl);

  useEffect(() => {
    new btc.EsploraBackend(config.esploraUrl)
      .feeRate()
      .then((r) => setFeeRate((f) => f || String(r)))
      .catch(() => setFeeRate((f) => f || '2'));
  }, []);

  async function build() {
    setBusy('build');
    setError(null);
    setBuilt(null);
    setSent(null);
    try {
      if (!v.btcPubkey || !v.recoveryPubkey) throw new Error('account has no Bitcoin dWallet / recovery key');
      const r = await recovery.bitcoin.buildRecoveryTx({
        recoveryKey: hexToBytes(key),
        account: { dwalletPubkey: v.btcPubkey, recoveryPubkey: v.recoveryPubkey, csvBlocks: v.csvBlocks, network: 'testnet' },
        to: to.trim(),
        feeRate: Number(feeRate),
        backend,
      });
      setBuilt({ hex: r.hex, txid: r.txid, fee: r.fee, inputs: r.inputs.length });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function broadcast() {
    if (!built) return;
    setBusy('send');
    setError(null);
    try {
      setSent(await backend.broadcast(built.hex));
      setKey('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Bitcoin: CSV recovery" subtitle={`Spends every UTXO at ${account!.addresses.bitcoin ?? 'the account address'} that has at least ${v.csvBlocks} confirmations, via the recovery branch.`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <KeyInput value={key} onChange={setKey} />
        <Field label="Destination (tb1…)">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="tb1…" spellCheck={false} />
        </Field>
        <Field label="Fee rate (sat/vB)">
          <Input value={feeRate} onChange={(e) => setFeeRate(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" busy={busy === 'build'} disabled={!key || !to || !Number(feeRate)} onClick={build}>
          Build recovery transaction
        </Button>
        {built && !sent && (
          <Button variant="danger" busy={busy === 'send'} onClick={broadcast}>
            Broadcast
          </Button>
        )}
      </div>
      {built && (
        <div className="mt-3 space-y-1 text-sm">
          <div>
            txid <Mono>{built.txid}</Mono>
          </div>
          <div className="text-zinc-400">
            {built.inputs} input(s), fee {built.fee.toString()} sats
          </div>
          <details className="text-xs text-zinc-400">
            <summary className="cursor-pointer">Raw transaction</summary>
            <Mono className="mt-1 block max-h-32 overflow-auto">{built.hex}</Mono>
          </details>
        </div>
      )}
      {sent && (
        <p className="mt-3 text-sm text-emerald-300">
          Broadcast: <ExtLink href={`${config.btcExplorer}/tx/${sent}`}>{short(sent, 10)}</ExtLink>
        </p>
      )}
      <div className="mt-3">
        <ErrorBox error={error} />
      </div>
    </Card>
  );
}

interface RecoveryState {
  recoveryKey: Address;
  recoveryDelay: bigint;
  readyAt: bigint;
  initialized: boolean;
}

function EvmRecovery() {
  const app = useApp();
  const acct = app.account!;
  const now = useNow();
  const [chain, setChain] = useState<EvmChain>('base');
  const [key, setKey] = useState('');
  const [to, setTo] = useState('');
  const [value, setValue] = useState('');
  const [data, setData] = useState('');
  const [state, setState] = useState<RecoveryState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);
  const [cancelHandle, setCancelHandle] = useState<IntentHandle | null>(null);
  const eoa = acct.addresses[chain] as Address | undefined;
  const delegated = (() => {
    try {
      return acct.isDelegated(chain);
    } catch {
      return false;
    }
  })();

  async function loadState() {
    if (!eoa) return;
    try {
      const client = createPublicClient({ transport: http(RPC[chain]) });
      const [recoveryKey, recoveryDelay, readyAt, initialized] = (await client.readContract({
        address: eoa,
        abi: evm.ikaAccountAbi,
        functionName: 'recoveryState',
      })) as readonly [Address, bigint, bigint, boolean];
      setState({ recoveryKey, recoveryDelay, readyAt, initialized });
    } catch {
      setState(null);
    }
  }
  useEffect(() => {
    setState(null);
    void loadState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, eoa]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      const r = await fn();
      if (r) setResult(r);
      await loadState();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const args = () => ({ recoveryKey: (key.trim().startsWith('0x') ? key.trim() : `0x${key.trim()}`) as Hex, account: eoa!, rpc: RPC[chain], chainId: EVM[chain].chainId });
  const pendingRecovery = state && state.readyAt > 0n;
  const readyIn = pendingRecovery ? Number(state.readyAt) - now : 0;
  const amount = parseAmount(value || '0', 'ETH');

  return (
    <Card title="EVM: IkaAccount recovery" subtitle="The recovery key calls the delegated IkaAccount directly and pays its own gas (fund the recovery EVM address with test ETH).">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Chain">
          <Select value={chain} onChange={(e) => setChain(e.target.value as EvmChain)}>
            <option value="ethereum">{CHAIN_LABEL.ethereum}</option>
            <option value="base">{CHAIN_LABEL.base}</option>
          </Select>
        </Field>
        <div className="flex flex-col justify-end gap-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {delegated ? <Badge tone="good">7702 delegated</Badge> : <Badge tone="warn">not delegated</Badge>}
            {state ? (
              pendingRecovery ? (
                <Badge tone="warn">{readyIn > 0 ? `recovery pending: ready in ${duration(readyIn)}` : 'recovery ready to execute'}</Badge>
              ) : (
                <Badge>no recovery pending</Badge>
              )
            ) : (
              <Badge>state unavailable</Badge>
            )}
          </div>
          {!delegated && <span className="text-xs text-zinc-500">EVM recovery needs the account to be set up (7702) on this chain first.</span>}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <KeyInput value={key} onChange={setKey} />
        <div className="flex items-start sm:pt-5">
          <Button busy={busy === 'init'} disabled={!key || !eoa} onClick={() => run('init', async () => {
            const r = await recovery.evm.initiateRecovery(args());
            return `Recovery initiated (${r.hash}). Ready at ${new Date(Number(r.readyAt) * 1000).toLocaleString()}.`;
          })}>
            Initiate recovery
          </Button>
        </div>
        <Field label="Execute: to">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} />
        </Field>
        <Field label="Value (ETH)">
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.0" inputMode="decimal" />
        </Field>
        <Field label="Calldata (optional)" hint="e.g. an ERC-20 transfer to move USDC" className="sm:col-span-2">
          <Input value={data} onChange={(e) => setData(e.target.value)} placeholder="0x" spellCheck={false} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={busy === 'exec'}
          disabled={!key || !eoa || !isAddress(to.trim()) || amount === null || (pendingRecovery ? readyIn > 0 : state !== null)}
          onClick={() =>
            run('exec', async () => {
              const hash = await recovery.evm.recoveryExecute({ ...args(), to: to.trim() as Address, value: amount ?? 0n, data: (data.trim() || '0x') as Hex });
              return `Executed: ${hash}`;
            })
          }
        >
          Execute recovery
        </Button>
        <Button
          variant="danger"
          busy={busy === 'cancel'}
          disabled={!delegated || !!cancelHandle || app.vaultMode}
          title={!config.relayerUrl ? 'Needs VITE_RELAYER_URL' : undefined}
          onClick={() =>
            run('cancel', async () => {
              setCancelHandle(await acct.cancelEvmRecovery(chain));
            })
          }
        >
          Cancel recovery (dWallet-signed)
        </Button>
      </div>
      {!config.relayerUrl && <p className="mt-2 text-xs text-zinc-500">Cancelling needs a relayer (VITE_RELAYER_URL): the dWallet signs, the relayer submits.</p>}
      {app.vaultMode && <p className="mt-2 text-xs text-zinc-500">Cancel from a Squads-owned account isn't wired up in this demo (no instructions builder for it).</p>}
      {result && <p className="mt-3 break-all text-sm text-emerald-300">{result}</p>}
      <div className="mt-3">
        <ErrorBox error={error} />
      </div>
      {cancelHandle && (
        <div className="mt-3">
          <IntentProgress handle={cancelHandle} title={`Cancel recovery on ${CHAIN_LABEL[chain]}`} onDone={() => void loadState()} />
        </div>
      )}
    </Card>
  );
}
