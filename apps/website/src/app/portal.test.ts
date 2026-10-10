import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toAuthFailure } from './auth-errors.ts';
import { resolveDesktopDownload } from './download.ts';
import { canChangeRole, canManageBilling, canRemoveMember, canUsePortal } from './permissions.ts';
import { planKind } from './plan.ts';
import { estimateMonthly, formatPrice, parseSeatQuantity } from './pricing.ts';
import { parseRoute, safeReturnPath } from './routes.ts';
import { resolveFirebaseRuntime } from './runtime-config.ts';
import { formatJoinCode, generateJoinCode, JOIN_CODE_ALPHABET, newOrganizationId, normalizeJoinCode } from './validation.ts';

test('pricing: €19 base including one seat plus €5 per additional seat, in integer cents', () => {
  assert.equal(estimateMonthly(1).totalCents, 1900);
  assert.equal(estimateMonthly(2).totalCents, 2400);
  assert.equal(estimateMonthly(5).totalCents, 3900);
  assert.deepEqual(estimateMonthly(5), { totalSeats: 5, includedSeats: 1, additionalSeats: 4, baseCents: 1900, additionalCents: 2000, totalCents: 3900 });
  assert.equal(formatPrice(1900), '€19');
  assert.equal(formatPrice(2400), '€24');
  assert.equal(formatPrice(3900), '€39');
  assert.equal(formatPrice(1950), '€19.50');
});

test('pricing: invalid quantities are rejected, never coerced', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => estimateMonthly(value), RangeError, String(value));
  }
  for (const raw of ['', ' ', '0', '-2', '1.5', '1e3', '0x10', 'two', '3 seats', '١']) {
    assert.equal(parseSeatQuantity(raw).ok, false, raw);
  }
  assert.deepEqual(parseSeatQuantity(' 7 '), { ok: true, value: 7 });
  assert.equal(parseSeatQuantity('99999999999999999999').ok, false);
});

test('routes: known portal paths resolve; unknown paths are not found', () => {
  assert.equal(parseRoute('/get-app'), 'get-app');
  assert.equal(parseRoute('/portal/'), 'portal');
  assert.equal(parseRoute('/portal/team'), 'portal-team');
  assert.equal(parseRoute('/portal/admin'), 'not-found');
  assert.equal(parseRoute('/app'), 'not-found');
});

test('return paths: same-origin allowlisted paths only, query and fragment dropped', () => {
  const origin = 'https://sayspec.app';
  assert.equal(safeReturnPath('/portal/billing', origin), '/portal/billing');
  assert.equal(safeReturnPath('/portal/billing?checkout=success#paid', origin), '/portal/billing');
  assert.equal(safeReturnPath('/get-app', origin), '/get-app');
  for (const raw of ['https://evil.example/portal', '//evil.example/portal', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', '/portal/../../evil', '/sign-in', '/', 'portal', '/portal/%2f%2fevil', '/portal\n/team', null, undefined, '']) {
    assert.equal(safeReturnPath(raw as string, origin), null, String(raw));
  }
});

test('runtime config: missing values are unconfigured; emulators need demo IDs and loopback', () => {
  const live = { VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_AUTH_DOMAIN: 'sayspec.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'sayspec', VITE_FIREBASE_APP_ID: 'a' };
  assert.deepEqual(resolveFirebaseRuntime({}, 'sayspec.app'), { kind: 'unconfigured', missing: ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'] });
  assert.equal(resolveFirebaseRuntime(live, 'sayspec.app').kind, 'firebase');
  assert.equal(resolveFirebaseRuntime({ ...live, VITE_FIREBASE_USE_EMULATORS: 'true' }, '127.0.0.1').kind, 'invalid');
  const demo = { ...live, VITE_FIREBASE_PROJECT_ID: 'demo-sayspec-local' };
  assert.equal(resolveFirebaseRuntime(demo, '127.0.0.1').kind, 'invalid');
  assert.equal(resolveFirebaseRuntime({ ...demo, VITE_FIREBASE_USE_EMULATORS: 'true' }, 'sayspec.app').kind, 'invalid');
  const emulator = resolveFirebaseRuntime({ ...demo, VITE_FIREBASE_USE_EMULATORS: 'true' }, '127.0.0.1');
  assert.equal(emulator.kind === 'firebase' && emulator.emulators, true);
});

test('permissions: last-owner protection and role limits mirror memberChange', () => {
  const owner = { uid: 'o', role: 'owner' as const, ownerUids: ['o'] };
  const admin = { uid: 'a', role: 'admin' as const, ownerUids: ['o'] };
  const ownerMember = { uid: 'o', role: 'owner' as const, status: 'active' };
  const editor = { uid: 'e', role: 'editor' as const, status: 'active' };
  assert.equal(canRemoveMember(owner, ownerMember).allowed, false);
  assert.equal(canChangeRole(owner, ownerMember, 'admin').allowed, false);
  assert.equal(canChangeRole({ ...owner, ownerUids: ['o', 'x'] }, { ...ownerMember, uid: 'x' }, 'admin').allowed, true);
  assert.equal(canChangeRole(owner, editor, 'reviewer').allowed, true);
  assert.equal(canChangeRole(admin, editor, 'admin').allowed, false);
  assert.equal(canChangeRole(admin, ownerMember, 'viewer').allowed, false);
  assert.equal(canChangeRole(admin, { ...editor, uid: 'a', role: 'admin' }, 'viewer').allowed, false);
  assert.equal(canRemoveMember(admin, ownerMember).allowed, false);
  assert.equal(canRemoveMember({ ...editor, ownerUids: ['o'] }, ownerMember).allowed, false);
  assert.equal(canRemoveMember(owner, { ...editor, status: 'revoked' }).allowed, false);
  assert.equal(canManageBilling('owner'), true);
  assert.equal(canManageBilling('admin'), false);
  // The portal is for owners and admins; testers use the desktop app.
  assert.deepEqual((['owner', 'admin', 'editor', 'reviewer', 'viewer'] as const).map(canUsePortal), [true, true, false, false, false]);
});

test('company codes: eight unambiguous letters, forgiving input, uniform generation', () => {
  assert.equal(JOIN_CODE_ALPHABET.length, 24);
  assert.doesNotMatch(JOIN_CODE_ALPHABET, /[IO0-9]/);
  assert.equal(normalizeJoinCode('kxmp-qrta'), 'KXMPQRTA');
  assert.equal(normalizeJoinCode(' KXMP QRTA '), 'KXMPQRTA');
  for (const bad of ['', 'KXMPQRT', 'KXMPQRTAB', 'KXMPQRT1', 'KXMPQRTO', 'KXMPQRTI', 'KXMP_QRTA', 'KXMPQRTÄ']) assert.equal(normalizeJoinCode(bad), null, bad);
  assert.equal(formatJoinCode('KXMPQRTA'), 'KXMP-QRTA');
  const codes = Array.from({ length: 200 }, () => generateJoinCode());
  for (const code of codes) assert.equal(normalizeJoinCode(code), code);
  assert.equal(new Set(codes).size, 200);
  assert.match(newOrganizationId(), /^org_[0-9a-f]{20}$/);
});

test('auth errors: mapped to neutral copy without echoing raw details', () => {
  assert.equal(toAuthFailure({ code: 'auth/invalid-credential', message: 'secret detail' }).code, 'invalid-credentials');
  assert.equal(toAuthFailure({ code: 'auth/user-not-found' }).code, 'invalid-credentials');
  assert.equal(toAuthFailure({ code: 'auth/email-already-in-use' }).code, 'email-in-use');
  assert.equal(toAuthFailure({ code: 'auth/weak-password' }).code, 'weak-password');
  assert.equal(toAuthFailure({ code: 'auth/network-request-failed' }).code, 'network');
  assert.equal(toAuthFailure({ code: 'auth/user-disabled' }).code, 'disabled');
  assert.equal(toAuthFailure({ code: 'auth/user-token-expired' }).code, 'session-expired');
  assert.doesNotMatch(toAuthFailure({ code: 'auth/whatever', message: 'secret detail' }).message, /secret/);
});

test('plan kind: Free and Pro are explicit; Beta, the old free-beta and missing plans read as Beta', () => {
  assert.equal(planKind('free'), 'free');
  assert.equal(planKind('pro'), 'pro');
  assert.equal(planKind('beta'), 'beta');
  assert.equal(planKind('free-beta'), 'beta');
  assert.equal(planKind(undefined), 'beta');
  assert.equal(planKind('enterprise'), 'beta');
});

test('desktop download: only HTTPS URLs and root-relative paths are offered', () => {
  const dmg = 'https://github.com/itsJoKr/sayspec-releases/releases/latest/download/SaySpec-arm64.dmg';
  assert.deepEqual(resolveDesktopDownload(dmg), { available: true, url: dmg });
  assert.deepEqual(resolveDesktopDownload(' /downloads/SaySpec.dmg '), { available: true, url: '/downloads/SaySpec.dmg' });
  for (const value of [undefined, '', '  ', 'http://example.com/a.dmg', '//evil.example/a.dmg', 'javascript:alert(1)', 'SaySpec.dmg']) {
    assert.deepEqual(resolveDesktopDownload(value), { available: false, url: null }, String(value));
  }
});
