import { FieldValue, type DocumentSnapshot, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { createHash, randomBytes } from 'node:crypto';
import { CommandError, memberRef, orgRef, organizationScopeRef, projectScopeRef, requireManager, type Actor, type Role } from './commands.js';

// ------------------------------------------------------------------ seats
// Free Beta plan (product decision 2026-09-24): at most four active members,
// owners included. The limit is server configuration (FREE_BETA_SEAT_LIMIT in
// index.ts) so it can change without a desktop or portal release. Browsers
// never supply plan or seat values.
export const DEFAULT_FREE_BETA_SEAT_LIMIT = 4;
let seatLimitSource: () => number = () => DEFAULT_FREE_BETA_SEAT_LIMIT;
export function setSeatLimitSource(source: () => number) { seatLimitSource = source; }
export function seatLimit() {
  const value = seatLimitSource();
  if (!Number.isSafeInteger(value) || value < 1) throw new CommandError('failed-precondition', 'The workspace seat limit is misconfigured.');
  return value;
}

export type Seats = { organization: DocumentSnapshot; activeUids: Set<string>; limit: number };

/**
 * The one capacity rule. Must be read inside the transaction before any write.
 * Every activation path also writes the organization document (seatFields), so
 * concurrent activations contend on that document and are serialized: the
 * retried transaction re-counts active members and sees the other's seat.
 */
export async function readSeats(tx: Transaction, db: Firestore, orgId: string): Promise<Seats> {
  const organization = await tx.get(orgRef(db, orgId));
  if (!organization.exists) throw new CommandError('not-found', 'Organization does not exist.');
  const active = await tx.get(orgRef(db, orgId).collection('members').where('status', '==', 'active'));
  return { organization, activeUids: new Set(active.docs.map((item) => item.id)), limit: seatLimit() };
}
export function requireSeat(seats: Seats, uid: string) {
  if (seats.activeUids.has(uid)) return;
  // An over-limit workspace (created before the limit existed) keeps every
  // existing member; it only stops accepting new activations.
  if (seats.activeUids.size >= seats.limit) throw new CommandError('failed-precondition', 'This workspace has no free seats.', { reason: 'seats-full', seatLimit: seats.limit });
}
/**
 * Seat fields, rewritten on every membership change. The plan kind is carried
 * over from the workspace so a seat change never changes the plan.
 */
export function seatFields(activeCount: number, limit: number, kind: PlanKind) {
  return { plan: { kind, seatLimit: limit }, activeMemberCount: activeCount, seatsUpdatedAt: FieldValue.serverTimestamp() };
}

// ------------------------------------------------------------------ plans
// Plans (product decision 2026-09-26): Free, and Beta, which is unpaid but
// includes every Pro feature. Pro is the paid plan; it is modeled but not
// offered in the initial release (no billing), so only an operator can set it.
// Pro features today: SaySpec Cloud test storage. Workspaces created before
// plans existed (the old 'free-beta' kind, or no plan at all) keep Pro features
// as Beta workspaces. The plan is server-owned; only this module and admin
// scripts write it.
export type PlanKind = 'free' | 'beta' | 'pro';
let defaultPlanSource: () => PlanKind = () => 'free';
export function setDefaultPlanSource(source: () => string) { defaultPlanSource = () => source() === 'beta' ? 'beta' : 'free'; }
/** The plan a new workspace starts on. */
export function defaultPlan(): PlanKind { return defaultPlanSource(); }
/** 'free' and 'pro' are explicit: 'beta', the old 'free-beta', and workspaces that predate plan fields are Beta. */
export function planKind(organization: { plan?: { kind?: unknown } } | undefined): PlanKind {
  const kind = organization?.plan?.kind;
  return kind === 'free' || kind === 'pro' ? kind : 'beta';
}
/** Whether the plan includes Pro features (Beta and Pro). */
export const isProPlan = (kind: PlanKind) => kind === 'beta' || kind === 'pro';

// --------------------------------------------------------------- directory
/** Directory fields for a membership, copied from Firebase Auth (never from the client payload). */
export function directoryFields(actor: { email?: string; displayName?: string }) {
  return { displayName: actor.displayName?.trim().slice(0, 120) || null, email: actor.email?.toLowerCase() ?? null };
}

/**
 * Activates (or re-activates) a membership with complete member and scope
 * documents, and project scopes for projects the member is authorized to see:
 * all-members projects plus explicitly granted restricted projects. Joining is
 * never authorization for every restricted project.
 */
export async function readAuthorizedProjects(tx: Transaction, db: Firestore, orgId: string, uid: string) {
  const projects = await tx.get(orgRef(db, orgId).collection('projects'));
  const restricted = projects.docs.filter((project) => project.data().access !== 'all-members');
  const grants = restricted.length ? await Promise.all(restricted.map((project) => tx.get(project.ref.collection('grants').doc(uid)))) : [];
  const granted = new Map(grants.filter((grant) => grant.exists).map((grant) => [grant.ref.parent.parent!.id, grant.data()?.access as string]));
  return projects.docs.filter((project) => project.data().access === 'all-members' || granted.has(project.id)).map((project) => ({ project, access: granted.get(project.id) ?? 'all-members' }));
}
export function writeActiveMembership(tx: Transaction, db: Firestore, input: {
  orgId: string; organizationName: string; uid: string; role: Role; member: Record<string, unknown>;
  projects: Awaited<ReturnType<typeof readAuthorizedProjects>>;
}) {
  tx.set(memberRef(db, input.orgId, input.uid), { ...input.member, uid: input.uid, organizationId: input.orgId, role: input.role, status: 'active' });
  // Complete scope document (fixes the merge-without-name reactivation bug).
  tx.set(organizationScopeRef(db, input.uid, input.orgId), { organizationId: input.orgId, name: input.organizationName, role: input.role, status: 'active', updatedAt: FieldValue.serverTimestamp() });
  for (const { project, access } of input.projects) {
    const data = project.data() ?? {};
    tx.set(projectScopeRef(db, input.uid, input.orgId, project.id), {
      organizationId: input.orgId, projectId: project.id, name: data.name ?? project.id, targetType: data.targetType, access,
      ...(typeof data.baseUrl === 'string' ? { baseUrl: data.baseUrl } : {}), ...(typeof data.testStorage === 'string' ? { testStorage: data.testStorage } : {}), updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

export function auditRef(db: Firestore, orgId: string) { return orgRef(db, orgId).collection('audit').doc(); }

// ------------------------------------------------------------ join codes
// Eight letters without I/O, displayed ABCD-EFGH (same contract as
// apps/website/src/app/validation.ts and the desktop join form).
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const JOIN_CODE_LENGTH = 8;
export const JOIN_CODE_ROLE: Role = 'editor';
export function normalizeJoinCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const value = raw.replace(/[\s-]/g, '').toUpperCase();
  return value.length === JOIN_CODE_LENGTH && [...value].every((char) => JOIN_CODE_ALPHABET.includes(char)) ? value : null;
}
export function generateJoinCode(random: (size: number) => Uint8Array = randomBytes) {
  const limit = 256 - (256 % JOIN_CODE_ALPHABET.length);
  let code = '';
  while (code.length < JOIN_CODE_LENGTH) {
    for (const byte of random(16)) if (byte < limit && code.length < JOIN_CODE_LENGTH) code += JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length];
  }
  return code;
}
function joinCodeRef(db: Firestore, orgId: string) { return orgRef(db, orgId).collection('private').doc('joinCode'); }
function joinCodeLookupRef(db: Firestore, code: string) { return db.collection('joinCodes').doc(code); }

export async function rotateJoinCode(db: Firestore, actor: Actor, input: { organizationId: string }, random?: (size: number) => Uint8Array) {
  return db.runTransaction(async (tx) => {
    await requireManager(tx, db, input.organizationId, actor);
    const current = await tx.get(joinCodeRef(db, input.organizationId));
    // Collision handling: read several candidates, keep the first unused one.
    const candidates = [...new Set(Array.from({ length: 4 }, () => generateJoinCode(random)))];
    const lookups = await Promise.all(candidates.map((code) => tx.get(joinCodeLookupRef(db, code))));
    const code = candidates.find((_candidate, index) => !lookups[index].exists);
    if (!code) throw new CommandError('aborted', 'A unique company code could not be generated. Try again.');
    const previous = current.data()?.code;
    if (typeof previous === 'string') tx.delete(joinCodeLookupRef(db, previous));
    tx.create(joinCodeLookupRef(db, code), { organizationId: input.organizationId, createdAt: FieldValue.serverTimestamp() });
    tx.set(joinCodeRef(db, input.organizationId), { organizationId: input.organizationId, code, enabled: true, role: JOIN_CODE_ROLE, rotatedAt: FieldValue.serverTimestamp(), rotatedByUid: actor.uid });
    tx.create(auditRef(db, input.organizationId), { type: previous ? 'join-code.rotated' : 'join-code.created', actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    return { organizationId: input.organizationId, rotated: Boolean(previous) };
  });
}

export async function setJoinCodeEnabled(db: Firestore, actor: Actor, input: { organizationId: string; enabled: boolean }) {
  if (typeof input.enabled !== 'boolean') throw new CommandError('invalid-argument', 'Choose whether joining is on or off.');
  return db.runTransaction(async (tx) => {
    await requireManager(tx, db, input.organizationId, actor);
    const current = await tx.get(joinCodeRef(db, input.organizationId));
    if (!current.exists || typeof current.data()?.code !== 'string') throw new CommandError('failed-precondition', 'Generate a company code first.');
    tx.update(current.ref, { enabled: input.enabled, changedAt: FieldValue.serverTimestamp(), changedByUid: actor.uid });
    tx.create(auditRef(db, input.organizationId), { type: input.enabled ? 'join-code.enabled' : 'join-code.disabled', actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    return { organizationId: input.organizationId, enabled: input.enabled };
  });
}

/** One neutral answer for unknown, rotated and disabled codes, so the response is not an oracle. */
const invalidCode = () => new CommandError('not-found', 'This company code is not valid.', { reason: 'invalid-code' });

export async function redeemJoinCode(db: Firestore, actor: Actor, input: { code: unknown }) {
  const code = normalizeJoinCode(input?.code);
  if (!code) throw invalidCode();
  return db.runTransaction(async (tx) => {
    const lookup = await tx.get(joinCodeLookupRef(db, code));
    const orgId = lookup.data()?.organizationId;
    if (!lookup.exists || typeof orgId !== 'string') throw invalidCode();
    const current = await tx.get(joinCodeRef(db, orgId));
    const member = await tx.get(memberRef(db, orgId, actor.uid));
    const seats = await readSeats(tx, db, orgId);
    const name = String(seats.organization.data()?.name ?? orgId);
    // The lookup must still be the workspace's current code.
    if (current.data()?.code !== code) throw invalidCode();
    // Idempotent: an active member keeps their role and seat, even at capacity.
    if (member.exists && member.data()?.status === 'active') return { organizationId: orgId, name, role: member.data()?.role as Role, joined: false };
    if (current.data()?.enabled !== true) throw invalidCode();
    requireSeat(seats, actor.uid);
    const projects = await readAuthorizedProjects(tx, db, orgId, actor.uid);
    // Removed members may rejoin with a still-valid code; the membership is
    // fully rewritten as a fresh Editor (earlier roles are not restored).
    writeActiveMembership(tx, db, {
      orgId, organizationName: name, uid: actor.uid, role: JOIN_CODE_ROLE, projects,
      member: { joinedAt: FieldValue.serverTimestamp(), joinedVia: 'join-code', ...directoryFields(actor), ...(member.exists ? { rejoinedAt: FieldValue.serverTimestamp() } : {}) },
    });
    tx.update(seats.organization.ref, seatFields(seats.activeUids.size + 1, seats.limit, planKind(seats.organization.data())));
    tx.create(auditRef(db, orgId), { type: 'member.joined-with-code', actorUid: actor.uid, targetUid: actor.uid, role: JOIN_CODE_ROLE, at: FieldValue.serverTimestamp() });
    return { organizationId: orgId, name, role: JOIN_CODE_ROLE, joined: true };
  });
}

// ----------------------------------------------------------- rate limiting
// Company codes are short, so redemption is bounded per account and per
// network address (hashed; plaintext IPs and codes are never stored or logged).
export const REDEEM_LIMITS = {
  windowMs: 60 * 60 * 1000,
  uidAttempts: 30,
  uidFailures: 10,
  ipFailures: 30,
  freeConsecutiveFailures: 3,
  backoffBaseMs: 5_000,
  backoffMaxMs: 15 * 60 * 1000,
} as const;
type Counter = { windowStart: number; attempts: number; failures: number; consecutiveFailures: number; lastFailureAt: number };
const emptyCounter = (now: number): Counter => ({ windowStart: now, attempts: 0, failures: 0, consecutiveFailures: 0, lastFailureAt: 0 });
function counterOf(snapshot: DocumentSnapshot, now: number): Counter {
  const data = snapshot.data() as Partial<Counter> | undefined;
  if (!data || typeof data.windowStart !== 'number' || now - data.windowStart >= REDEEM_LIMITS.windowMs) return { ...emptyCounter(now), consecutiveFailures: data?.consecutiveFailures ?? 0, lastFailureAt: data?.lastFailureAt ?? 0 };
  return { ...emptyCounter(now), ...data } as Counter;
}
export function backoffMs(consecutiveFailures: number) {
  const over = consecutiveFailures - REDEEM_LIMITS.freeConsecutiveFailures;
  return over < 0 ? 0 : Math.min(REDEEM_LIMITS.backoffBaseMs * 2 ** over, REDEEM_LIMITS.backoffMaxMs);
}
function rateKeys(db: Firestore, uid: string, ip: string | undefined) {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);
  return { uid: db.collection('rateLimits').doc(`joinRedeem_uid_${hash(uid)}`), ip: db.collection('rateLimits').doc(`joinRedeem_ip_${hash(ip || 'unknown')}`) };
}
const tooMany = (retryAfterMs: number) => new CommandError('resource-exhausted', `Too many company code attempts. Try again in ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} minute${retryAfterMs > 60_000 ? 's' : ''}.`, { reason: 'rate-limited', retryAfterSeconds: Math.ceil(retryAfterMs / 1000) });

/** Reserves one attempt, or rejects while the caller is blocked or backing off. */
export async function reserveRedeemAttempt(db: Firestore, uid: string, ip: string | undefined, now = Date.now()) {
  const keys = rateKeys(db, uid, ip);
  await db.runTransaction(async (tx) => {
    const [uidSnapshot, ipSnapshot] = await Promise.all([tx.get(keys.uid), tx.get(keys.ip)]);
    const user = counterOf(uidSnapshot, now); const network = counterOf(ipSnapshot, now);
    const windowEnd = (counter: Counter) => counter.windowStart + REDEEM_LIMITS.windowMs - now;
    if (user.failures >= REDEEM_LIMITS.uidFailures || user.attempts >= REDEEM_LIMITS.uidAttempts) throw tooMany(windowEnd(user));
    if (network.failures >= REDEEM_LIMITS.ipFailures) throw tooMany(windowEnd(network));
    const wait = user.lastFailureAt + backoffMs(user.consecutiveFailures) - now;
    if (wait > 0) throw tooMany(wait);
    tx.set(keys.uid, { ...user, attempts: user.attempts + 1, updatedAt: FieldValue.serverTimestamp() });
    tx.set(keys.ip, { ...network, attempts: network.attempts + 1, updatedAt: FieldValue.serverTimestamp() });
  });
}
export async function recordRedeemOutcome(db: Firestore, uid: string, ip: string | undefined, failed: boolean, now = Date.now()) {
  const keys = rateKeys(db, uid, ip);
  await db.runTransaction(async (tx) => {
    const [uidSnapshot, ipSnapshot] = await Promise.all([tx.get(keys.uid), tx.get(keys.ip)]);
    const user = counterOf(uidSnapshot, now); const network = counterOf(ipSnapshot, now);
    if (!failed) { tx.set(keys.uid, { ...user, consecutiveFailures: 0, updatedAt: FieldValue.serverTimestamp() }); return; }
    tx.set(keys.uid, { ...user, failures: user.failures + 1, consecutiveFailures: user.consecutiveFailures + 1, lastFailureAt: now, updatedAt: FieldValue.serverTimestamp() });
    tx.set(keys.ip, { ...network, failures: network.failures + 1, lastFailureAt: now, updatedAt: FieldValue.serverTimestamp() });
  });
}

// -------------------------------------------------- directory backfill
export type DirectoryLookup = (uids: string[]) => Promise<Map<string, { email?: string; displayName?: string }>>;

/**
 * On-demand backfill of member names/emails from Firebase Auth, plus a seat
 * recount. Owners/admins refresh the whole workspace; other members only
 * themselves. Existing over-limit workspaces are reported, never trimmed.
 */
export async function syncMemberDirectory(db: Firestore, actor: Actor, input: { organizationId: string }, lookup: DirectoryLookup) {
  const caller = await memberRef(db, input.organizationId, actor.uid).get();
  if (!caller.exists || caller.data()?.status !== 'active') throw new CommandError('permission-denied', 'Active membership is required.');
  const manager = ['owner', 'admin'].includes(caller.data()?.role);
  const result = await reconcileOrganization(db, input.organizationId, lookup, manager ? undefined : [actor.uid]);
  return { organizationId: result.organizationId, updated: result.directoryUpdated, activeMemberCount: result.activeMemberCount, seatLimit: result.seatLimit };
}

/**
 * Reconciles one workspace with the current capacity rule: recounts active
 * members, writes the server plan fields and refreshes directory fields from
 * Auth (for `only` UIDs when given). Never changes a membership's status or
 * role, so an over-limit workspace keeps everyone and simply accepts no new
 * activations. Used by memberDirectorySync and the operator backfill script.
 */
export async function reconcileOrganization(db: Firestore, organizationId: string, lookup: DirectoryLookup, only?: string[]) {
  const organization = orgRef(db, organizationId);
  const members = only ?? (await organization.collection('members').get()).docs.map((item) => item.id);
  const profiles = await lookup(members);
  return db.runTransaction(async (tx) => {
    const seats = await readSeats(tx, db, organizationId);
    const snapshots = await Promise.all(members.map((uid) => tx.get(memberRef(db, organizationId, uid))));
    let directoryUpdated = 0;
    for (const snapshot of snapshots) {
      const profile = profiles.get(snapshot.id);
      if (!snapshot.exists || !profile) continue;
      const fields = directoryFields(profile);
      if (snapshot.data()?.displayName !== fields.displayName || snapshot.data()?.email !== fields.email) { tx.update(snapshot.ref, fields); directoryUpdated += 1; }
    }
    tx.update(seats.organization.ref, seatFields(seats.activeUids.size, seats.limit, planKind(seats.organization.data())));
    return { organizationId, activeMemberCount: seats.activeUids.size, seatLimit: seats.limit, overLimit: seats.activeUids.size > seats.limit, directoryUpdated };
  });
}
