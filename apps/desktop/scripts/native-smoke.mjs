import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';

const cwd = new URL('..', import.meta.url).pathname;
const executable = process.env.SAYSPEC_EXECUTABLE || electron;
const executableArguments = process.env.SAYSPEC_EXECUTABLE ? [] : ['.'];

/**
 * Per-flow budget. The guest walkthrough now creates a project, visits every
 * tab and waits on real local services, so a fixed 20 s budget was measuring
 * the machine rather than the product. Negative cases that must exit quickly
 * keep a short budget.
 */
function smokeBudget(env) {
  if (env.SAYSPEC_SETUP_SMOKE === '1') return 900_000;
  if (env.SAYSPEC_RECORDING_SMOKE === '1' || env.SAYSPEC_SETTINGS_SMOKE === '1' || env.SAYSPEC_LIBRARY_SMOKE === '1' || env.SAYSPEC_PROJECT_GATE_SMOKE === '1' || env.SAYSPEC_RECORDING_SHARE_SMOKE === '1' || env.SAYSPEC_WORKSPACE_SMOKE === '1') return 180_000;
  if (env.SAYSPEC_FORCE_MISSING_RENDERER === '1' || env.SAYSPEC_FORCE_MISSING_PRELOAD === '1') return 30_000;
  return 90_000;
}

async function runElectron(extraEnv = {}) {
  const isolatedUserData = process.env.SAYSPEC_AUTH_PERSIST_PHASE || process.env.SAYSPEC_RECORDING_PERSIST_PHASE ? undefined : await mkdtemp(path.join(tmpdir(), 'sayspec-native-'));
  try { return await new Promise((resolve, reject) => {
    const child = spawn(executable, executableArguments, {
      cwd,
      env: {
        ...process.env,
        SAYSPEC_TEST_MODE: '1',
        SAYSPEC_NATIVE_SMOKE: '1',
        ...(isolatedUserData ? { SAYSPEC_TEST_USER_DATA: isolatedUserData } : {}),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Electron smoke timed out. Output:\n${output}`));
    }, smokeBudget({ ...process.env, ...extraEnv }));
    if (process.env.SAYSPEC_SMOKE_DEBUG === '1') console.log(`SMOKE_DEBUG spawn pid=${child.pid} exec=${executable} args=${JSON.stringify(executableArguments)} cwd=${cwd}`);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  }); } finally { if (isolatedUserData) await rm(isolatedUserData, { recursive: true, force: true }); }
}

const nominal = await runElectron(process.env.SAYSPEC_AUTH_SMOKE === '1' ? {} : { SAYSPEC_GUEST_SMOKE: '1' });
assert.equal(nominal.code, 0, `signal=${nominal.signal ?? 'none'}\n${nominal.output}`);
const resultLine = nominal.output.split('\n').find((line) => line.startsWith('SAYSPEC_SMOKE_RESULT='));
assert.ok(resultLine, nominal.output);
const result = JSON.parse(resultLine.slice('SAYSPEC_SMOKE_RESULT='.length));
assert.equal(result.setupError, undefined, JSON.stringify(result));
assert.deepEqual(result.bridgeKeys, ["analyzeSavedWebFailure", "appendFlutterNarration", "appendRecordingAudio", "applyApplicationFix", "applyFlutterIntegration", "applyManagedFix", "applyPatrolTestFix", "attachPatrolRunAnalysis", "attachPatrolRunConsole", "beginFlutterNarration", "beginRecordingSegment", "cancelFailureAnalysis", "cancelFlutterCapture", "cancelLocalTranscriptionModelInstall", "cancelMachineSetupInstall", "cancelPatrolRun", "cancelPlaywrightGeneration", "cancelRecording", "cancelRecordingTranscription", "cancelSavedWebRun", "cancelSavedWebTest", "checkCodingAgentReadiness", "checkFlutterRecorderSdk", "checkMachineSetup", "checkReadiness", "chooseSourceDirectory", "chooseTestStorageFolder", "closeApplicationFixSession", "closeClaudeTerminal", "closeMachineSetupAgent", "closeManagedFixSession", "closePatrolGeneration", "commitGitChanges", "configureTestStorage", "createLocalProject", "createPatrolRun", "createSavedWebRun", "decideApplicationFix", "decideManagedFix", "decidePatrolTestFix", "deleteLibraryTest", "deleteLocalProject", "deleteLocalTest", "deletePatrolRun", "exportSavedWebTest", "exportTestLibrary", "finishFlutterNarration", "generatePlaywrightDraft", "getActiveFlutterCapture", "getAppInfo", "getCodingAgentPreference", "getFlutterCapture", "getGitView", "getLocalRecording", "getLocalTranscriptionSetup", "getLocalWorkspace", "getMachineSetup", "getMachineSetupJob", "getProjectEntryPoints", "getRememberedSourceDirectory", "getTestInstructions", "getTestLibrary", "getTestStorage", "importTestLibrary", "importWebTest", "installLocalTranscriptionModel", "interruptRecording", "listApplicationFixProposals", "listFailureAnalyses", "listFlutterCaptures", "listFlutterDevices", "listLocalRecordings", "listManagedFixProposals", "listPatrolAttempts", "listPatrolLeases", "listPatrolRuns", "listPatrolTestFixProposals", "listPatrolTestVersions", "listPatrolTests", "listPendingCloudPatrolTests", "listProjectWebTestVersions", "listSavedWebRuns", "listSavedWebTestAttempts", "listSavedWebTestVersions", "markCloudPatrolTestUploaded", "moveLibraryTest", "moveLocalTestToSuite", "onApplicationFixTerminalEvent", "onClaudeTerminalEvent", "onFlutterCaptureLaunchLog", "onFlutterCaptureLifecycle", "onLocalTranscriptionLifecycle", "onMachineSetupAgentEvent", "onMachineSetupEvent", "onManagedFixTerminalEvent", "onPatrolGenerationEvent", "onPatrolRunAnalysisEvent", "onPatrolRunConsole", "onPlaywrightGenerationLifecycle", "onProjectEntryPointsChanged", "onRecordingLifecycle", "openAccountPortal", "openGitPullRequest", "openPatrolRunReport", "pauseFlutterCapture", "pauseRecording", "planMachineSetupInstall", "preparePatrolIssueFix", "previewFlutterIntegration", "previewWebTestImport", "pullCloudPatrolTests", "pushGitCommit", "readApplicationFixReceipt", "readFlutterCaptureNarration", "readFlutterCaptureScreenshot", "readPatrolArtifact", "readPatrolRunLog", "readRecordingAsset", "readSavedWebTestArtifact", "rememberSourceDirectory", "removeLocalTranscriptionModel", "renameLibraryTest", "renameLocalTest", "requestMicrophoneAccess", "rerunApplicationFix", "resizeApplicationFixSession", "resizeClaudeTerminal", "resizeMachineSetupAgent", "resizeManagedFixSession", "resizePatrolGeneration", "resizePatrolRunAnalysis", "restartPatrolRunAnalysis", "resumeFlutterCapture", "resumeRecording", "retrySavedWebRunItem", "revealTestInstructions", "revealTestStorageFolder", "runPatrolTest", "runSavedWebTest", "saveLibrarySuite", "saveLocalSuite", "saveProjectEntryPoints", "saveRecordingIntent", "saveTranscriptEdits", "selectCodingAgentProvider", "setFlutterCaptureShareState", "setRecordingShareState", "setTestAuthor", "startApplicationFixSession", "startClaudeTerminal", "startFlutterCapture", "startFlutterDevice", "startMachineSetupAgent", "startMachineSetupInstall", "startManagedFixSession", "startPatrolGeneration", "startPatrolRun", "startPatrolTestFixSession", "startSavedWebRun", "startWebRecording", "stopFlutterCapture", "stopPatrolRun", "stopRecording", "syncCloudTestInstructions", "transcribeFlutterCapture", "transcribeRecording", "writeApplicationFixSession", "writeClaudeTerminal", "writeMachineSetupAgent", "writeManagedFixSession", "writePatrolGeneration", "writePatrolRunAnalysis"]);
assert.equal(result.info.name, 'SaySpec');
if (process.env.SAYSPEC_PACKAGED_VALIDATION_SMOKE === '1') assert.equal(result.packagedValidation?.status, 'passed', JSON.stringify(result.packagedValidation));
assert.equal(result.nodeAccess, false);
assert.equal(result.recordFirst, true, JSON.stringify(result));
assert.equal(result.manualAuthoringAbsent, true, JSON.stringify(result));
assert.equal(result.reducedMotionRule, true);
assert.equal(result.zoomLayout.rootOverflow, false);
assert.equal(result.noFooter, true);
if (result.topbarHeight) assert.ok(result.topbarHeight <= 50, JSON.stringify(result));
assert.deepEqual(result.navSections, []);
if (result.sidebarRuntime) assert.match(result.sidebarRuntime, process.env.SAYSPEC_AUTH_SMOKE === '1' ? /SaySpec 0\.0\.1Cloud workspace/ : /SaySpec 0\.0\.1(Guest workspace · local|Local workspace)/);
if (!process.env.SAYSPEC_AUTH_SMOKE) assert.equal(result.entryGate, true);
if (!process.env.SAYSPEC_AUTH_SMOKE) {
  assert.equal(result.guestFlow.gateVisible, process.env.SAYSPEC_RECORDING_PERSIST_PHASE === 'restore' ? false : true, JSON.stringify(result.guestFlow));
  assert.equal(result.guestFlow.webSourceOptional, true, JSON.stringify(result.guestFlow));
  assert.equal(result.guestFlow.enteredShell, true, JSON.stringify(result.guestFlow));
  assert.equal(result.guestFlow.localLibrary, true, JSON.stringify(result.guestFlow));
  assert.equal(result.guestFlow.savedRuns, true, JSON.stringify(result.guestFlow));
  assert.match(result.guestFlow.localScope, /ProjectLocal guest app/);
}
if (process.env.SAYSPEC_AUTH_SMOKE === '1') {
  if (process.env.SAYSPEC_AUTH_PERSIST_PHASE === 'sign-in') assert.deepEqual(result.authFlow, { persistedSignIn: true });
  else if (process.env.SAYSPEC_AUTH_PERSIST_PHASE === 'restore') assert.deepEqual(result.authFlow, { restored: true, signedOut: true });
  else if (process.env.SAYSPEC_SETTINGS_SMOKE === '1' || process.env.SAYSPEC_LIBRARY_SMOKE === '1' || process.env.SAYSPEC_PROJECT_GATE_SMOKE === '1' || process.env.SAYSPEC_RECORDING_SHARE_SMOKE === '1') assert.deepEqual(result.authFlow, { canceled: true, signedIn: true, signedOut: false, selectionCleared: false });
  else assert.deepEqual(result.authFlow, { canceled: true, signedIn: true, signedOut: true, selectionCleared: true });
}
if (process.env.SAYSPEC_WORKSPACE_SMOKE === '1') {
  assert.equal(result.workspaceFlow.organizationCount, 2, JSON.stringify(result.workspaceFlow));
  assert.equal(result.workspaceFlow.projectSwitched, true, JSON.stringify(result.workspaceFlow));
  assert.equal(result.workspaceFlow.projectSelectionCleared, true, JSON.stringify(result.workspaceFlow));
  assert.equal(result.workspaceFlow.organizationSwitched, true, JSON.stringify(result.workspaceFlow));
  assert.equal(result.workspaceFlow.rivalProjectLoaded, true, JSON.stringify(result.workspaceFlow));
  assert.match(result.workspaceFlow.scopeLabel, /Rival app · flutter/);
  assert.deepEqual(result.workspaceRevocation, { visible: true, organizationCleared: true, projectCleared: true, signedOut: true, selectionCleared: true });
}
if (process.env.SAYSPEC_PROJECT_GATE_SMOKE === '1') {
  assert.deepEqual(result.projectGateFlow, { gateVisible: true, flutterRequiresSource: true, sourceSelected: true, enteredShell: true, heading: 'Record' });
}
if (process.env.SAYSPEC_SETTINGS_SMOKE === '1') {
  assert.deepEqual(result.settingsFlow, { invalidUrlVisible: true, sourceSelected: true, readinessReady: true, aiSelected: true, aiSettingsCompact: true, modelDefault: true, geminiGated: true, sharedSaved: true, createdProject: true, projectIndexed: true, heading: 'Settings' });
}
if (process.env.SAYSPEC_LIBRARY_SMOKE === '1') {
  assert.deepEqual(result.libraryFlow, { published: true, authorVisible: true, compactTable: true, recordInAppbar: true, emptyRow: true, renamed: true, deleted: true, recordNavigation: true, manualAuthoringAbsent: true, heading: 'Record' });
}
if (process.env.SAYSPEC_RECORDING_SMOKE === '1') {
  if (result.recordingFlow?.error) throw new Error(JSON.stringify(result.recordingFlow));
  if (process.env.SAYSPEC_RECORDING_PERSIST_PHASE === 'restore') {
    assert.equal(result.recordingFlow.reopened, true, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.audio, true, JSON.stringify(result.recordingFlow));
    assert.ok(result.recordingFlow.audioReadyState >= 1, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.audioError, null, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.alignedSeek, true, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.firstScreenCaptured, true, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.screenshot, true, JSON.stringify(result.recordingFlow));
    assert.ok(result.recordingFlow.eventCount >= 3, JSON.stringify(result.recordingFlow));
    if (process.env.SAYSPEC_TRANSCRIPTION_SMOKE === '1') {
      assert.equal(result.recordingFlow.transcriptReopened, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.formAbsent, true, JSON.stringify(result.recordingFlow));
    }
    if (process.env.SAYSPEC_GENERATION_SMOKE === '1') {
      assert.equal(result.recordingFlow.generationReopened, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.generatedSourceReopened, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.localTestReopened, true, JSON.stringify(result.recordingFlow));
    }
  } else if (process.env.SAYSPEC_RECORDING_PERSIST_PHASE === 'denied') {
    assert.deepEqual(result.recordingFlow, { denied: true, captureAbsent: true, recordingCount: 0 });
  } else {
    assert.deepEqual({ started: result.recordingFlow.started, recording: result.recordingFlow.recording, paused: result.recordingFlow.paused, resumed: result.recordingFlow.resumed, reviewed: result.recordingFlow.reviewed, audio: result.recordingFlow.audio, screenshot: result.recordingFlow.screenshot }, { started: true, recording: true, paused: true, resumed: true, reviewed: true, audio: true, screenshot: true });
    assert.equal(result.recordingFlow.firstReviewed, true, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.claudeTab, true, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.resetReady, true, JSON.stringify(result.recordingFlow));
    assert.ok(result.recordingFlow.audioReadyState >= 1, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.audioError, null, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.alignedSeek, true, JSON.stringify(result.recordingFlow));
    assert.equal(result.recordingFlow.firstScreenCaptured, true, JSON.stringify(result.recordingFlow));
    if (process.env.SAYSPEC_RECORDING_SHARE_SMOKE === '1') {
      assert.equal(result.recordingFlow.sharingChoice, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.shared, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.recordingCount, 1, JSON.stringify(result.recordingFlow));
    } else {
      assert.equal(result.recordingFlow.secondStarted, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.secondReviewed, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.recordingCount, 2, JSON.stringify(result.recordingFlow));
    }
    assert.ok(result.recordingFlow.eventCount >= 3, JSON.stringify(result.recordingFlow));
    if (process.env.SAYSPEC_TRANSCRIPTION_SMOKE === '1') {
      assert.equal(result.recordingFlow.transcriptReady, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.formAbsent, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.modelSelected, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.disclosureAbsent, true, JSON.stringify(result.recordingFlow));
    }
    if (process.env.SAYSPEC_GENERATION_SMOKE === '1') {
      assert.equal(result.recordingFlow.claudeTerminalSized, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.aiSelectedInRecord, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.aiLogoInRecord, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.aiOverrideWorks, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.generationReady, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.generationUnvalidated, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.generationEvidenceLinked, true, JSON.stringify(result.recordingFlow));
      assert.equal(result.recordingFlow.localTestSaved, true, JSON.stringify(result.recordingFlow));
    }
  }
}

const missingRenderer = await runElectron({ SAYSPEC_FORCE_MISSING_RENDERER: '1' });
assert.notEqual(missingRenderer.code, 0, missingRenderer.output);
assert.match(missingRenderer.output, /SAYSPEC_STARTUP_FAILURE=renderer-load:/);

const missingPreload = await runElectron({ SAYSPEC_FORCE_MISSING_PRELOAD: '1' });
assert.notEqual(missingPreload.code, 0, missingPreload.output);
assert.match(missingPreload.output, /SAYSPEC_STARTUP_FAILURE=preload:/);

const occupiedPort = createServer();
let ownsOccupiedPort = false;
await new Promise((resolve, reject) => {
  occupiedPort.once('error', (error) => error.code === 'EADDRINUSE' ? resolve() : reject(error));
  occupiedPort.listen(5173, '127.0.0.1', () => { ownsOccupiedPort = true; resolve(); });
});
try {
  const dev = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    if (process.env.SAYSPEC_SMOKE_DEBUG === '1') console.log(`SMOKE_DEBUG spawn pid=${child.pid} exec=${executable} args=${JSON.stringify(executableArguments)} cwd=${cwd}`);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, output }); });
  });
  assert.notEqual(dev.code, 0, dev.output);
  assert.match(dev.output, /failed to start|already in use/i);
} finally {
  if (ownsOccupiedPort) await new Promise((resolve) => occupiedPort.close(resolve));
}

console.log(JSON.stringify({
  nativeBridge: 'passed',
  missingRenderer: 'reported',
  missingPreload: 'reported',
  occupiedDevPort: 'rejected',
}));
