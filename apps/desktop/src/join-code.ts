// Company-code contract shared with the portal (apps/website/src/app/validation.ts)
// and joinCodeRedeem (firebase/functions/src/membership.ts): eight letters
// without I/O, shown as ABCD-EFGH, entered in any case with spaces or hyphens.
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const JOIN_CODE_LENGTH = 8;

export function normalizeJoinCode(raw: string): string | null {
  const value = raw.replace(/[\s-]/g, '').toUpperCase();
  if (value.length !== JOIN_CODE_LENGTH) return null;
  return [...value].every((char) => JOIN_CODE_ALPHABET.includes(char)) ? value : null;
}

export function formatJoinCode(code: string) { return `${code.slice(0, 4)}-${code.slice(4)}`; }

export type JoinFailure = { kind: 'invalid-format' | 'invalid-code' | 'seats-full' | 'rate-limited' | 'signed-out' | 'offline' | 'unknown'; message: string };

/** Plain copy for a failed joinCodeRedeem; never echoes the typed code or raw server text other than the retry time. */
export function joinFailure(error: unknown): JoinFailure {
  const value = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown; details?: { reason?: unknown; retryAfterSeconds?: unknown } };
  const code = String(value.code ?? '').replace(/^functions\//, '');
  const reason = value.details?.reason;
  if (reason === 'seats-full') return { kind: 'seats-full', message: 'This workspace has no free seats. Ask the workspace owner to add or free a seat, then try again.' };
  if (reason === 'invalid-code' || code === 'not-found') return { kind: 'invalid-code', message: 'This company code is not valid. Check the code with your workspace owner; it may have been changed or turned off.' };
  if (reason === 'rate-limited' || code === 'resource-exhausted') {
    const seconds = Number(value.details?.retryAfterSeconds);
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : undefined;
    return { kind: 'rate-limited', message: `Too many company code attempts. Try again${minutes ? ` in ${minutes} minute${minutes === 1 ? '' : 's'}` : ' later'}.` };
  }
  if (code === 'unauthenticated') return { kind: 'signed-out', message: 'Your session ended. Sign in again, then enter the code.' };
  if (['unavailable', 'internal', 'deadline-exceeded', 'network-request-failed'].includes(code) || /network|offline|fetch/i.test(String(value.message ?? ''))) return { kind: 'offline', message: 'SaySpec could not reach the workspace service. Check your connection and try again.' };
  if (code === 'invalid-argument') return { kind: 'invalid-format', message: 'Enter the 8-letter company code, for example ABCD-EFGH.' };
  return { kind: 'unknown', message: 'Joining the workspace failed. Try again.' };
}
