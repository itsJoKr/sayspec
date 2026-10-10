export function authErrorState(error: unknown, mode: 'emulator' | 'live' = 'emulator') {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code.includes('network-request-failed')) return {
    status: 'offline' as const,
    message: mode === 'emulator'
      ? 'The local Auth emulator is offline. Start it, then try again.'
      : 'Firebase Authentication is unavailable. Check your connection, then try again.',
  };
  if (code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('user-not-found')) return { status: 'signed-out' as const, message: 'The email or password did not match an account.' };
  if (code.includes('email-already-in-use')) return { status: 'signed-out' as const, message: 'An account may already use this email. Sign in instead, or reset the password.' };
  if (code.includes('weak-password')) return { status: 'signed-out' as const, message: 'Choose a longer password (at least 8 characters).' };
  if (code.includes('invalid-email')) return { status: 'signed-out' as const, message: 'Enter a valid email address.' };
  if (code.includes('too-many-requests')) return { status: 'signed-out' as const, message: 'Too many attempts. Wait a moment, then try again.' };
  if (code.includes('user-disabled') || code.includes('user-token-expired') || code.includes('invalid-user-token')) return { status: 'revoked' as const, message: 'This session was revoked. Sign in with an active account.' };
  return { status: 'signed-out' as const, message: 'Sign-in could not be completed. Try again.' };
}
