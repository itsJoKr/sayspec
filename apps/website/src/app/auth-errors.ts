export type AuthFailureCode =
  | 'invalid-credentials' | 'email-in-use' | 'weak-password' | 'invalid-email' | 'network'
  | 'disabled' | 'too-many-requests' | 'requires-recent-login' | 'session-expired'
  | 'not-configured' | 'unknown';

export class AuthFailure extends Error {
  readonly code: AuthFailureCode;
  constructor(code: AuthFailureCode, message: string) { super(message); this.name = 'AuthFailure'; this.code = code; }
}

const MESSAGES: Record<AuthFailureCode, string> = {
  'invalid-credentials': 'The email or password is incorrect.',
  'email-in-use': 'An account may already use this email. Sign in instead, or reset your password.',
  'weak-password': 'Choose a stronger password with at least 8 characters.',
  'invalid-email': 'Enter a valid email address.',
  network: 'SaySpec could not reach the sign-in service. Check your connection and try again.',
  disabled: 'This account has been disabled. Contact your workspace owner or SaySpec support.',
  'too-many-requests': 'Too many attempts. Wait a few minutes, then try again.',
  'requires-recent-login': 'For your security, confirm your current password and try again.',
  'session-expired': 'Your session ended. Sign in again to continue.',
  'not-configured': 'Sign-in is not available on this site build.',
  unknown: 'Something went wrong. Try again.',
};

const FIREBASE_CODES: Record<string, AuthFailureCode> = {
  'auth/invalid-credential': 'invalid-credentials',
  'auth/invalid-login-credentials': 'invalid-credentials',
  'auth/wrong-password': 'invalid-credentials',
  'auth/user-not-found': 'invalid-credentials',
  'auth/email-already-in-use': 'email-in-use',
  'auth/weak-password': 'weak-password',
  'auth/password-does-not-meet-requirements': 'weak-password',
  'auth/invalid-email': 'invalid-email',
  'auth/missing-email': 'invalid-email',
  'auth/network-request-failed': 'network',
  'auth/internal-error': 'unknown',
  'auth/user-disabled': 'disabled',
  'auth/too-many-requests': 'too-many-requests',
  'auth/requires-recent-login': 'requires-recent-login',
  'auth/user-token-expired': 'session-expired',
  'auth/invalid-user-token': 'session-expired',
  'auth/configuration-not-found': 'not-configured',
  'auth/invalid-api-key': 'not-configured',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'not-configured',
};

export function authFailure(code: AuthFailureCode, message = MESSAGES[code]) {
  return new AuthFailure(code, message);
}

/** Maps SDK errors to user-facing messages without echoing raw error text or input. */
export function toAuthFailure(error: unknown): AuthFailure {
  if (error instanceof AuthFailure) return error;
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  const mapped = FIREBASE_CODES[code] ?? (code.startsWith('auth/') ? 'unknown' : 'unknown');
  return authFailure(mapped);
}

/** Password reset never reveals whether an account exists. */
export const RESET_SENT_MESSAGE = 'If an account exists for that email, a password reset link is on its way. Check your inbox and spam folder.';
