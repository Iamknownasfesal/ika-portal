import { useEffect, useRef } from 'react';
import type { IntentHandle, ProgressStatus } from '@ika-portal/core';
import { solscanAddr, solscanTx } from '../config';
import { duration, short } from '../lib/format';
import { useNow, useTrack } from '../lib/tracker';
import { Badge, cx, ErrorBox, ExtLink, Spinner } from './ui';

const STEPS: { key: ProgressStatus; label: string; hint: string }[] = [
  { key: 'building', label: 'Propose', hint: 'Owner signs the intent on Solana' },
  { key: 'proposed', label: 'Proposed', hint: 'Policy checked on-chain' },
  { key: 'delayed', label: 'Delay', hint: 'Waiting for the policy delay' },
  { key: 'approved', label: 'Approved', hint: 'Program approved the digest for Ika' },
  { key: 'signed', label: 'Signed', hint: 'Ika signed the approved message' },
  { key: 'broadcast', label: 'Broadcast', hint: 'Sent to the destination chain' },
  { key: 'confirmed', label: 'Confirmed', hint: 'Included on the destination chain' },
];
const ORDER: ProgressStatus[] = ['building', 'awaiting_owner', 'proposed', 'delayed', 'approved', 'signed', 'broadcast', 'confirmed'];

export function IntentProgress({ handle, title, onDone }: { handle: IntentHandle; title?: string; onDone?: () => void }) {
  const s = useTrack(handle);
  const now = useNow();
  const fired = useRef(false);
  const done = !!s?.done;
  useEffect(() => {
    if (done && !fired.current) {
      fired.current = true;
      onDone?.();
    }
  }, [done, onDone]);
  if (!s) return null;
  const seen = new Set(s.events.map((e) => e.status));
  const last = s.last?.status;
  const maxIdx = Math.max(-1, ...s.events.map((e) => ORDER.indexOf(e.status)));
  const failed = last === 'failed';
  const cancelled = last === 'cancelled';
  const steps = STEPS.filter((st) => st.key !== 'delayed' || seen.has('delayed')).map((st) =>
    st.key === 'building' && seen.has('awaiting_owner') ? { ...st, label: 'Owner', hint: 'Waiting for the owner (vault) to propose' } : st,
  );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-zinc-200">{title ?? 'Intent progress'}</div>
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span>Intent</span>
          <ExtLink href={solscanAddr(s.intent)}>{short(s.intent)}</ExtLink>
          {s.done ? (
            <Badge tone={failed ? 'bad' : cancelled ? 'warn' : last === 'confirmed' ? 'good' : 'neutral'}>{last ?? 'done'}</Badge>
          ) : (
            <Badge tone="info">
              <Spinner className="h-2.5 w-2.5" /> {last ?? 'starting'}
            </Badge>
          )}
        </div>
      </div>
      <ol className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {steps.map((st) => {
          const idx = ORDER.indexOf(st.key === 'building' && seen.has('awaiting_owner') ? 'awaiting_owner' : st.key);
          const reached = seen.has(st.key) || idx <= maxIdx;
          const active = !s.done && (last === st.key || (st.key === 'building' && last === 'awaiting_owner'));
          const done = reached && !active;
          return (
            <li
              key={st.key}
              className={cx(
                'rounded-lg border px-2.5 py-2 text-xs',
                active ? 'border-indigo-400/60 bg-indigo-500/10' : done ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-900/40',
              )}
            >
              <div className={cx('flex items-center gap-1.5 font-medium', active ? 'text-indigo-200' : done ? 'text-emerald-300' : 'text-zinc-500')}>
                {active ? <Spinner className="h-2.5 w-2.5" /> : <span aria-hidden>{done ? '✓' : '•'}</span>}
                {st.label}
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{st.hint}</div>
            </li>
          );
        })}
      </ol>

      {last === 'delayed' && s.executableAt && !s.done && (
        <p className="mt-3 text-sm text-amber-200">
          Delayed by policy. Executable in <span className="font-mono">{duration(s.executableAt - now)}</span> ({new Date(s.executableAt * 1000).toLocaleString()}). Keep this tab open, or
          resume later from Activity.
        </p>
      )}
      {last === 'awaiting_owner' && !s.done && <p className="mt-3 text-sm text-zinc-400">Waiting for the intent account to appear on-chain (execute the vault transaction in Squads).</p>}

      <div className="mt-3 flex flex-col gap-1 text-xs text-zinc-400">
        {s.solanaTx && (
          <div>
            Solana approval tx: <ExtLink href={solscanTx(s.solanaTx)}>{short(s.solanaTx, 10)}</ExtLink>
          </div>
        )}
        {s.destinationTx && (
          <div>
            Destination tx: {s.destinationTxUrl ? <ExtLink href={s.destinationTxUrl}>{short(s.destinationTx, 10)}</ExtLink> : <span className="font-mono">{s.destinationTx}</span>}
          </div>
        )}
      </div>
      {s.error ? (
        <div className="mt-3">
          <ErrorBox error={s.error} title="Intent failed" />
        </div>
      ) : null}
    </div>
  );
}
