import type { ReactNode } from 'react';
import type { AssetSymbol, Chain, Policy } from '@ika-portal/core';
import { formatUnits, parseUnits } from 'viem';
import { ASSETS_ON, CHAIN_LABEL, CHAINS, duration, fmt, parseAmount, short } from '../lib/format';
import { Badge, Button, Field, Input, Select, Toggle } from './ui';

interface LimitRow {
  chain: Chain;
  asset: AssetSymbol;
  amount: string;
  windowS: string;
}
interface AllowRow {
  chain: Chain;
  address: string;
}
interface ThresholdRow {
  chain: Chain;
  asset: AssetSymbol;
  amount: string;
}
export interface PolicyDraft {
  limits: LimitRow[];
  allowlistEnabled: boolean;
  allowlist: AllowRow[];
  delayThresholds: ThresholdRow[];
  delayS: string;
  swapsEnabled: boolean;
  swapLimits: LimitRow[];
  maxBtcFeeSats: string;
  maxEvmFeeEth: string;
  policyChangeDelayS: string;
}

export function policyToDraft(p: Policy): PolicyDraft {
  const lim = (l: Policy['limits'][number]): LimitRow => ({ chain: l.chain, asset: l.asset, amount: fmt(l.maxPerWindow, l.asset, 18), windowS: String(l.windowS) });
  return {
    limits: p.limits.map(lim),
    allowlistEnabled: p.allowlistEnabled,
    allowlist: p.allowlist.map((a) => ({ ...a })),
    delayThresholds: p.delayThresholds.map((t) => ({ chain: t.chain, asset: t.asset, amount: fmt(t.amount, t.asset, 18) })),
    delayS: String(p.delayS),
    swapsEnabled: p.swapsEnabled,
    swapLimits: p.swapLimits.map(lim),
    maxBtcFeeSats: p.maxBtcFeeSats.toString(),
    maxEvmFeeEth: formatUnits(p.maxEvmFeeWei, 18),
    policyChangeDelayS: String(p.policyChangeDelayS),
  };
}

const int = (s: string, what: string) => {
  if (!/^\d+$/.test(s.trim())) throw new Error(`${what}: enter a whole number of seconds`);
  return Number(s.trim());
};
const amt = (s: string, asset: AssetSymbol, what: string) => {
  const v = parseAmount(s, asset);
  if (v === null) throw new Error(`${what}: invalid ${asset} amount "${s}"`);
  return v;
};

export function draftToPolicy(d: PolicyDraft): { policy: Policy; error?: undefined } | { policy?: undefined; error: string } {
  try {
    const lim = (kind: string) => (l: LimitRow) => ({ chain: l.chain, asset: l.asset, maxPerWindow: amt(l.amount, l.asset, kind), windowS: int(l.windowS, `${kind} window`) });
    const dup = (rows: { chain: Chain; asset: AssetSymbol }[], what: string) => {
      const keys = rows.map((r) => `${r.chain}:${r.asset}`);
      if (new Set(keys).size !== keys.length) throw new Error(`${what}: one row per chain/asset`);
    };
    dup(d.limits, 'Limits');
    dup(d.swapLimits, 'Swap limits');
    dup(d.delayThresholds, 'Delay thresholds');
    if (!/^\d+$/.test(d.maxBtcFeeSats.trim())) throw new Error('Max BTC fee: whole sats');
    let maxEvmFeeWei: bigint;
    try {
      maxEvmFeeWei = parseUnits(d.maxEvmFeeEth.trim() || '0', 18);
    } catch {
      throw new Error('Max EVM fee: invalid ETH amount');
    }
    for (const a of d.allowlist) if (!a.address.trim()) throw new Error('Allowlist: empty address');
    return {
      policy: {
        limits: d.limits.map(lim('Limit')),
        allowlistEnabled: d.allowlistEnabled,
        allowlist: d.allowlist.map((a) => ({ chain: a.chain, address: a.address.trim() })),
        delayThresholds: d.delayThresholds.map((t) => ({ chain: t.chain, asset: t.asset, amount: amt(t.amount, t.asset, 'Delay threshold') })),
        delayS: int(d.delayS, 'Delay'),
        swapsEnabled: d.swapsEnabled,
        swapLimits: d.swapLimits.map(lim('Swap limit')),
        maxBtcFeeSats: BigInt(d.maxBtcFeeSats.trim()),
        maxEvmFeeWei,
        policyChangeDelayS: int(d.policyChangeDelayS, 'Policy change delay'),
      },
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function ChainAsset({ chain, asset, onChange }: { chain: Chain; asset: AssetSymbol; onChange(c: Chain, a: AssetSymbol): void }) {
  return (
    <>
      <Select value={chain} onChange={(e) => onChange(e.target.value as Chain, ASSETS_ON[e.target.value as Chain][0]!)} aria-label="Chain">
        {CHAINS.map((c) => (
          <option key={c} value={c}>
            {CHAIN_LABEL[c]}
          </option>
        ))}
      </Select>
      <Select value={asset} onChange={(e) => onChange(chain, e.target.value as AssetSymbol)} aria-label="Asset">
        {ASSETS_ON[chain].map((a) => (
          <option key={a}>{a}</option>
        ))}
      </Select>
    </>
  );
}

const WINDOWS = [
  ['3600', '1 hour'],
  ['86400', '24 hours'],
  ['604800', '7 days'],
] as const;

function LimitRows({ rows, onChange, label }: { rows: LimitRow[]; onChange(r: LimitRow[]): void; label: string }) {
  const set = (i: number, patch: Partial<LimitRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1.3fr_0.8fr_1fr_1fr_auto]">
          <ChainAsset chain={r.chain} asset={r.asset} onChange={(chain, asset) => set(i, { chain, asset })} />
          <Input value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder={`max ${r.asset}`} inputMode="decimal" aria-label="Max per window" />
          <Select value={WINDOWS.some(([v]) => v === r.windowS) ? r.windowS : 'custom'} onChange={(e) => set(i, { windowS: e.target.value === 'custom' ? r.windowS : e.target.value })} aria-label="Window">
            {WINDOWS.map(([v, l]) => (
              <option key={v} value={v}>
                per {l}
              </option>
            ))}
            {!WINDOWS.some(([v]) => v === r.windowS) && <option value="custom">per {duration(Number(r.windowS))}</option>}
          </Select>
          <Button variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">
            Remove
          </Button>
        </div>
      ))}
      <Button variant="ghost" className="px-0 text-indigo-300" onClick={() => onChange([...rows, { chain: 'bitcoin', asset: 'BTC', amount: '0.01', windowS: '86400' }])}>
        + Add {label}
      </Button>
    </div>
  );
}

export function PolicyForm({ draft, onChange }: { draft: PolicyDraft; onChange(d: PolicyDraft): void }) {
  const set = (patch: Partial<PolicyDraft>) => onChange({ ...draft, ...patch });
  const secHint = (s: string) => (/^\d+$/.test(s) ? duration(Number(s)) : 'seconds');
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Spending limits</h3>
        <p className="mb-2 text-xs text-zinc-500">Rolling window caps per chain and asset. No row means no limit.</p>
        <LimitRows rows={draft.limits} onChange={(limits) => set({ limits })} label="limit" />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Recipient allowlist</h3>
        <Toggle checked={draft.allowlistEnabled} onChange={(allowlistEnabled) => set({ allowlistEnabled })} label="Only allow sends to listed addresses" />
        {draft.allowlistEnabled && (
          <div className="mt-2 space-y-2">
            {draft.allowlist.map((a, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[180px_1fr_auto]">
                <Select
                  value={a.chain}
                  onChange={(e) => set({ allowlist: draft.allowlist.map((x, j) => (j === i ? { ...x, chain: e.target.value as Chain } : x)) })}
                  className="col-span-2 sm:col-span-1"
                  aria-label="Chain"
                >
                  {CHAINS.map((c) => (
                    <option key={c} value={c}>
                      {CHAIN_LABEL[c]}
                    </option>
                  ))}
                </Select>
                <Input
                  value={a.address}
                  placeholder={a.chain === 'bitcoin' ? 'tb1…' : '0x…'}
                  onChange={(e) => set({ allowlist: draft.allowlist.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)) })}
                  aria-label="Address"
                />
                <Button variant="ghost" onClick={() => set({ allowlist: draft.allowlist.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="ghost" className="px-0 text-indigo-300" onClick={() => set({ allowlist: [...draft.allowlist, { chain: 'ethereum', address: '' }] })}>
              + Add address
            </Button>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Time delay</h3>
        <p className="mb-2 text-xs text-zinc-500">Sends at or above a threshold wait before Ika can sign them.</p>
        <div className="space-y-2">
          {draft.delayThresholds.map((t, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1.3fr_0.8fr_1fr_auto]">
              <ChainAsset
                chain={t.chain}
                asset={t.asset}
                onChange={(chain, asset) => set({ delayThresholds: draft.delayThresholds.map((x, j) => (j === i ? { ...x, chain, asset } : x)) })}
              />
              <Input
                value={t.amount}
                inputMode="decimal"
                placeholder={`≥ ${t.asset}`}
                onChange={(e) => set({ delayThresholds: draft.delayThresholds.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })}
                aria-label="Threshold"
              />
              <Button variant="ghost" onClick={() => set({ delayThresholds: draft.delayThresholds.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            className="px-0 text-indigo-300"
            onClick={() => set({ delayThresholds: [...draft.delayThresholds, { chain: 'ethereum', asset: 'ETH', amount: '0.01' }], delayS: draft.delayS === '0' ? '300' : draft.delayS })}
          >
            + Add threshold
          </Button>
        </div>
        <Field label="Delay (seconds)" hint={secHint(draft.delayS)} className="mt-2 max-w-xs">
          <Input value={draft.delayS} onChange={(e) => set({ delayS: e.target.value })} inputMode="numeric" />
        </Field>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Swaps</h3>
        <Toggle checked={draft.swapsEnabled} onChange={(swapsEnabled) => set({ swapsEnabled })} label="Allow swaps" />
        {draft.swapsEnabled && (
          <div className="mt-2">
            <LimitRows rows={draft.swapLimits} onChange={(swapLimits) => set({ swapLimits })} label="swap limit" />
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Max BTC fee (sats)">
          <Input value={draft.maxBtcFeeSats} onChange={(e) => set({ maxBtcFeeSats: e.target.value })} inputMode="numeric" />
        </Field>
        <Field label="Max EVM fee, direct mode (ETH)">
          <Input value={draft.maxEvmFeeEth} onChange={(e) => set({ maxEvmFeeEth: e.target.value })} inputMode="decimal" />
        </Field>
        <Field label="Policy change delay (seconds)" hint={secHint(draft.policyChangeDelayS)}>
          <Input value={draft.policyChangeDelayS} onChange={(e) => set({ policyChangeDelayS: e.target.value })} inputMode="numeric" />
        </Field>
      </div>
    </div>
  );
}

export function PolicySummary({ policy }: { policy: Policy }) {
  const Row = ({ k, children }: { k: string; children: ReactNode }) => (
    <div className="flex flex-col gap-1 border-t border-zinc-800/70 py-2 first:border-t-0 sm:flex-row sm:gap-3">
      <div className="w-40 shrink-0 text-xs text-zinc-500">{k}</div>
      <div className="min-w-0 text-sm text-zinc-200">{children}</div>
    </div>
  );
  const limits = (ls: Policy['limits']) =>
    ls.length ? (
      <ul className="space-y-0.5">
        {ls.map((l, i) => (
          <li key={i}>
            {fmt(l.maxPerWindow, l.asset)} {l.asset} on {CHAIN_LABEL[l.chain]} per {duration(l.windowS)}
          </li>
        ))}
      </ul>
    ) : (
      <span className="text-zinc-500">None</span>
    );
  return (
    <div>
      <Row k="Spending limits">{limits(policy.limits)}</Row>
      <Row k="Allowlist">
        {policy.allowlistEnabled ? (
          policy.allowlist.length ? (
            <ul className="space-y-0.5">
              {policy.allowlist.map((a, i) => (
                <li key={i} className="font-mono text-xs">
                  <Badge>{a.chain}</Badge> {short(a.address, 10)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-amber-300">Enabled, empty: all sends blocked</span>
          )
        ) : (
          <span className="text-zinc-500">Off (any recipient)</span>
        )}
      </Row>
      <Row k="Delay">
        {policy.delayThresholds.length ? (
          <ul className="space-y-0.5">
            {policy.delayThresholds.map((t, i) => (
              <li key={i}>
                ≥ {fmt(t.amount, t.asset)} {t.asset} on {CHAIN_LABEL[t.chain]}: wait {duration(policy.delayS)}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-zinc-500">None</span>
        )}
      </Row>
      <Row k="Swaps">
        {!policy.swapsEnabled ? <span className="text-amber-300">Disabled</span> : policy.swapLimits.length ? limits(policy.swapLimits) : <span className="text-zinc-400">Enabled, no swap limit</span>}
      </Row>
      <Row k="Fee caps">
        {policy.maxBtcFeeSats.toString()} sats (BTC) · {fmt(policy.maxEvmFeeWei, 'ETH', 6)} ETH (EVM direct)
      </Row>
      <Row k="Policy change delay">{duration(policy.policyChangeDelayS)}</Row>
    </div>
  );
}
