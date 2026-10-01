/**
 * Node globals the SDK (and some of its deps) expect: Buffer, process, global.
 * Loaded as its own <script type="module"> BEFORE main.tsx (see index.html),
 * because SDK modules use Buffer at module top level (e.g. PDA seeds).
 */
import { Buffer } from 'buffer';
import process from 'process';

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: unknown; global?: unknown };
g.Buffer ??= Buffer;
g.process ??= process;
g.global ??= globalThis;
