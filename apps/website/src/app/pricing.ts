// NOT DISPLAYED during the free beta (user decision 2026-09-24): paid plans show
// "Coming soon" without prices. Kept as the agreed future pricing.
//
// Single paid plan (Pro, plan kind 'pro'): EUR €19/month including one (owner) seat, plus EUR €5/month
// per additional seat. All amounts are integer euro cents. These figures are a plan
// estimate for display only; the future billing backend owns the trusted price.
export const BASE_PLAN_CENTS = 1900;
export const ADDITIONAL_SEAT_CENTS = 500;
export const INCLUDED_SEATS = 1;

export interface SeatEstimate {
  totalSeats: number;
  includedSeats: number;
  additionalSeats: number;
  baseCents: number;
  additionalCents: number;
  totalCents: number;
}

export function isValidSeatQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** 1900 + 500 × (totalSeats − 1), for a positive integer seat count. */
export function estimateMonthly(totalSeats: number): SeatEstimate {
  if (!isValidSeatQuantity(totalSeats)) throw new RangeError('Seat quantity must be a positive whole number.');
  const additionalSeats = totalSeats - INCLUDED_SEATS;
  const additionalCents = ADDITIONAL_SEAT_CENTS * additionalSeats;
  const totalCents = BASE_PLAN_CENTS + additionalCents;
  if (!Number.isSafeInteger(totalCents)) throw new RangeError('Seat quantity is too large.');
  return { totalSeats, includedSeats: INCLUDED_SEATS, additionalSeats, baseCents: BASE_PLAN_CENTS, additionalCents, totalCents };
}

export type SeatInput = { ok: true; value: number } | { ok: false; message: string };

/** Parses user-typed seat quantities without coercing decimals, exponents or blanks. */
export function parseSeatQuantity(raw: string): SeatInput {
  const text = raw.trim();
  if (!text) return { ok: false, message: 'Enter the number of seats.' };
  if (!/^\d+$/.test(text)) return { ok: false, message: 'Seats must be a whole number.' };
  const value = Number(text);
  if (!isValidSeatQuantity(value)) return { ok: false, message: value < 1 ? 'At least one seat is required.' : 'Enter a smaller number of seats.' };
  if (!Number.isSafeInteger(BASE_PLAN_CENTS + ADDITIONAL_SEAT_CENTS * (value - 1))) return { ok: false, message: 'Enter a smaller number of seats.' };
  return { ok: true, value };
}

export const PLAN_CURRENCY = 'EUR';

export function formatPrice(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('Amount must be integer cents.');
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: PLAN_CURRENCY, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}
