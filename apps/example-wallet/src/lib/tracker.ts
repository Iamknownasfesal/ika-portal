import { useEffect, useState, useSyncExternalStore } from 'react';
import type { IntentHandle, ProgressEvent } from '@ika-portal/core';

export interface TrackState {
  intent: string;
  events: ProgressEvent[];
  last?: ProgressEvent;
  solanaTx?: string;
  destinationTx?: string;
  destinationTxUrl?: string;
  executableAt?: number;
  done: boolean;
  error?: unknown;
}

// ── Local activity log (non-secret: tx hashes per intent) ────────────────
const LOG = 'ika-demo:v1:intent-log';
export interface IntentLog {
  solanaTx?: string;
  destinationTx?: string;
  destinationTxUrl?: string;
  status?: string;
}
export function intentLog(): Record<string, IntentLog> {
  try {
    return JSON.parse(localStorage.getItem(LOG) ?? '{}') as Record<string, IntentLog>;
  } catch {
    return {};
  }
}
function writeLog(intent: string, patch: IntentLog) {
  try {
    const all = intentLog();
    all[intent] = { ...all[intent], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    localStorage.setItem(LOG, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/**
 * Iterates `handle.progress()` exactly once per handle (safe under React
 * StrictMode double effects) and exposes the state as an external store.
 */
class Tracker {
  state: TrackState;
  private listeners = new Set<() => void>();

  constructor(handle: IntentHandle) {
    this.state = { intent: handle.intent.toBase58(), events: [], done: false };
    void this.run(handle);
  }

  private set(patch: Partial<TrackState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private async run(handle: IntentHandle) {
    try {
      for await (const e of handle.progress()) {
        this.set({
          events: [...this.state.events, e],
          last: e,
          solanaTx: e.solanaTx ?? this.state.solanaTx,
          destinationTx: e.destinationTx ?? this.state.destinationTx,
          destinationTxUrl: e.destinationTxUrl ?? this.state.destinationTxUrl,
          executableAt: e.executableAt ?? this.state.executableAt,
          error: e.error ?? this.state.error,
        });
        writeLog(this.state.intent, { solanaTx: e.solanaTx, destinationTx: e.destinationTx, destinationTxUrl: e.destinationTxUrl, status: e.status });
      }
    } catch (e) {
      this.set({ error: e });
    } finally {
      this.set({ done: true });
    }
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.state;
}

const trackers = new WeakMap<IntentHandle, Tracker>();
export function track(handle: IntentHandle): Tracker {
  let t = trackers.get(handle);
  if (!t) trackers.set(handle, (t = new Tracker(handle)));
  return t;
}

const EMPTY_SUB = () => () => undefined;
export function useTrack(handle: IntentHandle | null): TrackState | null {
  const t = handle ? track(handle) : null;
  return useSyncExternalStore(t ? t.subscribe : EMPTY_SUB, t ? t.get : () => null);
}

/** Current unix time, ticking every `ms`. */
export function useNow(ms = 1000): number {
  const [n, setN] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setN(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}
