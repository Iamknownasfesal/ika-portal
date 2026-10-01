/**
 * Minimal gRPC transport for `ika.dwallet.v1.DWalletService/SubmitTransaction`.
 * The request/response messages are two/one `bytes` fields, so we frame them
 * directly; all payloads are BCS types from `@ika.xyz/pre-alpha-solana-client`.
 * (The npm client's own `createIkaClient` hardcodes Curve25519, so it can't
 * be used for secp256k1 dWallets.)
 */
import { Buffer } from 'buffer';
import type * as GrpcNs from '@grpc/grpc-js';

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function bytesField(field: number, b: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2, ...varint(b.length)]), Buffer.from(b)]);
}

function readBytesField(buf: Buffer, want: number): Uint8Array {
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++]!;
    const field = key >> 3;
    const wire = key & 7;
    if (wire !== 2) throw new Error(`unexpected protobuf wire type ${wire}`);
    let len = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i++]!;
      len |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const val = buf.subarray(i, i + len);
    i += len;
    if (field === want) return new Uint8Array(val);
  }
  return new Uint8Array();
}

export interface IkaGrpc {
  submit(userSignature: Uint8Array, signedRequestData: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

// Kept out of browser bundles: only the Node transport loads it.
const GRPC_JS = '@grpc/grpc-js';
const METHOD = '/ika.dwallet.v1.DWalletService/SubmitTransaction';

/** Node transport (HTTP/2 gRPC). `@grpc/grpc-js` is loaded lazily so browsers never bundle it. */
export function createIkaGrpc(url: string): IkaGrpc {
  let inner: Promise<IkaGrpc> | null = null;
  const load = () => (inner ??= import(/* @vite-ignore */ /* webpackIgnore: true */ GRPC_JS).then((grpc: typeof GrpcNs) => createNodeGrpc(grpc, url)));
  return {
    submit: async (sig, data) => (await load()).submit(sig, data),
    close: () => void inner?.then((c) => c.close()),
  };
}

/**
 * Browser transport (gRPC-web over fetch). The Ika pre-alpha endpoint serves
 * `application/grpc-web+proto` with permissive CORS.
 */
export function createIkaGrpcWeb(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): IkaGrpc {
  const base = (/^https?:\/\//.test(url) ? url : `https://${url.replace(/:443$/, '')}`).replace(/\/$/, '');
  return {
    async submit(sig, data) {
      const msg = Buffer.concat([bytesField(1, sig), bytesField(2, data)]);
      const frame = Buffer.alloc(5 + msg.length);
      frame.writeUInt32BE(msg.length, 1);
      msg.copy(frame, 5);
      const res = await fetchImpl(`${base}${METHOD}`, {
        method: 'POST',
        headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', accept: 'application/grpc-web+proto' },
        body: frame,
      });
      if (!res.ok) throw new Error(`gRPC-web HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      let payload: Buffer | null = null;
      let trailers = '';
      for (let i = 0; i + 5 <= body.length; ) {
        const flag = body[i]!;
        const len = body.readUInt32BE(i + 1);
        const chunk = body.subarray(i + 5, i + 5 + len);
        if (flag & 0x80) trailers += chunk.toString('utf8');
        else payload = chunk;
        i += 5 + len;
      }
      const status = /grpc-status:\s*(\d+)/i.exec(trailers + (res.headers.get('grpc-status') ? `grpc-status:${res.headers.get('grpc-status')}` : ''));
      if (status && status[1] !== '0') {
        const m = /grpc-message:\s*(.*)/i.exec(trailers)?.[1] ?? res.headers.get('grpc-message') ?? '';
        throw new Error(`gRPC status ${status[1]}: ${decodeURIComponent(m.trim())}`);
      }
      if (!payload) throw new Error('empty gRPC-web response');
      return readBytesField(payload, 1);
    },
    close() {},
  };
}

function createNodeGrpc(grpc: typeof GrpcNs, url: string): IkaGrpc {
  const target = url.replace(/^https?:\/\//, '');
  const insecure = /^(localhost|127\.0\.0\.1)/.test(target);
  const Client = grpc.makeGenericClientConstructor(
    {
      SubmitTransaction: {
        path: METHOD,
        requestStream: false,
        responseStream: false,
        requestSerialize: (r: { sig: Uint8Array; data: Uint8Array }) => Buffer.concat([bytesField(1, r.sig), bytesField(2, r.data)]),
        requestDeserialize: (b: Buffer) => ({ sig: readBytesField(b, 1), data: readBytesField(b, 2) }),
        responseSerialize: (r: Uint8Array) => bytesField(1, r),
        responseDeserialize: (b: Buffer) => readBytesField(b, 1),
      },
    },
    'DWalletService',
  );
  const client = new Client(target, insecure ? grpc.credentials.createInsecure() : grpc.credentials.createSsl(), {
    'grpc.max_receive_message_length': 64 * 1024 * 1024,
  });
  return {
    submit(sig, data) {
      return new Promise((resolve, reject) => {
        const deadline = new Date(Date.now() + 120_000);
        (client as unknown as { SubmitTransaction: (req: unknown, meta: GrpcNs.Metadata, opts: GrpcNs.CallOptions, cb: GrpcNs.requestCallback<Uint8Array>) => void }).SubmitTransaction(
          { sig, data },
          new grpc.Metadata(),
          { deadline },
          (err: GrpcNs.ServiceError | null, resp?: Uint8Array) => (err ? reject(err) : resolve(resp!)),
        );
      });
    },
    close: () => client.close(),
  };
}
