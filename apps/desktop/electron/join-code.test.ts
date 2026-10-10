import assert from 'node:assert/strict';
import test from 'node:test';
import { formatJoinCode, joinFailure, normalizeJoinCode, JOIN_CODE_ALPHABET } from '../src/join-code.ts';
import { JOIN_CODE_ALPHABET as PORTAL_ALPHABET, normalizeJoinCode as portalNormalize } from '../../website/src/app/validation.ts';
import { accountPortalUrl } from './security.ts';

test('desktop company-code input matches the portal contract', () => {
  assert.equal(JOIN_CODE_ALPHABET, PORTAL_ALPHABET);
  for (const input of ['abcd-efgh', ' ABCD efgh ', 'ABCDEFGH', 'abcd-efg', 'ABCDEFGI', 'ABCD0EFG', 'ABCD-EFGH-J', '']) assert.equal(normalizeJoinCode(input), portalNormalize(input), input);
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
  assert.throws(() => accountPortalUrl({ page: '//evil.example' }, 'https://portal.example'), /invalid/);
  assert.throws(() => accountPortalUrl({ origin: 'https://evil.example', page: 'portal' }, ''), /no account portal/);
  assert.throws(() => accountPortalUrl({ page: 'portal' }, 'http://evil.example'), /no account portal/);
  assert.throws(() => accountPortalUrl({ page: 'portal' }, 'https://portal.example/path'), /no account portal/);
});
