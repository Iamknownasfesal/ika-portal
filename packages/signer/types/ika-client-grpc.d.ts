// Type-only shim: the published `@ika.xyz/pre-alpha-solana-client/grpc` and `/grpc-web` entries
// (raw TS) has an upstream type error in `createIkaClient` (DKGResult is missing
// `dwalletAddr`). We only use `defineBcsTypes`, so type-check against the clean
// `bcs-types.ts` module. Runtime still imports the real package entry.
export { defineBcsTypes } from '../node_modules/@ika.xyz/pre-alpha-solana-client/src/bcs-types.js';
