import { FREE_BETA_SEAT_LIMIT } from '../plan.ts';
import type { BillingAdapter } from './types.ts';

/**
 * Static Beta plan (used where no workspace document is available). The
 * Firebase adapter reads the server-written limit instead; see
 * createServerPlan in adapters/firebase.ts. No payment provider is involved and
 * checkout/return query parameters are ignored.
 */
export const betaPlan: BillingAdapter = {
  provider: 'beta',
  subscribeStatus(_organizationId, listener) {
    listener({ status: 'ready', data: { kind: 'beta', seatLimit: FREE_BETA_SEAT_LIMIT, source: 'default' } });
    return () => undefined;
  },
};
