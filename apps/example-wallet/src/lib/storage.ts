/**
 * Browser persistence for the demo. Only non-secret data is stored:
 * - the Ika session key (an Ed25519 key used to authenticate gRPC requests to
 *   the Ika network; it cannot move funds: every signature needs an on-chain
 *   approval from the account owner's policy program),
 * - per-account dWallet references (public keys, attestations, encrypted shares),
 * - a list of known accounts.
 * Mnemonics and recovery keys are NEVER stored.
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import type { DWalletRef } from '@ika-portal/signer';
import { config } from '../config';

const P = 'ika-demo:v1';
const safeGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const safeSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

// ── Ika session key ────────────────────────────────────────────────────
const SESSION = `${P}:session-key`;
let session: Keypair | null = null;

export function sessionKey(): Keypair {
  if (session) return session;
  const raw = safeGet(SESSION);
  if (raw) {
    try {
      session = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
      return session;
    } catch {
      /* regenerate */
    }
  }
  session = Keypair.generate();
  safeSet(SESSION, JSON.stringify(Array.from(session.secretKey)));
  return session;
}

export function exportSessionKey(): string {
  return JSON.stringify(Array.from(sessionKey().secretKey));
}

export function importSessionKey(json: string): Keypair {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json) as number[]));
  safeSet(SESSION, JSON.stringify(Array.from(kp.secretKey)));
  session = kp;
  return kp;
}

// ── dWallet refs ───────────────────────────────────────────────────────
const refKey = (owner: PublicKey | string, index: number) => `${P}:dwallets:${config.programId.toBase58()}:${owner.toString()}:${index}`;

export function loadRefs(owner: PublicKey | string, index: number): DWalletRef[] {
  const raw = safeGet(refKey(owner, index));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as DWalletRef[];
  } catch {
    return [];
  }
}

export function saveRefs(owner: PublicKey | string, index: number, refs: DWalletRef[]) {
  safeSet(refKey(owner, index), JSON.stringify(refs));
  rememberAccount({ owner: owner.toString(), index });
}

// ── Known accounts ─────────────────────────────────────────────────────
export interface KnownAccount {
  owner: string;
  index: number;
}
const KNOWN = `${P}:accounts:${config.programId.toBase58()}`;

export function knownAccounts(): KnownAccount[] {
  try {
    return JSON.parse(safeGet(KNOWN) ?? '[]') as KnownAccount[];
  } catch {
    return [];
  }
}

export function rememberAccount(a: KnownAccount) {
  const list = knownAccounts().filter((x) => !(x.owner === a.owner && x.index === a.index));
  safeSet(KNOWN, JSON.stringify([a, ...list].slice(0, 20)));
}

// ── UI prefs ───────────────────────────────────────────────────────────
export const prefs = {
  get<T>(k: string, d: T): T {
    try {
      const v = safeGet(`${P}:pref:${k}`);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    safeSet(`${P}:pref:${k}`, JSON.stringify(v));
  },
};
