import { useEffect, useState } from 'react';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { AssetSymbol, Chain, IntentHandle, PreparedIntent, PolicyResult, SendArgs } from '@ika-portal/core';
import { useApp } from '../lib/app';
import { config } from '../config';
import { ASSETS_ON, CHAIN_LABEL, CHAINS, duration, fmt, parseAmount } from '../lib/format';
import { useNow } from '../lib/tracker';
import { IntentProgress } from '../components/progress';
import { VaultInstructions } from '../components/vault';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Select, Spinner } from '../components/ui';

type EvmMode = 'auto' | 'direct' | 'delegated';

export function SendScreen() {
  const app = useApp();
  const acct = app.account!;
  const now = useNow();
  const [chain, setChain] = useState<Chain>('ethereum');
  const [asset, setAsset] = useState<AssetSymbol>('ETH');
  const [to, setTo] = useState('');
  const [amountStr, setAmount] = useState('');
  const [evmMode, setEvmMode] = useState<EvmMode>('auto');
  const [check, setCheck] = useState<{ prepared: PreparedIntent; result: PolicyResult } | null>(null);
  const [checkErr, setCheckErr] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [handle, setHandleState] = useState<{ h: IntentHandle; title: string } | null>(null);
  const setHandle = (h: IntentHandle | null) => setHandleState(h ? { h, title: `Send ${amountStr} ${asset} on ${CHAIN_LABEL[chain]}` } : null);
  const [vault, setVault] = useState<{ ixs: TransactionInstruction[]; intent: PublicKey } | null>(null);
  const [balance, setBalance] = useState<bigint | undefined>();

  const amount = parseAmount(amountStr, asset);
  const isEvm = chain !== 'bitcoin';
  const args: SendArgs | null =
    amount && amount > 0n && to.trim() ? { chain, asset, to: to.trim(), amount, evmMode: isEvm && evmMode !== 'auto' ? evmMode : undefined } : null;
  const argsKey = args ? `${chain}|${asset}|${args.to}|${amount}|${evmMode}` : '';

  useEffect(() => {
    let live = true;
    setBalance(undefined);
    acct
      .balances()
      .then((b) => live && setBalance(b[chain]?.[asset]))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [acct, chain, asset]);

  // Live policy preview (debounced): prepareTransfer + checkPolicy, before anything is signed.
  useEffect(() => {
    setCheck(null);
    setCheckErr(null);
    if (!args) return;
    let live = true;
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const prepared = await acct.prepareTransfer('send', args);
        if (live) setCheck({ prepared, result: acct.checkPolicy(prepared) });
      } catch (e) {
        if (live) setCheckErr(e);
      } finally {
        if (live) setChecking(false);
      }
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argsKey, acct]);

  async function submit() {
    if (!args) return;
    setSubmitting(true);
    setError(null);
    setHandle(null);
    setVault(null);
    try {
      if (app.vaultMode) {
        const ixs = await acct.instructions.send(args);
        // Capture the intent PDA the vault's proposal will create, so we can resume it.
        setVault({ ixs, intent: acct.nextIntentAddress() });
      } else {
        setHandle(await acct.send(args));
      }
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  }

  const delegated = isEvm ? safe(() => acct.isDelegated(chain)) : false;
  const r = check?.result;
  const blocked = !!r && !r.ok;

  return (
    <div className="space-y-4">
      <Card title="Send" subtitle="The Solana program checks the policy, then Ika signs on the destination chain.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Chain">
            <Select
              value={chain}
              onChange={(e) => {
                const c = e.target.value as Chain;
                setChain(c);
                setAsset(ASSETS_ON[c][0]!);
              }}
            >
              {CHAINS.map((c) => (
                <option key={c} value={c}>
                  {CHAIN_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Asset" hint={balance !== undefined ? `Balance: ${fmt(balance, asset)} ${asset}` : undefined}>
            <Select value={asset} onChange={(e) => setAsset(e.target.value as AssetSymbol)}>
              {ASSETS_ON[chain].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
          <Field label="Recipient" className="sm:col-span-2">
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={chain === 'bitcoin' ? 'tb1…' : '0x…'} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label={`Amount (${asset})`}>
            <Input value={amountStr} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" inputMode="decimal" />
          </Field>
          {isEvm && (
            <Field label="EVM mode" hint={delegated ? 'Gasless mode is enabled on this chain.' : 'Delegated mode needs 7702 setup (Account tab) and a relayer.'}>
              <Select value={evmMode} onChange={(e) => setEvmMode(e.target.value as EvmMode)}>
                <option value="auto">Auto ({delegated ? 'delegated' : 'direct'})</option>
                <option value="direct">Direct (EOA pays gas)</option>
                <option value="delegated" disabled={!delegated}>
                  Delegated (gasless via relayer)
                </option>
              </Select>
            </Field>
          )}
        </div>
        {isEvm && delegated && evmMode !== 'direct' && !config.relayerUrl && (
          <div className="mt-3">
            <Notice tone="warn">Delegated sends need VITE_RELAYER_URL to broadcast.</Notice>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Policy result</div>
          {!args ? (
            <p className="text-sm text-zinc-500">Enter a recipient and amount to preview the policy.</p>
          ) : checking || (!check && !checkErr) ? (
            <p className="flex items-center gap-2 text-sm text-zinc-400">
              <Spinner /> Checking policy…
            </p>
          ) : checkErr ? (
            <ErrorBox error={checkErr} title="Could not build this transfer" />
          ) : r && r.ok ? (
            <div className="space-y-1 text-sm">
              {r.delayed ? (
                <p className="text-amber-200">
                  <Badge tone="warn">Delayed</Badge> Allowed after a delay: executable in {duration(r.executableAt - now)} ({new Date(r.executableAt * 1000).toLocaleString()}).
                </p>
              ) : (
                <p className="text-emerald-300">
                  <Badge tone="good">Allowed</Badge> Allowed immediately.
                </p>
              )}
              {check?.prepared.fee !== undefined && (
                <p className="text-xs text-zinc-400">
                  Network fee: {chain === 'bitcoin' ? `${check.prepared.fee} sats` : `up to ${fmt(check.prepared.fee, 'ETH', 8)} ETH`}
                </p>
              )}
            </div>
          ) : r && !r.ok ? (
            <p className="text-sm text-red-300">
              <Badge tone="bad">{r.error}</Badge> {r.message}
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" busy={submitting} disabled={!args || blocked || !check} onClick={submit}>
            {app.vaultMode ? 'Build vault instructions' : 'Send'}
          </Button>
          {blocked && <span className="text-xs text-red-300">Blocked by policy: the program would reject this.</span>}
        </div>
        <div className="mt-3">
          <ErrorBox error={error} title="Send failed" />
        </div>
      </Card>

      {vault && (
        <VaultInstructions
          title="Propose this send from your vault"
          transactions={[vault.ixs]}
          footer={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  setHandle(acct.intent(vault.intent));
                  setVault(null);
                }}
              >
                Continue (vault executed)
              </Button>
              <span className="text-xs text-zinc-400">Intent: {vault.intent.toBase58()}</span>
            </div>
          }
        />
      )}
      {handle && <IntentProgress key={handle.h.intent.toBase58()} handle={handle.h} title={handle.title} />}
    </div>
  );
}

function safe<T>(f: () => T): T | false {
  try {
    return f();
  } catch {
    return false;
  }
}
