import assert from 'node:assert/strict';
import test from 'node:test';
import { testAuthorLabel } from '../src/test-author.ts';

const currentUser = { uid: 'user_tester', displayName: null, email: 'tester@sayspec.local' };

test('a trusted author snapshot identifies another Pro author', () => {
  assert.equal(testAuthorLabel({ ownerUid: 'user_reviewer', authorLabel: 'Reviewer Name' }, currentUser), 'Reviewer Name');
});

test('legacy Pro tests identify the current author from sign-in', () => {
  assert.equal(testAuthorLabel({ ownerUid: 'user_tester' }, currentUser), 'tester@sayspec.local');
});

test('legacy tests from other members retain an honest owner identifier', () => {
  assert.equal(testAuthorLabel({ ownerUid: 'user_reviewer' }, currentUser), 'user_reviewer');
  assert.equal(testAuthorLabel({}, currentUser), 'Unknown author');
});
