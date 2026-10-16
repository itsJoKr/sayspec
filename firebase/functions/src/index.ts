import { getApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { defineBoolean, defineInt, defineString } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { acceptInvitation, archiveTest, setProjectTestStorage, setProjectTestInstructions, assignTestReviewer, authorizeApplicationFixApply, authorizeApplicationFixRead, authorizeLocalRun, authorizeManagedFixApply, authorizeManagedFixRead, beginFlutterSliceShare, beginRecordingShare, changeMemberRole, commentOnTest, CommandError, configureProject, createInvitation, createOrganization, createProject, createTestDraft, decideApplicationFix, decideManagedFix, deleteProject, finalizeFlutterSliceShare, finalizeRecordingShare, importPortableTest, moveTestToSuite, publishTestDraft, readFlutterSliceShare, recordApplicationFixApplied, recordLocalRun, recordLocalTestAttempt, recordManagedFixApplied, renameTest, savePatrolTestVersion, saveSuite, saveTestDraft, setProjectGrant, type Actor } from './commands.js';

import { DEFAULT_FREE_BETA_SEAT_LIMIT, recordRedeemOutcome, redeemJoinCode, reserveRedeemAttempt, rotateJoinCode, setDefaultPlanSource, setJoinCodeEnabled, setSeatLimitSource, syncMemberDirectory } from './membership.js';
import { emulatorTranscriber, transcribeNarration, vertexGeminiTranscriber } from './transcription.js';

// Co-located with the eur3 Firestore database. The desktop renderer, desktop
// main process and portal all call this region explicitly.
setGlobalOptions({ region: 'europe-west1' });
initializeApp();
const db = getFirestore();
// Free Beta seat limit, owners included. Server configuration only.
const freeBetaSeatLimit = defineInt('FREE_BETA_SEAT_LIMIT', { default: DEFAULT_FREE_BETA_SEAT_LIMIT, description: 'Maximum active members per workspace on the free Beta plan, owners included.' });
setSeatLimitSource(() => freeBetaSeatLimit.value());
// The plan a new workspace starts on: 'free' or 'beta' (unpaid, with Pro features). Server configuration only; the paid 'pro' plan is never a default.
const defaultOrganizationPlan = defineString('DEFAULT_ORGANIZATION_PLAN', { default: 'free', description: "Plan for new workspaces: 'free' or 'beta' (Beta includes Pro features such as SaySpec Cloud test storage)." });
setDefaultPlanSource(() => defaultOrganizationPlan.value());
// App Check for portal-only team operations. Deliberately no default: a deploy
// must decide explicitly (true once the portal's reCAPTCHA Enterprise key is
// registered). The demo emulator project sets false in
// .env.demo-sayspec-local, which never applies to the live project. The
// desktop join callable has no supported App Check attestation provider and is
// protected by authentication plus per-account/per-address rate limits instead.
const portalAppCheck = defineBoolean('PORTAL_APP_CHECK_ENFORCE', { description: 'Require App Check tokens on portal team callables (joinCodeRotate, joinCodeSetEnabled, memberDirectorySync).' });
// Gemini narration transcription (Beta and Pro). Vertex AI is called as the
// function's service account; no API key is configured anywhere.
const transcriptionModel = defineString('GEMINI_TRANSCRIPTION_MODEL', { default: 'gemini-3.5-flash', description: 'Vertex AI Gemini model used for narration transcription.' });
const transcriptionLocation = defineString('GEMINI_TRANSCRIPTION_LOCATION', { default: 'europe-west3', description: "Vertex AI location of the transcription model ('global' or a region that offers the model)." });
const transcriptionMonthlyMinutes = defineInt('TRANSCRIPTION_MONTHLY_MINUTES', { default: 600, description: 'Gemini transcription minutes per workspace per calendar month (UTC).' });
const transcriptionMaxInstances = defineInt('TRANSCRIPTION_MAX_INSTANCES', { default: 5, description: 'Upper bound on concurrently running transcription instances; caps provider spend under load.' });
// The emulator never reaches a provider; the stand-in only exists for demo- projects.
const emulatedTranscription = process.env.FUNCTIONS_EMULATOR === 'true' && (process.env.GCLOUD_PROJECT ?? '').startsWith('demo-');

function actor(request: CallableRequest<unknown>): Actor {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in is required.');
  return { uid: request.auth.uid, email: request.auth.token.email as string | undefined, displayName: typeof request.auth.token.name === 'string' ? request.auth.token.name : undefined };
}
/** Actor whose directory fields come from Firebase Auth itself rather than possibly stale token claims. */
async function trustedActor(request: CallableRequest<unknown>): Promise<Actor> {
  const base = actor(request);
  const user = await getAuth().getUser(base.uid);
  return { uid: base.uid, email: user.email, displayName: user.displayName };
}
async function directoryLookup(uids: string[]) {
  const profiles = new Map<string, { email?: string; displayName?: string }>();
  for (let index = 0; index < uids.length; index += 100) {
    const result = await getAuth().getUsers(uids.slice(index, index + 100).map((uid) => ({ uid })));
    result.users.forEach((user) => profiles.set(user.uid, { email: user.email, displayName: user.displayName }));
  }
  return profiles;
}
async function invoke<T>(operation: () => Promise<T>) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof CommandError) throw new HttpsError(error.code, error.message, error.details);
    throw error;
  }
}

export const organizationCreate = onCall(async (request) => invoke(async () => createOrganization(db, await trustedActor(request), request.data)));
export const joinCodeRotate = onCall({ enforceAppCheck: portalAppCheck }, (request) => invoke(() => rotateJoinCode(db, actor(request), request.data)));
export const joinCodeSetEnabled = onCall({ enforceAppCheck: portalAppCheck }, (request) => invoke(() => setJoinCodeEnabled(db, actor(request), request.data)));
export const memberDirectorySync = onCall({ enforceAppCheck: portalAppCheck }, (request) => invoke(() => syncMemberDirectory(db, actor(request), request.data, directoryLookup)));
export const joinCodeRedeem = onCall(async (request) => invoke(async () => {
  const caller = await trustedActor(request);
  const ip = request.rawRequest?.ip;
  await reserveRedeemAttempt(db, caller.uid, ip);
  try {
    const result = await redeemJoinCode(db, caller, request.data ?? {});
    await recordRedeemOutcome(db, caller.uid, ip, false);
    if (result.joined) logger.info('join code redeemed', { uid: caller.uid, organizationId: result.organizationId });
    return result;
  } catch (error) {
    // Only guesses count against the caller; a full workspace is not a guess.
    if (error instanceof CommandError && error.details?.reason === 'invalid-code') {
      await recordRedeemOutcome(db, caller.uid, ip, true);
      logger.warn('join code rejected', { uid: caller.uid });
    }
    throw error;
  }
}));
export const invitationCreate = onCall((request) => invoke(() => createInvitation(db, actor(request), { ...request.data, expiresAt: new Date(request.data.expiresAt) })));
export const invitationAccept = onCall(async (request) => invoke(async () => acceptInvitation(db, await trustedActor(request), request.data)));
export const projectCreate = onCall((request) => invoke(() => createProject(db, actor(request), request.data)));
export const projectGrantSet = onCall((request) => invoke(() => setProjectGrant(db, actor(request), request.data)));
export const projectConfigure = onCall((request) => invoke(() => configureProject(db, actor(request), request.data)));
export const projectSetTestStorage = onCall((request) => invoke(() => setProjectTestStorage(db, actor(request), request.data)));
export const projectSetTestInstructions = onCall((request) => invoke(() => setProjectTestInstructions(db, actor(request), request.data)));
export const memberChange = onCall((request) => invoke(() => changeMemberRole(db, actor(request), request.data)));
export const testDraftCreate = onCall((request) => invoke(() => createTestDraft(db, actor(request), request.data)));
export const testDraftSave = onCall((request) => invoke(() => saveTestDraft(db, actor(request), request.data)));
export const testDraftPublish = onCall((request) => invoke(() => publishTestDraft(db, actor(request), request.data)));
export const testPortableImport = onCall((request) => invoke(() => importPortableTest(db, actor(request), request.data)));
export const testLocalAttemptRecord = onCall((request) => invoke(() => recordLocalTestAttempt(db, actor(request), request.data)));
export const runLocalSnapshotRecord = onCall((request) => invoke(() => recordLocalRun(db, actor(request), request.data)));
export const runLocalAuthorize = onCall((request) => invoke(() => authorizeLocalRun(db, actor(request), request.data)));
export const managedFixDecide = onCall((request) => invoke(() => decideManagedFix(db, actor(request), request.data)));
export const managedFixApplyAuthorize = onCall((request) => invoke(() => authorizeManagedFixApply(db, actor(request), request.data)));
export const managedFixReadAuthorize = onCall((request) => invoke(() => authorizeManagedFixRead(db, actor(request), request.data)));
export const applicationFixReadAuthorize = onCall((request) => invoke(() => authorizeApplicationFixRead(db, actor(request), request.data)));
export const applicationFixDecide = onCall((request) => invoke(() => decideApplicationFix(db, actor(request), request.data)));
export const applicationFixApplyAuthorize = onCall((request) => invoke(() => authorizeApplicationFixApply(db, actor(request), request.data)));
export const applicationFixAppliedRecord = onCall((request) => invoke(() => recordApplicationFixApplied(db, actor(request), request.data)));
export const managedFixAppliedRecord = onCall((request) => invoke(() => recordManagedFixApplied(db, actor(request), request.data)));
export const testArchive = onCall((request) => invoke(() => archiveTest(db, actor(request), request.data)));
export const testRename = onCall((request) => invoke(() => renameTest(db, actor(request), request.data)));
export const testVersionSave = onCall((request) => invoke(() => savePatrolTestVersion(db, actor(request), request.data)));
export const suiteSave = onCall((request) => invoke(() => saveSuite(db, actor(request), request.data)));
export const suiteMoveTest = onCall((request) => invoke(() => moveTestToSuite(db, actor(request), request.data)));
export const testComment = onCall((request) => invoke(() => commentOnTest(db, actor(request), request.data)));
export const testReviewerAssign = onCall((request) => invoke(() => assignTestReviewer(db, actor(request), request.data)));
export const recordingShareBegin = onCall((request) => invoke(() => beginRecordingShare(db, actor(request), request.data)));
function bucketName() { return getApp().options.storageBucket ?? `${process.env.GCLOUD_PROJECT ?? 'demo-sayspec-local'}.appspot.com`; }
async function objectMetadata(objectPath: string) {
  try {
    const [metadata] = await getStorage().bucket(bucketName()).file(objectPath).getMetadata();
    const custom = metadata.metadata ?? {};
    return {
      byteLength: Number(metadata.size),
      sha256: typeof custom.sha256 === 'string' ? custom.sha256 : undefined,
      organizationId: typeof custom.organizationId === 'string' ? custom.organizationId : undefined,
      projectId: typeof custom.projectId === 'string' ? custom.projectId : undefined,
    };
  } catch (error) {
    if ((error as { code?: number }).code === 404) return null;
    throw error;
  }
}
export const projectDelete = onCall((request) => invoke(async () => {
  const result = await deleteProject(db, actor(request), request.data);
  await getStorage().bucket(bucketName()).deleteFiles({ prefix: `organizations/${request.data.organizationId}/projects/${result.projectId}/` })
    .catch((error) => logger.warn('project storage cleanup failed', { organizationId: request.data.organizationId, projectId: result.projectId, error: String(error) }));
  return result;
}));
export const recordingShareFinalize = onCall((request) => invoke(() => finalizeRecordingShare(db, actor(request), request.data, objectMetadata)));
export const flutterSliceShareBegin = onCall((request) => invoke(() => beginFlutterSliceShare(db, actor(request), request.data)));
export const flutterSliceShareFinalize = onCall((request) => invoke(() => finalizeFlutterSliceShare(db, actor(request), request.data, objectMetadata)));
export const flutterSliceShareRead = onCall((request) => invoke(() => readFlutterSliceShare(db, actor(request), request.data)));
export const narrationTranscribe = onCall({ maxInstances: transcriptionMaxInstances, concurrency: 10, cpu: 1, memory: '1GiB', timeoutSeconds: 540 }, (request) => invoke(() => transcribeNarration(db, actor(request), request.data, {
  transcribe: emulatedTranscription ? emulatorTranscriber : vertexGeminiTranscriber({ projectId: process.env.GCLOUD_PROJECT ?? getApp().options.projectId ?? '', location: transcriptionLocation.value(), model: transcriptionModel.value() }),
  model: emulatedTranscription ? 'emulator' : transcriptionModel.value(), monthlyMinutes: transcriptionMonthlyMinutes.value(),
})));
