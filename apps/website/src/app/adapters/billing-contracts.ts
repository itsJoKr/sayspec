// Future server operations for billing. The browser never chooses a Stripe
// customer, price or amount: the server derives the customer from the
// authorized workspace and the price from its own configuration. Entitlements
// are established by signed provider webhooks, never by redirect parameters.

/** Callable `billingCheckoutCreate` (proposed). Caller must be an active owner of organizationId. */
export interface CreateCheckoutSessionRequest {
  organizationId: string;
  /** Total seats including the owner's included seat. Positive integer; server re-validates. */
  seatQuantity: number;
  /** Client-generated UUID so retries reuse the same checkout session. */
  idempotencyKey: string;
}
export interface CreateCheckoutSessionResponse {
  /** Provider-hosted checkout URL; the portal validates its origin before navigating. */
  checkoutUrl: string;
  expiresAt: string;
}

/** Callable `billingPortalCreate` (proposed). Caller must be an active owner of organizationId. */
export interface CreateCustomerPortalSessionRequest { organizationId: string }
export interface CreateCustomerPortalSessionResponse { portalUrl: string }

/**
 * Proposed server-written document `organizations/{orgId}/billing/subscription`,
 * readable by active members (owners see management fields), writable only by
 * trusted webhook handlers.
 */
export interface SubscriptionStatusDocument {
  schemaVersion: 1;
  organizationId: string;
  provider: 'stripe';
  status: 'none' | 'checkout_pending' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired';
  cancelAtPeriodEnd: boolean;
  /** Purchased total seats (1 included + additional quantity). */
  purchasedSeats: number;
  currentPeriodEnd: string | null;
  managedByUid: string;
  lastCheckout: { outcome: 'pending' | 'canceled' | 'failed'; seats: number; updatedAt: string } | null;
  updatedAt: string;
  /** Provider event id of the last applied webhook, for idempotency/order checks. */
  lastEventId: string;
}
