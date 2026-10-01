import { useState } from 'react';
import { defaultPolicy, type Mode, type PreparedAccount, type UserShareMode } from '@ika-portal/core';
import type { RecoveryKey } from '@ika-portal/core';
import { useApp } from '../lib/app';
import { saveRefs } from '../lib/storage';
import { duration } from '../lib/format';
import { draftToPolicy, PolicyForm, policyToDraft, type PolicyDraft } from '../components/policy';
import { VaultInstructions } from '../components/vault';
import { Badge, Button, Card, cx, ErrorBox, Field, Input, Mono, Notice, CopyButton } from '../components/ui';

// User-facing copy for modes and user shares (keep in sync with docs/concepts.md).
const MODES: { id: Mode; title: string; copy: string; note?: string }[] = [
  {
    id: 'recoverable',
    title: 'Recoverable',
    copy: 'You keep a recovery phrase. It works in any wallet, and it can bypass your policies.',
    note: 'The Ika pre-alpha cannot import keys yet, so creation fails with Unsupported on devnet.',
  },
  { id: 'enforced', title: 'Enforced', copy: "No full key exists. Policies can't be bypassed. If Ika becomes permanently unavailable, funds can't be moved." },
  { id: 'enforced_recovery', title: 'Enforced with recovery', copy: 'No full key exists. If Ika is unavailable, your recovery key can move funds after the delay.' },
];
const SHARES: { id: UserShareMode; title: string; copy: string }[] = [
  { id: 'public', title: 'Public', copy: "Your Solana account's approval is enough to sign." },
  { id: 'encrypted', title: 'Encrypted', copy: 'Only your device can unlock your key share. Nothing is signed without it.' },
];

interface Secrets {
  mnemonic?: string;
  recoveryKey?: RecoveryKey;
}

export function CreateScreen({ onDone }: { onDone(): void }) {
  const app = useApp();
  const { ika, owner, vaultMode, ownerIsPda, index } = app;
  const [mode, setMode] = useState<Mode>('enforced');
  const [share, setShare] = useState<UserShareMode>('public');
  const [csvBlocks, setCsv] = useState('6');
  const [evmDelay, setEvmDelay] = useState('3600');
  const [draft, setDraft] = useState<PolicyDraft>(() => policyToDraft(defaultPolicy()));
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [saved, setSaved] = useState(false);
  const [prepared, setPrepared] = useState<PreparedAccount | null>(null);
  const [waiting, setWaiting] = useState(false);

  const hideShare = vaultMode || ownerIsPda;
  const userShare: UserShareMode = hideShare ? 'public' : share;
  const parsed = draftToPolicy(draft);

  async function create() {
    if (!ika || !owner || !parsed.policy) return;
    setBusy(true);
    setError(null);
    setStage('Running Ika DKG on devnet. This can take a minute.');
    try {
      const args = {
        owner,
        index,
        mode,
        userShare,
        policy: parsed.policy,
        recovery: mode === 'enforced_recovery' ? { csvBlocks: Number(csvBlocks), evmDelayS: Number(evmDelay) } : undefined,
      };
      if (vaultMode) {
        const p = await ika.prepareAccount(args);
        saveRefs(owner, index, p.dwallets);
        setPrepared(p);
        setSecrets(p.mnemonic || p.recoveryKey ? { mnemonic: p.mnemonic, recoveryKey: p.recoveryKey } : null);
      } else {
        // createAccount runs DKG, then asks the wallet to sign the create + register transactions.
        const r = await ika.createAccount(args);
        saveRefs(owner, index, r.dwallets);
        app.setAccount(r.account);
        if (r.mnemonic || r.recoveryKey) setSecrets({ mnemonic: r.mnemonic, recoveryKey: r.recoveryKey });
        else onDone();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setStage('');
    }
  }

  async function continueVault() {
    if (!ika || !owner || !prepared) return;
    setWaiting(true);
    setError(null);
    try {
      const a = await ika.waitForAccount({ owner, index, dwallets: prepared.dwallets, timeoutMs: 600_000 });
      app.setAccount(a);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setWaiting(false);
    }
  }

  if (!owner) return <Notice>Connect a wallet{vaultMode ? ' and enter the Squads vault address' : ''} to create an account.</Notice>;

  // After creation: show the secret once.
  if (secrets || prepared) {
    const gate = !!secrets && !saved;
    return (
      <div className="space-y-4">
        {secrets && (
          <Card title={secrets.mnemonic ? 'Your recovery phrase' : 'Your recovery key'} subtitle="Shown once. It is not stored anywhere: not in this browser, not by the SDK.">
            <SecretView secrets={secrets} />
            <label className="mt-4 flex items-center gap-2 text-sm text-zinc-200">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-4 w-4 accent-indigo-500" />I saved it
            </label>
          </Card>
        )}
        {prepared ? (
          <Card title="Create the account from your vault" subtitle={`Account ${prepared.account.toBase58()}`}>
            {gate ? (
              <Notice>Confirm you saved the recovery {secrets?.mnemonic ? 'phrase' : 'key'} to see the vault instructions.</Notice>
            ) : (
              <div className="space-y-3">
                <VaultInstructions transactions={prepared.transactions} />
                <p className="text-xs text-zinc-400">The dWallet references were saved in this browser. After the vault executes every transaction, continue.</p>
                <Button variant="primary" busy={waiting} onClick={continueVault}>
                  {waiting ? 'Waiting for the account on-chain…' : 'Continue'}
                </Button>
                <ErrorBox error={error} />
              </div>
            )}
          </Card>
        ) : (
          <Button variant="primary" disabled={gate} onClick={onDone}>
            Continue to account
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {app.accountStatus === 'ready' && (
        <Notice tone="warn">
          An account already exists for this owner at index {index}. Change the account index in the header to create another one.
        </Notice>
      )}
      <Card title="Key mode" subtitle="How the account's keys are generated. Fixed at creation.">
        <div className="grid gap-3 md:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cx(
                'rounded-lg border p-3 text-left transition-colors',
                mode === m.id ? 'border-indigo-400 bg-indigo-500/10' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-600',
              )}
              aria-pressed={mode === m.id}
            >
              <div className="flex min-h-6 items-center justify-between">
                <span className="text-sm font-semibold text-zinc-100">{m.title}</span>
                {mode === m.id && <Badge tone="info">Selected</Badge>}
              </div>
              <p className="mt-1.5 text-sm text-zinc-300">{m.copy}</p>
              {m.note && <p className="mt-2 text-xs text-amber-300/80">{m.note}</p>}
            </button>
          ))}
        </div>
        {mode === 'enforced_recovery' && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Bitcoin CSV delay (blocks)" hint="Each UTXO becomes recoverable this many blocks after it confirms.">
              <Input value={csvBlocks} onChange={(e) => setCsv(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
            </Field>
            <Field label="EVM recovery delay (seconds)" hint={duration(Number(evmDelay) || 0)}>
              <Input value={evmDelay} onChange={(e) => setEvmDelay(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
            </Field>
          </div>
        )}
      </Card>

      {!hideShare && (
        <Card title="User share" subtitle="Where your key share lives. Independent of the key mode.">
          <div className="grid gap-3 md:grid-cols-2">
            {SHARES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setShare(s.id)}
                className={cx('rounded-lg border p-3 text-left transition-colors', share === s.id ? 'border-indigo-400 bg-indigo-500/10' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-600')}
                aria-pressed={share === s.id}
              >
                <div className="flex min-h-6 items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-100">{s.title}</span>
                  {share === s.id && <Badge tone="info">Selected</Badge>}
                </div>
                <p className="mt-1.5 text-sm text-zinc-300">{s.copy}</p>
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card title="Policy" subtitle="Enforced by the Solana program before Ika signs anything. Changes later go through the policy change delay.">
        <PolicyForm draft={draft} onChange={setDraft} />
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" busy={busy} disabled={!ika || app.initState !== 'ready' || !!parsed.error} onClick={create}>
            {vaultMode ? 'Prepare vault transactions' : 'Create account'}
          </Button>
          <span className="text-xs text-zinc-400">
            Owner <Mono>{owner.toBase58()}</Mono> · index {index}
          </span>
        </div>
        {parsed.error && <p className="mt-2 text-sm text-amber-300">{parsed.error}</p>}
        {stage && <p className="mt-2 text-sm text-zinc-400">{stage}</p>}
        <div className="mt-3">
          <ErrorBox error={error} title="Account creation failed" />
        </div>
      </Card>
    </div>
  );
}

function SecretView({ secrets }: { secrets: Secrets }) {
  if (secrets.mnemonic) {
    const words = secrets.mnemonic.split(' ');
    return (
      <div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {words.map((w, i) => (
            <li key={i} className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-sm">
              <span className="mr-2 text-zinc-600">{i + 1}</span>
              {w}
            </li>
          ))}
        </ol>
        <div className="mt-3">
          <CopyButton value={secrets.mnemonic} label="Copy phrase" />
        </div>
      </div>
    );
  }
  const k = secrets.recoveryKey!;
  return (
    <div className="space-y-3">
      <Field label="Recovery private key (keep offline)">
        <div className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-2">
          <Mono className="flex-1">{k.privateKey}</Mono>
          <CopyButton value={k.privateKey} />
        </div>
      </Field>
      <Field label="Recovery public key">
        <Mono>{k.publicKey}</Mono>
      </Field>
      <p className="text-xs text-zinc-500">Use it in the Recovery tab (or any tool that can spend the CSV branch / call IkaAccount.initiateRecovery) if Ika is unavailable.</p>
    </div>
  );
}
