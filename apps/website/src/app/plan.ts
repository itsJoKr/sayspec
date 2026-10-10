// Plan policy (D29): a workspace is on Free (the default for new workspaces),
// Beta (unpaid, with Pro features such as SaySpec Cloud test storage) or Pro
// (the paid plan; modeled but not offered yet, so only an operator sets it).
// The seat limit is 4 including the owner. Paid plans are "Coming soon" and show
// no prices. The backend writes the plan and enforces the limit; the portal only
// displays them.
export const FREE_BETA_SEAT_LIMIT = 4;

export type PlanKind = 'free' | 'beta' | 'pro';

/** Mirrors the server: 'free' and 'pro' are explicit; 'beta', the old 'free-beta' and workspaces that predate plans are Beta. */
export function planKind(kind: unknown): PlanKind { return kind === 'free' || kind === 'pro' ? kind : 'beta'; }

export const PLAN_NAMES: Record<PlanKind, string> = { free: 'Free plan', beta: 'Beta plan', pro: 'Pro plan' };

export type SeatUsage = { used: number; limit: number; remaining: number; full: boolean; over: boolean };

export function seatUsage(used: number, limit = FREE_BETA_SEAT_LIMIT): SeatUsage {
  if (!Number.isSafeInteger(used) || used < 0) throw new RangeError('Seat usage must be a non-negative whole number.');
  return { used, limit, remaining: Math.max(0, limit - used), full: used >= limit, over: used > limit };
}
