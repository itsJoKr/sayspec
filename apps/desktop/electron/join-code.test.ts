import assert from 'node:assert/strict';
import test from 'node:test';
import { formatJoinCode, joinFailure, normalizeJoinCode, JOIN_CODE_ALPHABET } from '../src/join-code.ts';
import { accountPortalUrl } from './security.ts';

test('company codes: eight letters without I and O, entered in any case with spaces or hyphens', () => {
  assert.equal(JOIN_CODE_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ');
  for (const input of ['abcd-efgh', ' ABCD efgh ', 'ABCDEFGH']) assert.equal(normalizeJoinCode(input), 'ABCDEFGH', input);
  for (const input of ['abcd-efg', 'ABCDEFGI', 'ABCD0EFG', 'ABCD-EFGH-J', '']) assert.equal(normalizeJoinCode(input), null, input);
  assert.equal(formatJoinCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('join failures map to honest copy without echoing codes', () => {
  assert.equal(joinFailure({ code: 'functions/not-found', message: 'This company code is not valid.', details: { reason: 'invalid-code' } }).kind, 'invalid-code');
  assert.equal(joinFailure({ code: 'functions/failed-precondition', details: { reason: 'seats-full' } }).kind, 'seats-full');
  assert.match(joinFailure({ code: 'functions/resource-exhausted', details: { reason: 'rate-limited', retryAfterSeconds: 130 } }).message, /3 minutes/);
  assert.equal(joinFailure({ code: 'functions/unavailable' }).kind, 'offline');
  assert.equal(joinFailure({ code: 'functions/internal', message: 'internal' }).kind, 'offline');
  assert.equal(joinFailure({ code: 'functions/unauthenticated' }).kind, 'signed-out');
  assert.doesNotMatch(joinFailure({ code: 'functions/not-found', message: 'KXMPQRTA' }).message, /KXMPQRTA/);
});

test('the account portal bridge opens only fixed SaySpec destinations', () => {
  assert.equal(accountPortalUrl({ page: 'portal' }, 'https://portal.example'), 'https://portal.example/portal');
  assert.equal(accountPortalUrl({ page: 'sign-up' }, 'http://127.0.0.1:5002'), 'http://127.0.0.1:5002/sign-up');
  assert.equal(accountPortalUrl({ page: 'billing' }, 'https://portal.example'), 'https://portal.example/portal/billing');
  assert.throws(() => accountPortalUrl({ page: 'constructor' }, 'https://portal.example'), /invalid/);
  assert.throws(() => accountPortalUrl({ page: '//evil.example' }, 'https://portal.example'), /invalid/);
  assert.throws(() => accountPortalUrl({ origin: 'https://evil.example', page: 'portal' }, ''), /no account portal/);
  assert.throws(() => accountPortalUrl({ page: 'portal' }, 'http://evil.example'), /no account portal/);
  assert.throws(() => accountPortalUrl({ page: 'portal' }, 'https://portal.example/path'), /no account portal/);
});
