import { IkaPortalError } from '@ika-portal/core';

export interface ErrorInfo {
  code: string;
  message: string;
  logs?: string[];
}

/** Normalize anything thrown by the SDK / wallet into a code + message for display. */
export function errorInfo(e: unknown): ErrorInfo {
  if (e instanceof IkaPortalError) return { code: e.code, message: e.message, logs: e.logs };
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; name?: string; message?: string };
    const code = typeof o.code === 'string' ? o.code : o.name && o.name !== 'Error' ? o.name : 'Error';
    return { code, message: o.message ?? String(e) };
  }
  return { code: 'Error', message: String(e) };
}
