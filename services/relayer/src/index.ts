/**
 * EVM gas relayer for Ika Portal (delegated mode).
 *
 * Submits dWallet-signed `IkaAccount` calls and the one-time EIP-7702 setup,
 * paying gas from a funded key so dWallet EOAs never need ETH. Every request
 * is simulated first; it only ever sends to accounts delegated to (or being
 * delegated to) the configured `IkaAccount` implementation. No auth in the
 * MVP; per-account rate limiting only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evm } from '@ika-portal/chains';

export interface RelayerChain {
  rpc: string;
  /** The only delegate the relayer will set up or call through. */
  implementation: Address;
}

export interface RelayerOptions {
  privateKey: Hex;
  chains: Record<number, RelayerChain>;
  /** Requests per account per minute (default 20). */
  rateLimitPerMinute?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createRelayer(opts: RelayerOptions) {
  const signer = privateKeyToAccount(opts.privateKey);
  const clients = new Map<number, { pub: PublicClient; wallet: WalletClient; cfg: RelayerChain; chain: ViemChain }>();
  for (const [id, cfg] of Object.entries(opts.chains)) {
    const chainId = Number(id);
    const chain: ViemChain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } };
    clients.set(chainId, {
      cfg,
      chain,
      pub: createPublicClient({ chain, transport: http(cfg.rpc) }) as PublicClient,
      wallet: createWalletClient({ account: signer, chain, transport: http(cfg.rpc) }),
    });
  }

  const hits = new Map<string, number[]>();
  const limit = opts.rateLimitPerMinute ?? 20;
  function rateLimit(account: string) {
    const now = Date.now();
    const recent = (hits.get(account) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) throw new HttpError(429, 'rate limit exceeded for this account');
    recent.push(now);
    hits.set(account, recent);
  }

  function chainFor(chainId: number) {
    const c = clients.get(Number(chainId));
    if (!c) throw new HttpError(400, `unsupported chainId ${chainId}`);
    return c;
  }

  async function requireDelegated(c: ReturnType<typeof chainFor>, account: Address) {
    const target = evm.delegationTarget(await c.pub.getCode({ address: account }));
    if (!target || getAddress(target) !== getAddress(c.cfg.implementation)) {
      throw new HttpError(400, `account ${account} is not delegated to IkaAccount ${c.cfg.implementation}`);
    }
  }

  async function sendCall(c: ReturnType<typeof chainFor>, account: Address, data: Hex) {
    // Simulate first; a revert here costs the relayer nothing.
    await c.pub.call({ account: signer, to: account, data }).catch((e: Error) => {
      throw new HttpError(422, `simulation reverted: ${e.message.split('\n')[0]}`);
    });
    const hash = await c.wallet.sendTransaction({ account: signer, chain: c.chain, to: account, data });
    return { hash };
  }

  const routes: Record<string, (body: Record<string, unknown>) => Promise<{ hash: Hex }>> = {
    async '/setup'(b) {
      const c = chainFor(Number(b.chainId));
      const account = getAddress(b.account as string);
      rateLimit(account);
      const auth = b.authorization as { address: Address; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
      if (getAddress(auth.address) !== getAddress(c.cfg.implementation)) throw new HttpError(400, 'authorization targets an unknown implementation');
      if (Number(auth.chainId) !== Number(b.chainId)) throw new HttpError(400, 'authorization chainId mismatch');
      const init = b.initArgs as { recoveryKey: Address; recoveryDelay: string; sig: Hex };
      const data = encodeFunctionData({
        abi: evm.ikaAccountAbi,
        functionName: 'initialize',
        args: [getAddress(init.recoveryKey), BigInt(init.recoveryDelay), init.sig],
      });
      const authorizationList = [{ address: getAddress(auth.address), chainId: Number(auth.chainId), nonce: Number(auth.nonce), r: auth.r, s: auth.s, yParity: Number(auth.yParity) }];
      await c.pub.estimateGas({ account: signer, to: account, data, authorizationList }).catch((e: Error) => {
        throw new HttpError(422, `setup simulation reverted: ${e.message.split('\n')[0]}`);
      });
      const hash = await c.wallet.sendTransaction({ account: signer, chain: c.chain, to: account, data, authorizationList });
      return { hash };
    },
    async '/execute'(b) {
      const c = chainFor(Number(b.chainId));
      const account = getAddress(b.account as string);
      rateLimit(account);
      await requireDelegated(c, account);
      const data = encodeFunctionData({
        abi: evm.ikaAccountAbi,
        functionName: 'execute',
        args: [getAddress(b.to as string), BigInt(b.value as string), b.data as Hex, BigInt(b.deadline as string), b.sig as Hex],
      });
      return sendCall(c, account, data);
    },
    async '/cancel-recovery'(b) {
      const c = chainFor(Number(b.chainId));
      const account = getAddress(b.account as string);
      rateLimit(account);
      await requireDelegated(c, account);
      const data = encodeFunctionData({ abi: evm.ikaAccountAbi, functionName: 'cancelRecovery', args: [BigInt(b.deadline as string), b.sig as Hex] });
      return sendCall(c, account, data);
    },
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return reply(204, {});
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, relayer: signer.address, chains: [...clients.keys()] });
    const route = req.method === 'POST' ? routes[req.url ?? ''] : undefined;
    if (!route) return reply(404, { error: 'not found' });
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      reply(200, await route(JSON.parse(raw || '{}')));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      reply(status, { error: (e as Error).message });
    }
  }

  return {
    address: signer.address,
    handle,
    listen(port: number, host = '127.0.0.1') {
      const server = createServer((req, res) => void handle(req, res));
      return new Promise<{ url: string; close: () => Promise<void> }>((resolve) =>
        server.listen(port, host, () => {
          const addr = server.address();
          const p = typeof addr === 'object' && addr ? addr.port : port;
          resolve({ url: `http://${host}:${p}`, close: () => new Promise((r) => server.close(() => r())) });
        }),
      );
    },
  };
}
