import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedMainFrame, rendererFileUrl } from './security.ts';

test('accepts only the expected main frame', () => {
  const mainFrame = { url: 'file:///trusted/index.html' };
  assert.equal(isTrustedMainFrame({ sender: { mainFrame }, senderFrame: mainFrame }, mainFrame.url), true);
});

test('rejects a child frame even when its URL matches', () => {
  const mainFrame = { url: 'file:///trusted/index.html' };
  const childFrame = { url: mainFrame.url };
  assert.equal(isTrustedMainFrame({ sender: { mainFrame }, senderFrame: childFrame }, mainFrame.url), false);
});

test('rejects an unexpected main-frame URL and a missing frame', () => {
  const mainFrame = { url: 'file:///unexpected/index.html' };
  assert.equal(isTrustedMainFrame({ sender: { mainFrame }, senderFrame: mainFrame }, 'file:///trusted/index.html'), false);
  assert.equal(isTrustedMainFrame({ sender: { mainFrame }, senderFrame: null }, mainFrame.url), false);
});

test('normalizes renderer paths as file URLs', () => {
  assert.match(rendererFileUrl('/tmp/Say Spec/index.html'), /^file:\/\/\/tmp\/Say%20Spec\/index\.html$/);
});
