import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const config = { apiKey: 'demo-api-key', authDomain: 'demo-sayspec-local.firebaseapp.com', projectId: 'demo-sayspec-local', appId: '1:123:web:demo' };
function client(name) { const app = initializeApp(config, name); const auth = getAuth(app); const functions = getFunctions(app, 'europe-west1'); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectFunctionsEmulator(functions, '127.0.0.1', 5001); return { app, auth, functions }; }
const owner = client(`application-owner-${Date.now()}`); const reviewer = client(`application-reviewer-${Date.now()}`); const outsider = client(`application-outsider-${Date.now()}`);
const scope = { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_fixture', target: 'web' };
const proposalId = 'app_proposal_emulator_approved';
const decision = { ...scope, proposalId, attemptId: 'attempt_fixture', analysisId: 'analysis_fixture', testVersionId: 'version_fixture', testVersionHash: 'a'.repeat(64), sourceRootHash: 'b'.repeat(64), proposalHash: 'c'.repeat(64), kind: 'approve' };
const apply = { ...scope, proposalId, sourceRootHash: decision.sourceRootHash, proposalHash: decision.proposalHash };
try {
  await Promise.all([signInWithEmailAndPassword(owner.auth, 'tester@sayspec.local', 'local-only-password'), signInWithEmailAndPassword(reviewer.auth, 'reviewer@sayspec.local', 'local-only-password'), signInWithEmailAndPassword(outsider.auth, 'outsider@sayspec.local', 'local-only-password')]);
  assert.equal((await httpsCallable(owner.functions, 'applicationFixReadAuthorize')(scope)).data.actorUid, 'user_tester');
  await assert.rejects(httpsCallable(outsider.functions, 'applicationFixReadAuthorize')(scope), /membership|permission|access/i);
  await assert.rejects(httpsCallable(owner.functions, 'applicationFixReadAuthorize')({ ...scope, target: 'flutter' }), /target|precondition/i);
  await assert.rejects(httpsCallable(outsider.functions, 'applicationFixDecide')(decision), /membership|permission|authority/i);
  await assert.rejects(httpsCallable(owner.functions, 'applicationFixApplyAuthorize')(apply), /approval|permission/i);
  assert.equal((await httpsCallable(reviewer.functions, 'applicationFixDecide')(decision)).data.actorUid, 'user_reviewer');
  assert.equal((await httpsCallable(reviewer.functions, 'applicationFixDecide')(decision)).data.actorUid, 'user_reviewer');
  await assert.rejects(httpsCallable(reviewer.functions, 'applicationFixDecide')({ ...decision, kind: 'reject' }), /different|already-exists/i);
  await assert.rejects(httpsCallable(owner.functions, 'applicationFixApplyAuthorize')(apply), /approval|permission/i);
  await assert.rejects(httpsCallable(reviewer.functions, 'applicationFixApplyAuthorize')({ ...apply, proposalHash: 'd'.repeat(64) }), /approval|permission/i);
  assert.equal((await httpsCallable(reviewer.functions, 'applicationFixApplyAuthorize')(apply)).data.actorUid, 'user_reviewer');
  const receipt = { ...apply, receiptId: 'app_receipt_emulator', appliedHashesHash: 'e'.repeat(64) };
  assert.equal((await httpsCallable(reviewer.functions, 'applicationFixAppliedRecord')(receipt)).data.receiptId, receipt.receiptId);
  assert.equal((await httpsCallable(reviewer.functions, 'applicationFixAppliedRecord')(receipt)).data.receiptId, receipt.receiptId);
  await assert.rejects(httpsCallable(reviewer.functions, 'applicationFixAppliedRecord')({ ...receipt, receiptId: 'app_receipt_forged' }), /different|already-exists/i);
  await httpsCallable(owner.functions, 'memberChange')({ organizationId: scope.organizationId, uid: 'user_reviewer', status: 'revoked' });
  await assert.rejects(httpsCallable(reviewer.functions, 'applicationFixApplyAuthorize')(apply), /permission|authority/i);
  await assert.rejects(httpsCallable(reviewer.functions, 'applicationFixAppliedRecord')(receipt), /permission|authority/i);
  await assert.rejects(httpsCallable(reviewer.functions, 'applicationFixReadAuthorize')(scope), /membership|permission|access/i);
  console.log(JSON.stringify({ exactApproval: 'enforced', duplicateDecision: 'idempotent', duplicateReceipt: 'idempotent', alteredPatch: 'denied', forgedReceipt: 'denied', outsider: 'denied', revokedMember: 'denied' }));
} finally { await Promise.all([deleteApp(owner.app), deleteApp(reviewer.app), deleteApp(outsider.app)]); }
