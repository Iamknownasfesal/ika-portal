import type { Address, Hex } from 'viem';

export interface SignedAuthorization {
  address: Address; // implementation
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

export interface SetupRequest {
  chainId: number;
  account: Address;
  authorization: SignedAuthorization;
  initArgs: { recoveryKey: Address; recoveryDelay: bigint; sig: Hex };
}

export interface ExecuteRequest {
  chainId: number;
  account: Address;
  to: Address;
  value: bigint;
  data: Hex;
  deadline: bigint;
  sig: Hex;
}

export interface CancelRecoveryRequest {
  chainId: number;
  account: Address;
  deadline: bigint;
  sig: Hex;
}

const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Client for services/relayer. The relayer pays gas; dWallet EOAs never hold ETH. */
export class RelayerClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: unknown): Promise<{ hash: Hex }> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: toJson(body),
    });
    const json = (await res.json().catch(() => ({}))) as { hash?: Hex; error?: string };
    if (!res.ok || !json.hash) throw new Error(`relayer ${path} failed (${res.status}): ${json.error ?? 'unknown error'}`);
    return { hash: json.hash };
  }

  setup(req: SetupRequest) {
    return this.post('/setup', req);
  }

  execute(req: ExecuteRequest) {
    return this.post('/execute', req);
  }

  cancelRecovery(req: CancelRecoveryRequest) {
    return this.post('/cancel-recovery', req);
  }
}
