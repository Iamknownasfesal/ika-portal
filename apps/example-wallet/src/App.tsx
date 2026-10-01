import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useApp } from './lib/app';
import { config } from './config';
import { exportSessionKey, importSessionKey, knownAccounts, sessionKey } from './lib/storage';
import { short } from './lib/format';
import { Badge, Button, Card, CopyButton, cx, ErrorBox, Input, Mono, Notice, Spinner, Toggle } from './components/ui';
import { CreateScreen } from './screens/Create';
import { AccountScreen } from './screens/Account';
import { SendScreen } from './screens/Send';
import { SwapScreen } from './screens/Swap';
import { ActivityScreen } from './screens/Activity';
import { RecoveryScreen } from './screens/Recovery';

type Tab = 'create' | 'account' | 'send' | 'swap' | 'activity' | 'recovery';
const TABS: { id: Tab; label: string; needsAccount: boolean }[] = [
  { id: 'create', label: 'Create', needsAccount: false },
  { id: 'account', label: 'Account', needsAccount: true },
  { id: 'send', label: 'Send', needsAccount: true },
  { id: 'swap', label: 'Swap', needsAccount: true },
  { id: 'activity', label: 'Activity', needsAccount: true },
  { id: 'recovery', label: 'Recovery', needsAccount: true },
];

export function App() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('account');

  // Land on Create when there is no account yet.
  useEffect(() => {
    if (app.accountStatus === 'missing') setTab((t) => (TABS.find((x) => x.id === t)?.needsAccount ? 'create' : t));
  }, [app.accountStatus]);

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 md:flex-row md:gap-6 md:py-6">
        <nav className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 md:mx-0 md:w-44 md:flex-col md:overflow-visible md:px-0" aria-label="Screens">
          {TABS.filter((t) => t.id !== 'recovery' || !app.account || app.account.view.mode === 'enforced_recovery').map((t) => {
            const disabled = t.needsAccount && app.accountStatus !== 'ready';
            return (
              <button
                key={t.id}
                type="button"
                disabled={disabled}
                onClick={() => setTab(t.id)}
                className={cx(
                  'shrink-0 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  tab === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                )}
                aria-current={tab === t.id ? 'page' : undefined}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1">
          <Body tab={tab} setTab={setTab} />
        </main>
      </div>
      <footer className="border-t border-zinc-900 py-4 text-center text-xs text-zinc-500">Testnet demo. Ika pre-alpha uses a mock signer.</footer>
    </div>
  );
}

function Body({ tab, setTab }: { tab: Tab; setTab(t: Tab): void }) {
  const app = useApp();
  if (!app.walletConnected) {
    return (
      <Card title="Connect a Solana wallet" subtitle="Devnet. The wallet owns the account (or pays fees for a Squads vault owner).">
        <p className="mb-4 text-sm text-zinc-400">
          Ika Portal gives one Solana owner Bitcoin and EVM addresses, controlled by an on-chain policy and signed by Ika dWallets. Switch your wallet to devnet and connect.
        </p>
        <WalletMultiButton />
      </Card>
    );
  }
  if (app.initState === 'loading' || app.initState === 'idle') return <Loading label="Loading the ika_account program Config…" />;
  if (app.initState === 'error') return <ErrorBox error={app.initError} title="Could not load the program Config (is VITE_PROGRAM_ID deployed on this cluster?)" />;
  if (app.ownerError) return <Notice tone="warn">{app.ownerError}</Notice>;

  if (tab === 'create') return <CreateScreen onDone={() => setTab('account')} />;
  if (app.accountStatus === 'loading') return <Loading label="Loading account…" />;
  if (app.accountStatus === 'error') {
    return (
      <div className="space-y-3">
        <ErrorBox error={app.accountError} title="Could not load the account" />
        <Button onClick={() => void app.reloadAccount()}>Retry</Button>
      </div>
    );
  }
  if (app.accountStatus !== 'ready' || !app.account) {
    return (
      <Card title="No account yet">
        <p className="mb-3 text-sm text-zinc-400">
          No Ika account for this owner at index {app.index}. {app.vaultMode ? 'If the vault already executed the create transactions, refresh.' : ''}
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setTab('create')}>
            Create an account
          </Button>
          <Button onClick={() => void app.reloadAccount()}>Refresh</Button>
        </div>
      </Card>
    );
  }
  switch (tab) {
    case 'account':
      return <AccountScreen />;
    case 'send':
      return <SendScreen />;
    case 'swap':
      return <SwapScreen />;
    case 'activity':
      return <ActivityScreen />;
    case 'recovery':
      return <RecoveryScreen />;
  }
}

const Loading = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 p-6 text-sm text-zinc-400">
    <Spinner /> {label}
  </div>
);

function Header() {
  const app = useApp();
  const wallet = useWallet();
  const [showSession, setShowSession] = useState(false);
  const known = knownAccounts();
  return (
    <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="" className="h-7 w-7" />
          <span className="font-semibold text-zinc-100">Ika Portal</span>
          <Badge tone="warn">Devnet</Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setShowSession((s) => !s)} className="hidden rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 sm:block">
            Ika session key {short(sessionKey().publicKey.toBase58(), 4)}
          </button>
          <WalletMultiButton />
        </div>
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 pb-3">
        <Toggle checked={app.vaultMode} onChange={app.setVaultMode} label="Owner is a Squads vault" />
        {app.vaultMode && (
          <Input
            value={app.vaultAddress}
            onChange={(e) => app.setVaultAddress(e.target.value)}
            placeholder="Squads vault address (PDA)"
            className="w-full max-w-md py-1.5 font-mono text-xs"
            spellCheck={false}
          />
        )}
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-zinc-400">
          Account index
          <Input
            type="number"
            min={0}
            max={65535}
            value={app.index}
            onChange={(e) => app.setIndex(Math.max(0, Math.min(65535, Number(e.target.value) || 0)))}
            className="w-20 py-1.5"
          />
        </label>
        {known.length > 1 && (
          <select
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300"
            value=""
            onChange={(e) => {
              const k = known[Number(e.target.value)];
              if (!k) return;
              app.setIndex(k.index);
              if (k.owner === wallet.publicKey?.toBase58()) app.setVaultMode(false);
              else {
                app.setVaultMode(true);
                app.setVaultAddress(k.owner);
              }
            }}
            aria-label="Known accounts"
          >
            <option value="">Recent accounts…</option>
            {known.map((k, i) => (
              <option key={`${k.owner}-${k.index}`} value={i}>
                {short(k.owner, 4)} #{k.index}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={() => setShowSession((s) => !s)} className="text-xs text-zinc-500 underline sm:hidden">
          Ika session key
        </button>
      </div>
      {showSession && <SessionPanel onClose={() => setShowSession(false)} />}
    </header>
  );
}

function SessionPanel({ onClose }: { onClose(): void }) {
  const [imp, setImp] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const pk = sessionKey().publicKey.toBase58();
  return (
    <div className="mx-auto max-w-6xl px-4 pb-4">
      <Card
        title="Ika session key"
        subtitle="Non-custodial. An Ed25519 key generated in this browser to authenticate requests to the Ika network. It cannot move funds: every signature needs an on-chain approval under your account's policy."
        actions={
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Mono>{pk}</Mono>
            <CopyButton value={pk} />
          </div>
          <p className="text-xs text-zinc-500">
            Accounts record this key as their Ika user. To use an account from another browser, copy the session key there together with its dWallet references (both are stored in
            localStorage).
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={exportSessionKey()} label="Copy session key (export)" />
            <Input value={imp} onChange={(e) => setImp(e.target.value)} placeholder="Paste an exported session key to import" className="max-w-md py-1.5 font-mono text-xs" />
            <Button
              disabled={!imp}
              onClick={() => {
                try {
                  importSessionKey(imp);
                  location.reload();
                } catch (e) {
                  setErr(e);
                }
              }}
            >
              Import & reload
            </Button>
          </div>
          <ErrorBox error={err} />
          <p className="text-xs text-zinc-500">
            Program <Mono>{config.programId.toBase58()}</Mono> · Ika dWallet program <Mono>{config.dwalletProgramId.toBase58()}</Mono> · RPC <Mono>{config.solanaRpc}</Mono>
            {config.relayerUrl && (
              <>
                {' '}
                · relayer <Mono>{config.relayerUrl}</Mono>
              </>
            )}
          </p>
        </div>
      </Card>
    </div>
  );
}
