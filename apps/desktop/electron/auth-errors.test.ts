import assert from 'node:assert/strict';
import test from 'node:test';
import { authErrorState } from '../src/cloud/firebase/auth-errors.ts';

test('expired and revoked sessions become a visible revoked state', () => {
  for (const code of ['auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-disabled']) {
    const result = authErrorState({ code });
    assert.equal(result.status, 'revoked');
    assert.match(result.message, /revoked/);
  }
});

test('offline and invalid credentials remain distinguishable', () => {
  assert.equal(authErrorState({ code: 'auth/network-request-failed' }).status, 'offline');
  assert.equal(authErrorState({ code: 'auth/wrong-password' }).status, 'signed-out');
});

test('account creation failures have specific, non-revealing copy', () => {
  assert.match(authErrorState({ code: 'auth/email-already-in-use' }).message, /may already use this email/);
  assert.match(authErrorState({ code: 'auth/weak-password' }).message, /at least 8/);
  assert.equal(authErrorState({ code: 'auth/email-already-in-use' }).status, 'signed-out');
});
