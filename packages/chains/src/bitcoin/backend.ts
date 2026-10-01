import { Buffer } from 'buffer';
import type { Utxo } from './sighash.js';

export interface BitcoinBackend {
  /** Unspent outputs for an address, with confirmations (0 = mempool). */
  utxos(address: string): Promise<Utxo[]>;
  /** Fee rate in sat/vB. */
  feeRate(): Promise<number>;
  broadcast(hex: string): Promise<string>;
  tx(txid: string): Promise<{ confirmations: number; hex?: string } | null>;
  tipHeight(): Promise<number>;
}

/** Bitcoin Core JSON-RPC (regtest locally). Uses `scantxoutset`, so no wallet import is needed. */
export class BitcoindRpcBackend implements BitcoinBackend {
  constructor(
    readonly url: string,
    private readonly auth: { username: string; password: string },
    private readonly opts: { fallbackFeeRate?: number; wallet?: string } = {},
  ) {}

  async rpc<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const url = wallet ? `${this.url.replace(/\/$/, '')}/wallet/${wallet}` : this.url;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
    });
    const json = (await res.json()) as { result: T; error: { message: string } | null };
    if (json.error) throw new Error(`bitcoind ${method}: ${json.error.message}`);
    return json.result;
  }

  async tipHeight() {
    return this.rpc<number>('getblockcount');
  }

  async utxos(address: string): Promise<Utxo[]> {
    const [tip, scan] = await Promise.all([
      this.tipHeight(),
      this.rpc<{ unspents: { txid: string; vout: number; amount: number; height: number }[] }>('scantxoutset', [
        'start',
        [`addr(${address})`],
      ]),
    ]);
    return scan.unspents.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(Math.round(u.amount * 1e8)),
      confirmations: u.height > 0 ? tip - u.height + 1 : 0,
    }));
  }

  async feeRate() {
    try {
      const r = await this.rpc<{ feerate?: number }>('estimatesmartfee', [2]);
      if (r.feerate) return Math.max(1, Math.ceil((r.feerate * 1e8) / 1000));
    } catch {
      /* regtest often has no estimate */
    }
    return this.opts.fallbackFeeRate ?? 2;
  }

  broadcast(hex: string) {
    return this.rpc<string>('sendrawtransaction', [hex]);
  }

  async tx(txid: string) {
    try {
      const t = await this.rpc<{ confirmations?: number; hex: string }>('getrawtransaction', [txid, true]);
      return { confirmations: t.confirmations ?? 0, hex: t.hex };
    } catch {
      return null;
    }
  }
}

/** Esplora REST (e.g. https://mempool.space/testnet4/api). */
export class EsploraBackend implements BitcoinBackend {
  constructor(readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`);
    if (!res.ok) throw new Error(`esplora GET ${path}: ${res.status} ${await res.text()}`);
    return res.headers.get('content-type')?.includes('json') ? ((await res.json()) as T) : ((await res.text()) as T);
  }

  async tipHeight() {
    return Number(await this.get<string>('/blocks/tip/height'));
  }

  async utxos(address: string): Promise<Utxo[]> {
    const [tip, list] = await Promise.all([
      this.tipHeight(),
      this.get<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }[]>(
        `/address/${address}/utxo`,
      ),
    ]);
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      confirmations: u.status.confirmed && u.status.block_height ? tip - u.status.block_height + 1 : 0,
    }));
  }

  async feeRate() {
    const est = await this.get<Record<string, number>>('/fee-estimates');
    return Math.max(1, Math.ceil(est['2'] ?? est['6'] ?? 1));
  }

  async broadcast(hex: string) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/tx`, { method: 'POST', body: hex });
    const text = await res.text();
    if (!res.ok) throw new Error(`esplora broadcast: ${text}`);
    return text.trim();
  }

  async tx(txid: string) {
    try {
      const [status, tip] = await Promise.all([
        this.get<{ confirmed: boolean; block_height?: number }>(`/tx/${txid}/status`),
        this.tipHeight(),
      ]);
      return { confirmations: status.confirmed && status.block_height ? tip - status.block_height + 1 : 0 };
    } catch {
      return null;
    }
  }
}
