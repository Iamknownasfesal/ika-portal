import type { TransactionInstruction } from '@solana/web3.js';
import type { ReactNode } from 'react';
import { ixToJson } from '../lib/instructions';
import { short } from '../lib/format';
import { Badge, CopyButton, Mono } from './ui';

/**
 * Shows instructions to paste into a Squads vault transaction instead of
 * signing them with the connected wallet. `transactions` is a list of
 * transactions; each must execute atomically and in order.
 */
export function VaultInstructions({ transactions, title, footer }: { transactions: TransactionInstruction[][]; title?: ReactNode; footer?: ReactNode }) {
  const json = JSON.stringify(
    transactions.map((ixs) => ixs.map(ixToJson)),
    null,
    2,
  );
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-amber-100">{title ?? 'Execute from your Squads vault'}</div>
          <p className="mt-0.5 text-xs text-amber-100/70">
            Create {transactions.length === 1 ? 'a vault transaction' : `${transactions.length} vault transactions, in this order,`} in Squads with these instructions. The vault is the owner and signer;
            nothing here is signed by your wallet.
          </p>
        </div>
        <CopyButton value={json} label="Copy JSON" />
      </div>
      <div className="space-y-3">
        {transactions.map((ixs, t) => (
          <div key={t} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
            {transactions.length > 1 && <div className="mb-2 text-xs font-medium text-zinc-400">Vault transaction {t + 1} of {transactions.length}</div>}
            <div className="space-y-3">
              {ixs.map((ix, i) => {
                const j = ixToJson(ix);
                return (
                  <div key={i} className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge tone="info">Instruction {i + 1}</Badge>
                      <span className="text-zinc-500">program</span>
                      <Mono>{j.programId}</Mono>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-zinc-500">
                          <tr>
                            <th className="py-1 pr-2 font-normal">#</th>
                            <th className="py-1 pr-2 font-normal">Account</th>
                            <th className="py-1 pr-2 font-normal">Signer</th>
                            <th className="py-1 font-normal">Writable</th>
                          </tr>
                        </thead>
                        <tbody>
                          {j.keys.map((k, n) => (
                            <tr key={n} className="border-t border-zinc-800/80">
                              <td className="py-1 pr-2 text-zinc-500">{n}</td>
                              <td className="py-1 pr-2 font-mono text-zinc-200">
                                <span className="hidden md:inline">{k.pubkey}</span>
                                <span className="md:hidden">{short(k.pubkey)}</span>
                              </td>
                              <td className="py-1 pr-2">{k.isSigner ? <Badge tone="warn">signer</Badge> : <span className="text-zinc-600">–</span>}</td>
                              <td className="py-1">{k.isWritable ? <Badge>writable</Badge> : <span className="text-zinc-600">–</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] text-zinc-500">data (base64)</div>
                        <Mono className="block max-h-24 overflow-auto">{j.data}</Mono>
                      </div>
                      <CopyButton value={j.data} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  );
}
