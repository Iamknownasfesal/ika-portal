import { useState } from 'react';
import type { AssetSymbol, Chain, SwapHandle } from '@ika-portal/core';
import type { Quote, QuoteAllResult, SwapStatus } from '@ika-portal/swap';
import { PROVIDER_LABEL, useApp } from '../lib/app';
import { config } from '../config';
import { ASSETS_ON, CHAIN_LABEL, CHAINS, duration, fmt, parseAmount } from '../lib/format';
import { IntentProgress } from '../components/progress';
import { Badge, Button, Card, cx, ErrorBox, Field, Input, Notice, Select } from '../components/ui';

function ChainAssetPicker({ chain, asset, onChange }: { chain: Chain; asset: AssetSymbol; onChange(c: Chain, a: AssetSymbol): void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
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
    </div>
  );
}

const feeText = (q: Quote) => {
  const out: string[] = [];
  const side = (s: 'input' | 'output') => (s === 'input' ? q.request.from.asset : q.request.to.asset);
  if (q.fees.integrator) out.push(`integrator ${q.fees.integrator.bps} bps (${fmt(q.fees.integrator.amount, side(q.fees.integrator.side), 6)} ${side(q.fees.integrator.side)})`);
  if (q.fees.ika) out.push(`Ika ${q.fees.ika.bps} bps (${fmt(q.fees.ika.amount, side(q.fees.ika.side), 6)} ${side(q.fees.ika.side)})`);
  for (const p of q.fees.provider) out.push(`${p.name} ${fmt(p.amount, side(p.side), 6)} ${side(p.side)}`);
  return out.length ? out : ['none'];
};

export function SwapScreen() {
  const app = useApp();
  const acct = app.account!;
  const [from, setFrom] = useState<{ chain: Chain; asset: AssetSymbol }>({ chain: 'bitcoin', asset: 'BTC' });
  const [to, setTo] = useState<{ chain: Chain; asset: AssetSymbol }>({ chain: 'base', asset: 'USDC' });
  const [amountStr, setAmount] = useState('');
  const [quotes, setQuotes] = useState<QuoteAllResult | null>(null);
  const [selected, setSelected] = useState<number>(-1);
  const [busy, setBusy] = useState<'quote' | 'swap' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [swap, setSwap] = useState<SwapHandle | null>(null);
  const [status, setStatus] = useState<SwapStatus | null>(null);
  const [statusErr, setStatusErr] = useState<unknown>(null);

  const amount = parseAmount(amountStr, from.asset);
  const same = from.chain === to.chain && from.asset === to.asset;

  async function getQuotes() {
    if (!amount) return;
    setBusy('quote');
    setError(null);
    setQuotes(null);
    try {
      const r = await acct.quoteSwap({ from: { ...from, amount }, to });
      setQuotes(r);
      setSelected(r.best ? r.quotes.indexOf(r.best) : -1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function execute() {
    const q = quotes?.quotes[selected];
    if (!q) return;
    setBusy('swap');
    setError(null);
    setStatus(null);
    setStatusErr(null);
    try {
      const s = await acct.swap(q);
      setSwap(s);
      s.wait().then(setStatus, setStatusErr);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const sel = quotes?.quotes[selected];
  return (
    <div className="space-y-4">
      <Card title="Swap" subtitle="The account sends a plain transfer to the provider's deposit address as a policy-checked swap intent; the provider delivers to the account's own address.">
        {app.vaultMode && (
          <div className="mb-3">
            <Notice tone="warn">Swaps from a Squads-owned account aren't wired up in this demo (the SDK has no instructions builder for swaps yet). Use Send instead.</Notice>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-end">
          <div className="space-y-2">
            <Field label="From">
              <ChainAssetPicker chain={from.chain} asset={from.asset} onChange={(chain, asset) => (setFrom({ chain, asset }), setQuotes(null))} />
            </Field>
            <Field label={`Amount (${from.asset})`}>
              <Input value={amountStr} onChange={(e) => (setAmount(e.target.value), setQuotes(null))} inputMode="decimal" placeholder="0.0" />
            </Field>
          </div>
          <button
            type="button"
            className="mx-auto mb-1 rounded-full border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800"
            onClick={() => (setFrom(to), setTo(from), setQuotes(null))}
            aria-label="Swap direction"
          >
            ⇄
          </button>
          <Field label="To" className="self-start">
            <ChainAssetPicker chain={to.chain} asset={to.asset} onChange={(chain, asset) => (setTo({ chain, asset }), setQuotes(null))} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" busy={busy === 'quote'} disabled={!amount || same} onClick={getQuotes}>
            Get quotes
          </Button>
          {same && <span className="text-xs text-amber-300">Pick a different destination.</span>}
          <span className="text-xs text-zinc-500">
            Providers: demo provider{config.nearProxyUrl ? ', NEAR Intents (mainnet dry quotes only; not executable on testnets)' : ''}. Integrator fee {config.integratorFeeBps} bps.
          </span>
        </div>
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      </Card>

      {quotes && (
        <Card title="Quotes" subtitle="Sorted best first. The best executable quote is preselected.">
          {quotes.quotes.length === 0 ? (
            <p className="text-sm text-zinc-400">No provider returned a quote for this route.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr>
                    <th className="py-2 pr-2 font-normal"></th>
                    <th className="py-2 pr-3 font-normal">Provider</th>
                    <th className="py-2 pr-3 font-normal">You receive</th>
                    <th className="py-2 pr-3 font-normal">Minimum</th>
                    <th className="py-2 pr-3 font-normal">Fees</th>
                    <th className="py-2 font-normal">Executable</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.quotes.map((q, i) => (
                    <tr
                      key={`${q.providerId}-${i}`}
                      className={cx('cursor-pointer border-t border-zinc-800 align-top', selected === i && 'bg-indigo-500/5')}
                      onClick={() => q.executable && setSelected(i)}
                    >
                      <td className="py-2 pr-2">
                        <input type="radio" checked={selected === i} disabled={!q.executable} onChange={() => setSelected(i)} className="accent-indigo-500" aria-label={`Select ${q.providerId}`} />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="font-medium text-zinc-100">{q.providerId}</div>
                        <div className="text-xs text-zinc-500">{PROVIDER_LABEL[q.providerId] ?? ''}</div>
                        {quotes.best === q && <Badge tone="good">Best</Badge>}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {fmt(q.amountOut, to.asset, 6)} {q.request.to.asset}
                        {q.estimatedTimeSec !== undefined && <div className="text-xs text-zinc-500">~{duration(q.estimatedTimeSec)}</div>}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-zinc-300">
                        {fmt(q.minAmountOut, to.asset, 6)} {q.request.to.asset}
                      </td>
                      <td className="py-2 pr-3 text-xs text-zinc-400">
                        {feeText(q).map((f) => (
                          <div key={f}>{f}</div>
                        ))}
                      </td>
                      <td className="py-2">
                        {q.executable ? <Badge tone="good">yes</Badge> : <Badge tone="warn">no</Badge>}
                        {q.nonExecutableReason && <div className="mt-1 max-w-[16rem] text-xs text-zinc-500">{q.nonExecutableReason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(quotes.errors.length > 0 || quotes.skipped.length > 0) && (
            <div className="mt-3 space-y-1 text-xs text-zinc-500">
              {quotes.errors.map((e) => (
                <div key={e.providerId}>
                  <Badge tone="bad">{e.providerId}</Badge> {e.error instanceof Error ? e.error.message : String(e.error)}
                </div>
              ))}
              {quotes.skipped.map((s) => (
                <div key={s.providerId}>
                  <Badge>{s.providerId}</Badge> skipped: {s.reason}
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" busy={busy === 'swap'} disabled={!sel?.executable || app.vaultMode} onClick={execute}>
              Swap with {sel?.providerId ?? '…'}
            </Button>
            {sel && sel.providerId === 'mock' && (
              <span className="text-xs text-zinc-500">
                Demo provider: the deposit goes to {config.mockDepositBtc || config.mockDepositEvm ? 'the configured demo deposit address' : "the account's own address"}; the payout is simulated (logged, fake hash).
              </span>
            )}
          </div>
        </Card>
      )}

      {swap && (
        <div className="space-y-3">
          <IntentProgress handle={swap.intent} title={`Deposit ${fmt(swap.prepared.amount, from.asset)} ${from.asset} to ${swap.prepared.depositAddress}`} />
          <Card title="Provider status">
            {status ? (
              <div className="space-y-1 text-sm">
                <div>
                  <Badge tone={status.status === 'success' ? 'good' : status.status === 'pending' ? 'info' : 'bad'}>{status.status}</Badge>{' '}
                  <span className="text-zinc-400">{status.providerStatus}</span>
                </div>
                {status.destinationTxHash && <div className="font-mono text-xs text-zinc-300">destination: {status.destinationTxHash}</div>}
                {status.amountOut !== undefined && (
                  <div className="text-zinc-300">
                    Delivered: {fmt(status.amountOut, swap.prepared.quote.request.to.asset, 6)} {swap.prepared.quote.request.to.asset}
                  </div>
                )}
                {status.reason && <div className="text-red-300">{status.reason}</div>}
              </div>
            ) : statusErr ? (
              <ErrorBox error={statusErr} />
            ) : (
              <p className="text-sm text-zinc-400">Waiting for the deposit to confirm, then for the provider.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
