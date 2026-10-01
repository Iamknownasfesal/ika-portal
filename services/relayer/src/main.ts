/**
 * RELAYER_PRIVATE_KEY=0x… RELAYER_CHAINS='{"11155111":{"rpc":"…","implementation":"0x…"}}' PORT=8787 pnpm start
 */
import { createRelayer } from './index.js';

const pk = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
const chains = process.env.RELAYER_CHAINS;
if (!pk || !chains) {
  console.error('set RELAYER_PRIVATE_KEY and RELAYER_CHAINS');
  process.exit(1);
}
const relayer = createRelayer({ privateKey: pk, chains: JSON.parse(chains) });
const { url } = await relayer.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1');
console.log(`relayer ${relayer.address} listening on ${url}`);
