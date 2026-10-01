import { useCallback, useEffect, useState } from 'react';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { AssetSymbol, Chain, EvmChain, IntentHandle } from '@ika-portal/core';
import { useApp } from '../lib/app';
import { addrUrl, config, solscanAddr } from '../config';
import { CHAIN_LABEL, duration, fmt } from '../lib/format';
import { useNow } from '../lib/tracker';
import { draftToPolicy, PolicyForm, PolicySummary, policyToDraft, type PolicyDraft } from '../components/policy';
import { IntentProgress } from '../components/progress';
import { VaultInstructions } from '../components/vault';
import { Badge, Button, Card, CopyButton, ErrorBox, ExtLink, KV, Mono, Notice } from '../components/ui';

type Balances = Partial<Record<Chain, Partial<Record<AssetSymbol, bigint>>>>;

const MODE_LABEL = { recoverable: 'Recoverable', enforced: 'Enforced', enforced_recovery: 'Enforced with recovery' } as const;

export function AccountScreen() {
  const app = useApp();
  const acct = app.account!;
  const now = useNow();
  const [balances, setBalances] = useState<Balances | null>(null);
  const [balErr, setBalErr] = useState<unknown>(null);
  const [balBusy, setBalBusy] = useState(false);
  const [, force] = useState(0);
  const [editing, setEditing] = useState<PolicyDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [vaultIxs, setVaultIxs] = useState<{ title: string; ixs: TransactionInstruction[]; intent?: string; chain?: EvmChain } | null>(null);
  const [setupHandles, setSetupHandles] = useState<Partial<Record<EvmChain, IntentHandle>>>({});

  const loadBalances = useCallback(async () => {
    setBalBusy(true);
    setBalErr(null);
    try {
      setBalances(await acct.balances());
    } catch (e) {
      setBalErr(e);
    } finally {
      setBalBusy(false);
    }
  }, [acct]);
  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  const v = acct.view;
  const addrs = acct.addresses;

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      force((x) => x + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const refresh = () => run('refresh', async () => {
    await acct.refresh();
    await loadBalances();
  });

  const pending = v.pendingPolicy;
  const readyIn = pending ? v.pendingPolicyAt - now : 0;

  const proposePolicy = () => {
    const parsed = editing ? draftToPolicy(editing) : null;
    if (!parsed?.policy) return;
    const next = parsed.policy;
    return run('propose', async () => {
      if (app.vaultMode) setVaultIxs({ title: 'Propose policy change', ixs: await acct.instructions.proposePolicy(next) });
      else await acct.proposePolicy(next);
      setEditing(null);
    });
  };

  const isDelegated = (c: EvmChain) => {
    try {
      return acct.isDelegated(c);
    } catch {
      return null;
    }
  };

  const setupEvm = (chain: EvmChain) =>
    run(`setup-${chain}`, async () => {
      if (app.vaultMode) {
        const ixs = await acct.instructions.setupEvm(chain);
        setVaultIxs({ title: `Enable gasless (7702) on ${CHAIN_LABEL[chain]}`, ixs, intent: acct.nextIntentAddress().toBase58(), chain });
      } else {
        const h = await acct.setupEvm(chain);
        setSetupHandles((s) => ({ ...s, [chain]: h }));
      }
    });

  return (
    <div className="space-y-4">
      <Card
        title="Account"
        subtitle={
          <>
            <span className="break-all"><ExtLink href={solscanAddr(v.address.toBase58())}>{v.address.toBase58()}</ExtLink></span>
          </>
        }
        actions={
          <Button onClick={refresh} busy={busy === 'refresh'}>
            Refresh
          </Button>
        }
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <Badge tone="info">{MODE_LABEL[v.mode]}</Badge>
          <Badge tone={v.userShare === 'encrypted' ? 'good' : 'neutral'}>{v.userShare === 'encrypted' ? 'Encrypted user share' : 'Public user share'}</Badge>
          {app.vaultMode && <Badge tone="warn">Squads vault owner</Badge>}
          <Badge>index {v.index}</Badge>
        </div>
        <dl>
          <KV k="Owner">
            <Mono>{v.owner.toBase58()}</Mono>
          </KV>
          <KV k="dWallets">
            {v.dwallets.map((d) => (
              <div key={d.address.toBase58()} className="flex min-w-0 items-center gap-2">
                <Badge>{d.role}</Badge>
                <ExtLink href={solscanAddr(d.address.toBase58())}>
                  <span className="font-mono text-xs break-all">{d.address.toBase58()}</span>
                </ExtLink>
              </div>
            ))}
            {acct.dwallets.length === 0 && <p className="mt-1 text-xs text-amber-300">No dWallet references in this browser: Ika signing will fail. They are saved when the account is created here.</p>}
          </KV>
        </dl>
      </Card>

      <Card title="Addresses & balances" actions={<Button onClick={loadBalances} busy={balBusy}>Reload balances</Button>}>
        <div className="divide-y divide-zinc-800">
          {(['bitcoin', 'ethereum', 'base'] as const).map((c) => {
            const a = addrs[c];
            const b = balances?.[c];
            return (
              <div key={c} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center">
                <div className="w-40 shrink-0 text-sm font-medium text-zinc-300">{CHAIN_LABEL[c]}</div>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {a ? (
                    <>
                      <ExtLink href={addrUrl(c, a)}>
                        <span className="font-mono text-xs break-all">{a}</span>
                      </ExtLink>
                      <CopyButton value={a} />
                    </>
                  ) : (
                    <span className="text-xs text-zinc-500">No address</span>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-3 text-sm tabular-nums md:justify-end">
                  {(c === 'bitcoin' ? (['BTC'] as const) : (['ETH', 'USDC'] as const)).map((asset) => (
                    <span key={asset}>
                      <span className="text-zinc-100">{balances ? fmt(b?.[asset], asset, 6) : '…'}</span> <span className="text-zinc-500">{asset}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {balErr ? (
          <div className="mt-3">
            <ErrorBox error={balErr} title="Could not load balances" />
          </div>
        ) : null}
      </Card>

      <Card title="EVM execution" subtitle="Direct mode: the dWallet EOA pays its own gas. Gasless mode: EIP-7702 delegation to IkaAccount; a relayer submits signed calls.">
        <div className="space-y-3">
          {(['ethereum', 'base'] as const).map((c) => {
            const d = isDelegated(c);
            const h = setupHandles[c];
            return (
              <div key={c} className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-40 text-sm font-medium text-zinc-300">{CHAIN_LABEL[c]}</span>
                  {d === null ? <Badge tone="bad">not in program Config</Badge> : d ? <Badge tone="good">Gasless (7702) enabled</Badge> : <Badge>Direct mode</Badge>}
                  {d === false &&
                    (config.relayerUrl ? (
                      <Button onClick={() => setupEvm(c)} busy={busy === `setup-${c}`} disabled={!!h}>
                        Enable gasless (7702)
                      </Button>
                    ) : (
                      <span className="text-xs text-zinc-500">Set VITE_RELAYER_URL to enable gasless mode</span>
                    ))}
                </div>
                {h && <IntentProgress handle={h} title={`7702 setup on ${CHAIN_LABEL[c]}`} onDone={() => void refresh()} />}
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Policy"
        actions={
          !editing && !pending ? (
            <Button onClick={() => setEditing(policyToDraft(v.policy))}>Propose change</Button>
          ) : null
        }
      >
        <PolicySummary policy={v.policy} />
      </Card>

      {pending && (
        <Card title="Pending policy change" subtitle={readyIn > 0 ? `Can be applied in ${duration(readyIn)} (${new Date(v.pendingPolicyAt * 1000).toLocaleString()})` : 'Ready to apply'}>
          <PolicySummary policy={pending} />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={readyIn > 0}
              busy={busy === 'apply'}
              onClick={() =>
                run('apply', async () => {
                  await acct.applyPolicy();
                })
              }
            >
              {readyIn > 0 ? `Apply in ${duration(readyIn)}` : 'Apply'}
            </Button>
            <Button
              variant="danger"
              busy={busy === 'cancel'}
              onClick={() =>
                run('cancel', async () => {
                  if (app.vaultMode) setVaultIxs({ title: 'Cancel pending policy', ixs: await acct.instructions.cancelPolicy() });
                  else await acct.cancelPolicy();
                })
              }
            >
              Cancel change
            </Button>
            <span className="text-xs text-zinc-500">Applying is permissionless (your wallet pays the fee); cancelling needs the owner.</span>
          </div>
        </Card>
      )}

      {editing && (
        <Card title="Propose a policy change" subtitle={`Takes effect after the current policy change delay (${duration(v.policy.policyChangeDelayS)}).`}>
          <PolicyForm draft={editing} onChange={setEditing} />
          {draftToPolicy(editing).error && <p className="mt-3 text-sm text-amber-300">{draftToPolicy(editing).error}</p>}
          <div className="mt-4 flex gap-2">
            <Button variant="primary" busy={busy === 'propose'} disabled={!!draftToPolicy(editing).error} onClick={proposePolicy}>
              {app.vaultMode ? 'Build vault instructions' : 'Propose'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Discard
            </Button>
          </div>
        </Card>
      )}

      {vaultIxs && (
        <VaultInstructions
          title={vaultIxs.title}
          transactions={[vaultIxs.ixs]}
          footer={
            <div className="flex flex-wrap gap-2">
              {vaultIxs.intent && vaultIxs.chain && (
                <Button
                  variant="primary"
                  onClick={() => {
                    const h = acct.intent(new PublicKey(vaultIxs.intent!));
                    setSetupHandles((s) => ({ ...s, [vaultIxs.chain!]: h }));
                    setVaultIxs(null);
                  }}
                >
                  Continue (vault executed)
                </Button>
              )}
              <Button
                onClick={() => {
                  setVaultIxs(null);
                  void refresh();
                }}
              >
                {vaultIxs.intent ? 'Dismiss' : 'Done, refresh'}
              </Button>
            </div>
          }
        />
      )}

      <ErrorBox error={error} />
      {app.vaultMode && <Notice>Squads mode: owner actions produce instructions for a vault transaction. Permissionless steps (approve, apply) are paid by your connected wallet.</Notice>}
    </div>
  );
}
