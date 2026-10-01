import { useCallback, useEffect, useState } from 'react';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import type { AssetSymbol, Chain, IntentHandle } from '@ika-portal/core';
import { btc } from '@ika-portal/chains';
import { useApp } from '../lib/app';
import { solscanAddr, solscanTx } from '../config';
import { CHAIN_LABEL, bytesToHex, duration, fmt, short } from '../lib/format';
import { intentLog, useNow } from '../lib/tracker';
import { IntentProgress } from '../components/progress';
import { VaultInstructions } from '../components/vault';
import { Badge, Button, Card, Empty, ErrorBox, ExtLink } from '../components/ui';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

interface Row {
  address: PublicKey;
  nonce: number;
  kind: string;
  chain: Chain;
  asset: AssetSymbol;
  to: string;
  amount: bigint;
  status: 'proposed' | 'approved' | 'cancelled';
  createdAt: number;
  executableAt: number;
}

const variant = (e: object) => Object.keys(e)[0] ?? '?';
const KIND: Record<string, string> = { send: 'Send', swap: 'Swap', evmSetup: '7702 setup', evmCancelRecovery: 'Cancel recovery' };

function decode(publicKey: PublicKey, a: Raw): Row {
  const chain = variant(a.params.chain) as Chain;
  const assetBytes = Uint8Array.from(a.params.asset as number[]);
  // The only configured ERC-20 is USDC (Sepolia / Base Sepolia).
  const asset: AssetSymbol = chain === 'bitcoin' ? 'BTC' : assetBytes.every((b) => b === 0) ? 'ETH' : 'USDC';
  const toBytes = Uint8Array.from(a.params.to as Uint8Array);
  let to = '';
  if (toBytes.length) {
    if (chain === 'bitcoin') {
      try {
        to = btc.scriptToAddress(toBytes, 'testnet');
      } catch {
        to = bytesToHex(toBytes);
      }
    } else to = `0x${bytesToHex(toBytes)}`;
  }
  return {
    address: publicKey,
    nonce: Number(a.nonce.toString()),
    kind: KIND[variant(a.params.kind)] ?? variant(a.params.kind),
    chain,
    asset,
    to,
    amount: BigInt(a.params.amount.toString()),
    status: variant(a.status) as Row['status'],
    createdAt: Number(a.createdAt.toString()),
    executableAt: Number(a.executableAt.toString()),
  };
}

export function ActivityScreen() {
  const app = useApp();
  const acct = app.account!;
  const { connection } = useConnection();
  const now = useNow();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [sigs, setSigs] = useState<Record<string, string[]>>({});
  const [resumed, setResumed] = useState<Record<string, IntentHandle>>({});
  const [vault, setVault] = useState<TransactionInstruction[] | null>(null);
  const [actionErr, setActionErr] = useState<unknown>(null);
  const log = intentLog();

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await acct.listIntents();
      setRows(list.map((i) => decode(i.publicKey, i.account)));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [acct]);
  useEffect(() => {
    void load();
  }, [load]);

  // Look up the approval tx (latest signature on the intent account) for approved intents.
  useEffect(() => {
    if (!rows) return;
    let live = true;
    void (async () => {
      for (const r of rows.filter((x) => x.status === 'approved' && !intentLog()[x.address.toBase58()]?.solanaTx).slice(0, 10)) {
        if (!live) return;
        try {
          const s = await connection.getSignaturesForAddress(r.address, { limit: 1 });
          if (live && s[0]) setSigs((m) => ({ ...m, [r.address.toBase58()]: [s[0]!.signature] }));
        } catch {
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [rows, connection]);

  async function loadSigs(r: Row) {
    try {
      const s = await connection.getSignaturesForAddress(r.address, { limit: 10 });
      setSigs((m) => ({ ...m, [r.address.toBase58()]: s.map((x) => x.signature) }));
    } catch (e) {
      setActionErr(e);
    }
  }

  async function cancel(r: Row) {
    setActionErr(null);
    try {
      if (app.vaultMode) setVault(await acct.instructions.cancelIntent(r.address));
      else {
        await acct.cancelIntent(r.address);
        await load();
      }
    } catch (e) {
      setActionErr(e);
    }
  }

  const resume = (r: Row) => setResumed((m) => ({ ...m, [r.address.toBase58()]: acct.intent(r.address) }));

  return (
    <div className="space-y-4">
      <Card
        title="Activity"
        subtitle="Intents proposed by this account, newest first. Destination tx hashes are remembered in this browser only."
        actions={
          <Button onClick={load} busy={busy}>
            Refresh
          </Button>
        }
      >
        <ErrorBox error={error} />
        {rows && rows.length === 0 && <Empty>No intents yet.</Empty>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-zinc-800">
            {rows.map((r) => {
              const key = r.address.toBase58();
              const local = log[key];
              const handle = resumed[key];
              const waiting = r.status === 'proposed' && r.executableAt > now;
              const approvalTx = local?.solanaTx ?? (r.status === 'approved' ? sigs[key]?.[0] : undefined);
              const canResume = !handle && (r.status === 'proposed' || (r.status === 'approved' && !local?.destinationTx));
              return (
                <li key={key} className="py-3">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-zinc-500">#{r.nonce}</span>
                        <span className="text-sm font-medium text-zinc-100">{r.kind}</span>
                        {r.amount > 0n && (
                          <span className="text-sm tabular-nums text-zinc-200">
                            {fmt(r.amount, r.asset)} {r.asset}
                          </span>
                        )}
                        <Badge>{CHAIN_LABEL[r.chain]}</Badge>
                        <Badge tone={r.status === 'approved' ? 'good' : r.status === 'cancelled' ? 'bad' : 'warn'}>{r.status}</Badge>
                        {waiting && <Badge tone="warn">executable in {duration(r.executableAt - now)}</Badge>}
                      </div>
                      {r.to && (
                        <div className="text-xs text-zinc-400">
                          to <span className="font-mono">{short(r.to, 10)}</span>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
                        <span>{new Date(r.createdAt * 1000).toLocaleString()}</span>
                        <ExtLink href={solscanAddr(key)}>intent {short(key)}</ExtLink>
                        {approvalTx && <ExtLink href={solscanTx(approvalTx)}>Solana approval tx {short(approvalTx)}</ExtLink>}
                        {local?.destinationTx &&
                          (local.destinationTxUrl ? (
                            <ExtLink href={local.destinationTxUrl}>destination tx {short(local.destinationTx)}</ExtLink>
                          ) : (
                            <span className="font-mono">destination {short(local.destinationTx)}</span>
                          ))}
                        {r.status === 'approved' && !approvalTx && (
                          <button type="button" className="text-indigo-300 hover:underline" onClick={() => loadSigs(r)}>
                            find approval tx
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {canResume && (
                        <Button onClick={() => resume(r)} title="Approve (after any delay), sign with Ika and broadcast">
                          Resume
                        </Button>
                      )}
                      {r.status === 'proposed' && (
                        <Button variant="danger" onClick={() => cancel(r)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                  {handle && (
                    <div className="mt-3">
                      <IntentProgress handle={handle} title={`Resume #${r.nonce}`} onDone={() => void load()} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <ErrorBox error={actionErr} />
      {vault && (
        <VaultInstructions
          title="Cancel intent from your vault"
          transactions={[vault]}
          footer={
            <Button
              onClick={() => {
                setVault(null);
                void load();
              }}
            >
              Done, refresh
            </Button>
          }
        />
      )}
    </div>
  );
}
