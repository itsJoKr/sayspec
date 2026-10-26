import { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences, type OpenDialogOptions } from 'electron';
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AppInfo, CloudPatrolTestVersion, CodingAgentProviderId, CreateLocalProjectInput, PortableLibrary, SuiteChange, WebRecordingStartInput } from '@sayspec/contracts';
import { validateEntryPoints } from '@sayspec/contracts';
import { accountPortalUrl, isTrustedMainFrame, rendererFileUrl } from './security';
import { authorizeFixDecision, type FixDecision } from './cloud-fix-authority';
import { DirectoryHandleRegistry } from './jobs/directory-handles';
import { RememberedSourceStore } from './jobs/remembered-sources';
import { ProjectEntryPointStore } from './jobs/entry-points';
import { LocalJobManager } from './jobs/local-job-manager';
import { checkMachineReadiness } from './machine-resources';
import { LocalWorkspaceStore } from './local-workspace';
import { RecordingStore } from './recording-store';
import { RecordingManager } from './recording-manager';
import { LocalModelManager } from './transcription/model-manager';
import { CLOUD_TRANSCRIPTION_PROVIDER, createTranscriptionProvider, DEFAULT_TRANSCRIPTION_PROVIDER, type TranscriptionProvider, type TranscriptionStartOptions } from './transcription/provider';
import { PlaywrightGenerationManager } from './generation/playwright-generation';
import { SavedWebTestStore } from './execution/saved-web-tests';
import { FailureAnalysisManager } from './execution/failure-analysis';
import { ManagedTestFixSessionManager } from './execution/managed-test-fix-session';
import { patrolTestFixSubject } from './flutter/patrol-test-fix';
import { ApplicationFixStore } from './execution/application-fix';
import { ApplicationFixSessionManager } from './execution/application-fix-session';
import { startPatchedWebServer } from './execution/local-web-rerun';
import { validatePlaywrightCandidate } from './generation/playwright-validation';
import { CodingAgentAdapters } from './coding-agent/adapters';
import { ClaudeTerminalManager } from './coding-agent/claude-terminal';
import { ProjectAgentWorkspaceManager } from './coding-agent/project-agent-workspace';
import { CodingAgentPreferenceManager, CodingAgentPreferenceStore } from './coding-agent/preferences';
import { MachineSetupManager } from './setup/manager';
import { MachineSetupAgentTerminalManager } from './setup/setup-agent-terminal';
import { FlutterCaptureStore } from './flutter/capture-store';
import { FlutterCaptureSessionManager } from './flutter/session-manager';
import { previewFlutterIntegration, applyFlutterIntegration, resolveProjectDependencies } from './flutter/integration';
import { PatrolRunStore } from './flutter/patrol-store';
import { PatrolRunner } from './flutter/patrol-runner';
import { PatrolRunAnalysisManager } from './flutter/patrol-run-analysis';
import { PatrolGenerationTerminalManager } from './flutter/patrol-generation-terminal';
import { CloudUploadQueue } from './test-storage/cloud-upload-queue';
import { GitWorkspace } from './git/git-workspace';
import { parseGitTarget, resolveGitTarget } from './git/git-targets';
import { commonToolDirectories, loginShell, resolveTool } from './setup/environment';
import { TestStorage } from './test-storage/test-storage';
import { TestStorageSettingsStore } from './test-storage/test-storage-settings';
import { TestInstructions } from './test-storage/test-instructions';
import { startUpdateChecks } from './updates';

const devUrl = !app.isPackaged && process.env.SAYSPEC_DEV === '1'
  ? 'http://127.0.0.1:5173' : undefined;
const testMode = process.env.SAYSPEC_TEST_MODE === '1';
// Git and the GitHub CLI are the user's own; a tool that is missing is looked for again a minute later.
const gitTools = new Map<string, { at: number; path?: string; found: Promise<string | undefined> }>();
function gitTool(name: 'git' | 'gh') {
  // Test runs never reach the real GitHub CLI: they name a stand-in, or have none.
  if (testMode && name === 'gh') return Promise.resolve(process.env.SAYSPEC_TEST_GH || undefined);
  const cached = gitTools.get(name);
  if (cached && (cached.path || Date.now() - cached.at < 60_000)) return cached.found;
  const found = resolveTool({ name, skipVersion: true, timeoutMs: 10_000 }).then((tool) => {
    const location = tool.found ? tool.path : undefined;
    gitTools.set(name, { at: Date.now(), path: location, found: Promise.resolve(location) });
    return location;
  });
  gitTools.set(name, { at: Date.now(), found });
  return found;
}
// Hooks and credential helpers expect the user's login PATH, which an app opened from the Dock does not have.
let gitPath: Promise<string> | undefined;
async function gitEnvironment(): Promise<NodeJS.ProcessEnv> {
  gitPath ??= loginShell('printf %s "$PATH"', { timeoutMs: 10_000 }).then((result) => [...new Set([...(result.code === 0 ? result.stdout.trim().split(':') : []), ...(process.env.PATH ?? '').split(':'), ...commonToolDirectories()].filter(Boolean))].join(':'));
  return { ...process.env, PATH: await gitPath };
}
if (testMode && process.env.SAYSPEC_RECORDING_SMOKE === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (process.env.SAYSPEC_TEST_AUDIO_FILE) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.SAYSPEC_TEST_AUDIO_FILE);
    if (process.env.SAYSPEC_TRANSCRIPTION_SMOKE === '1') app.commandLine.appendSwitch('no-sandbox');
  }
}
if (testMode && process.env.SAYSPEC_TEST_USER_DATA) app.setPath('userData', process.env.SAYSPEC_TEST_USER_DATA);
const rendererPath = testMode && process.env.SAYSPEC_FORCE_MISSING_RENDERER === '1'
  ? path.join(__dirname, '../dist/missing-index.html')
  : path.join(__dirname, '../dist/index.html');
const preloadPath = testMode && process.env.SAYSPEC_FORCE_MISSING_PRELOAD === '1'
  ? path.join(__dirname, 'missing-preload.cjs')
  : path.join(__dirname, 'preload.cjs');
const rendererUrl = devUrl ? new URL(devUrl).href : rendererFileUrl(rendererPath);
let shuttingDown = false;
let shutdownComplete = false;
let localJobs: LocalJobManager | undefined;
let localWorkspace: LocalWorkspaceStore | undefined;
let recordingStore: RecordingStore | undefined;
let recordingManager: RecordingManager | undefined;
let localModels: LocalModelManager | undefined;
let localTranscription: TranscriptionProvider | undefined;
// Gemini through the cloud backend; only in builds that have one.
let cloudTranscription: TranscriptionProvider | undefined;
let playwrightGeneration: PlaywrightGenerationManager | undefined;
let savedWebTests: SavedWebTestStore | undefined;
let failureAnalysis: FailureAnalysisManager | undefined;
let managedFixSessions: ManagedTestFixSessionManager | undefined;
let applicationFixes: ApplicationFixStore | undefined;
let gitWorkspace: GitWorkspace | undefined;
let applicationFixSessions: ApplicationFixSessionManager | undefined;
let codingAgentPreferences: CodingAgentPreferenceManager | undefined;
let claudeTerminal: ClaudeTerminalManager | undefined;
let machineSetup: MachineSetupManager | undefined;
let machineSetupAgent: MachineSetupAgentTerminalManager | undefined;
let flutterCaptures: FlutterCaptureStore | undefined;
let flutterSessions: FlutterCaptureSessionManager | undefined;
let patrolRuns: PatrolRunStore | undefined;
let patrolRunner: PatrolRunner | undefined;
let patrolRunAnalysis: PatrolRunAnalysisManager | undefined;
let patrolGeneration: PatrolGenerationTerminalManager | undefined;
let testStorage: TestStorage | undefined;
let testInstructions: TestInstructions | undefined;
let microphoneGrantUntil = 0;
let appliedRecordFailuresRemaining = Number(process.env.SAYSPEC_TEST_FAIL_APPLIED_RECORD_COUNT ?? '1');
const selectedDirectories = new DirectoryHandleRegistry();
let rememberedSources: RememberedSourceStore | undefined;
let entryPoints: ProjectEntryPointStore | undefined;
// Fixed at build time from the build environment (scripts/build-electron.mjs); empty in local-only builds.
declare const __SAYSPEC_CLOUD_FUNCTIONS_URL__: string;
declare const __SAYSPEC_ACCOUNT_PORTAL_ORIGIN__: string;

/** Gemini when the renderer passes a cloud scope, otherwise local Whisper. */
async function transcriptionFor(id: string, cloud: unknown): Promise<{ provider: TranscriptionProvider; options?: TranscriptionStartOptions }> {
  if (cloud === undefined) return { provider: localTranscription! };
  if (!cloudTranscription) throw new Error('This build has no cloud backend for Gemini transcription.');
  // Replaces the automatic local transcription that may still run after a recording stops.
  if (localTranscription!.running(id)) await localTranscription!.cancel(id);
  return { provider: cloudTranscription, options: { cloud: cloud as TranscriptionStartOptions['cloud'] } };
}

async function callManagedFixBackend(name: FixDecision, idToken: unknown, data: unknown) {
  if (typeof idToken !== 'string' || !idToken || idToken.length > 16_384) throw new Error('Sign in again before deciding on a Pro fix.');
  // Test-only injection: fails the Pro receipt after the local immutable
  // version already exists, to exercise mid-apply interruption recovery.
  if (testMode && process.env.SAYSPEC_TEST_FAIL_APPLIED_RECORD === '1' && name === 'managedFixAppliedRecord' && appliedRecordFailuresRemaining > 0) {
    appliedRecordFailuresRemaining -= 1;
    throw new Error('The applied-version receipt could not be recorded (injected interruption).');
  }
  return authorizeFixDecision(__SAYSPEC_CLOUD_FUNCTIONS_URL__, name, idToken, data);
}

function reportStartupFailure(kind: string, error: unknown) {
  const detail = error instanceof Error ? (testMode && error.stack ? error.stack : error.message) : String(error);
  console.error(`SAYSPEC_STARTUP_FAILURE=${kind}:${detail}`);
  if (!testMode) dialog.showErrorBox('SaySpec could not start', `${kind}: ${detail}`);
}

async function revokeNativeSmokeMembership() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const base = `http://${host}/v1/projects/demo-sayspec-local/databases/(default)/documents`;
  const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const member = await fetch(`${base}/organizations/org_rival/members/user_tester?updateMask.fieldPaths=status`, {
    method: 'PATCH', headers, body: JSON.stringify({ fields: { status: { stringValue: 'revoked' } } }),
  });
  const projectScope = await fetch(`${base}/userScopes/user_tester/organizations/org_rival/projects/project_rival`, { method: 'DELETE', headers });
  const organizationScope = await fetch(`${base}/userScopes/user_tester/organizations/org_rival`, { method: 'DELETE', headers });
  if (!member.ok || !projectScope.ok || !organizationScope.ok) throw new Error(`Revocation fixture failed: ${member.status}/${projectScope.status}/${organizationScope.status}`);
}

async function runNativeSmoke(window: BrowserWindow) {
  if (!testMode || process.env.SAYSPEC_NATIVE_SMOKE !== '1') return;
  let smokeStage = 'setup';
  try {
    const setup = await window.webContents.executeJavaScript(`(async () => { try {
      const waitFor = async (predicate) => { for (let attempt = 0; attempt < 400; attempt += 1) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
      const setInput = (element, value) => { if (!element) throw new Error('Native smoke input was not found.'); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
      const info = await window.sayspec.getAppInfo();
      const nodeAccess = typeof require !== 'undefined' || typeof process !== 'undefined';
      const entryGate = Boolean(document.querySelector('[data-testid="entry-gate"]'));
      let authFlow = null; let workspaceFlow = null; let projectGateFlow = null; let guestFlow = null;
      if (${process.env.SAYSPEC_GUEST_SMOKE === '1'}) {
        // A local-only build has no account gate and opens the local workspace directly.
        const entry = await waitFor(() => document.querySelector('[data-testid="continue-guest"], [data-testid="local-project-gate"], nav'));
        const guestButton = entry?.matches('[data-testid="continue-guest"]') ? entry : null;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        guestButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        document.querySelector('[data-testid="continue-guest"]')?.click();
        const restoreRecording = ${JSON.stringify(process.env.SAYSPEC_RECORDING_PERSIST_PHASE ?? '')} === 'restore';
        const gateVisible = restoreRecording ? false : Boolean(await waitFor(() => document.querySelector('[data-testid="local-project-gate"]')));
        let webSourceOptional = true;
        if (!restoreRecording) {
          setInput(document.querySelector('#field-project-name'), 'Local guest app');
          setInput(document.querySelector('#field-base-url'), 'http://127.0.0.1:3000');
          webSourceOptional = document.querySelector('[data-testid="local-project-create"]')?.disabled === false;
          document.querySelector('[data-testid="local-project-create"]')?.click();
          (await waitFor(() => document.querySelector('[data-testid="onboarding-finish"]')))?.click();
        }
        const enteredShell = Boolean(await waitFor(() => document.querySelector('nav') && document.querySelector('h1')?.textContent === 'Record'));
        [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Tests')?.click();
        const localLibrary = Boolean(await waitFor(() => document.querySelector('.test-library') && document.querySelector('.topbar-actions [data-testid="record-test"]') && !document.querySelector('.test-library h2')));
        [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Runs')?.click();
        // The Runs view must render its import control and an honest empty or
        // populated state. The previous assertion matched copy that moved to the
        // Pro review panel, which made this check silently stale.
        const savedRuns = Boolean(await waitFor(() => {
          const runs = document.querySelector('.saved-runs');
          if (!runs?.querySelector('input[type="file"]')) return false;
          return Boolean(runs.querySelector('.run-browser') || runs.querySelector('h3'));
        }));
        [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Record')?.click();
        guestFlow = { gateVisible, webSourceOptional, enteredShell, localLibrary, savedRuns, localScope: document.querySelector('.workspace-switcher')?.textContent };
      }
      if (${process.env.SAYSPEC_AUTH_SMOKE === '1'}) {
        const persistencePhase = ${JSON.stringify(process.env.SAYSPEC_AUTH_PERSIST_PHASE ?? '')};
        if (persistencePhase === 'restore') {
          const restored = Boolean(await waitFor(() => document.body.textContent.includes('tester@sayspec.local')));
          [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Sign out')?.click();
          const signedOut = Boolean(await waitFor(() => document.body.textContent.includes('Continue as guest')));
          authFlow = { restored, signedOut };
        } else if (persistencePhase === 'sign-in') {
          (await waitFor(() => [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Sign in'))))?.click();
          (await waitFor(() => document.querySelector('.auth-form button[type="submit"]')))?.click();
          const persistedSignIn = Boolean(await waitFor(() => document.body.textContent.includes('tester@sayspec.local')));
          authFlow = { persistedSignIn };
        } else {
          let signInTrigger = await waitFor(() => [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Sign in')));
          signInTrigger?.click();
          (await waitFor(() => [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent.trim() === 'Cancel')))?.click();
          const canceled = Boolean(await waitFor(() => !document.querySelector('[role="dialog"]') && document.activeElement === signInTrigger));
          signInTrigger = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Sign in')); signInTrigger?.click();
          (await waitFor(() => document.querySelector('.auth-form button[type="submit"]')))?.click();
          const signedIn = Boolean(await waitFor(() => document.body.textContent.includes('tester@sayspec.local')));
          if (${process.env.SAYSPEC_WORKSPACE_SMOKE === '1' || process.env.SAYSPEC_SETTINGS_SMOKE === '1' || process.env.SAYSPEC_LIBRARY_SMOKE === '1' || process.env.SAYSPEC_PROJECT_GATE_SMOKE === '1' || process.env.SAYSPEC_RECORDING_SHARE_SMOKE === '1'}) {
            await waitFor(() => document.querySelector('nav') || document.querySelector('[data-testid="project-gate"]'));
          }

          if (${process.env.SAYSPEC_PROJECT_GATE_SMOKE === '1'}) {
            const nameField = await waitFor(() => document.querySelector('[data-testid="project-gate"] #field-project-name'));
            const gateVisible = Boolean(nameField);
            setInput(nameField, 'Recorded mobile app');
            const technology = await waitFor(() => document.querySelector('[data-testid="project-gate"] select[aria-label="Project technology"]')); technology.value = 'flutter'; technology.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const flutterRequiresSource = document.querySelector('[data-testid="project-create"]')?.disabled === true;
            [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Choose folder')?.click();
            const sourceSelected = Boolean(await waitFor(() => !document.querySelector('.source-name')?.textContent.includes('No folder')));
            document.querySelector('[data-testid="project-create"]')?.click();
            (await waitFor(() => document.querySelector('[data-testid="onboarding-finish"]')))?.click();
            const enteredShell = Boolean(await waitFor(() => document.querySelector('nav') && document.querySelector('h1')?.textContent === 'Record'));
            projectGateFlow = { gateVisible, flutterRequiresSource, sourceSelected, enteredShell, heading: document.querySelector('h1')?.textContent };
          }

          if (${process.env.SAYSPEC_WORKSPACE_SMOKE === '1'}) {
            const organization = await waitFor(() => { const select = document.querySelector('select[aria-label="Organization"]'); return select?.value === 'org_northstar' ? select : null; });
            const project = await waitFor(() => { const select = document.querySelector('select[aria-label="Project"]'); return select?.options.length === 2 ? select : null; });
            if (!organization || !project) throw new Error('Workspace selectors did not load.');
            project.value = 'project_storefront'; project.dispatchEvent(new Event('change', { bubbles: true }));
            const projectSwitched = Boolean(await waitFor(() => document.querySelector('select[aria-label="Project"]')?.value === 'project_storefront'));
            const projectSelectionCleared = !document.querySelector('tbody input[type="checkbox"]:checked');
            organization.value = 'org_rival'; organization.dispatchEvent(new Event('change', { bubbles: true }));
            const organizationSwitched = Boolean(await waitFor(() => document.querySelector('select[aria-label="Organization"]')?.value === 'org_rival'));
            const rivalProjectLoaded = Boolean(await waitFor(() => document.querySelector('select[aria-label="Project"]')?.value === 'project_rival'));
            const scopeLabel = await waitFor(() => { const label = document.querySelector('select[aria-label="Project"]')?.selectedOptions[0]?.textContent; return label?.includes('Rival app') ? label : null; });
            workspaceFlow = { organizationCount: organization.options.length, projectSwitched, projectSelectionCleared, organizationSwitched, rivalProjectLoaded, scopeLabel };
          }

          let signedOut = false; let selectionCleared = false;
          if (!${process.env.SAYSPEC_WORKSPACE_SMOKE === '1'} && !${process.env.SAYSPEC_SETTINGS_SMOKE === '1'} && !${process.env.SAYSPEC_LIBRARY_SMOKE === '1'} && !${process.env.SAYSPEC_PROJECT_GATE_SMOKE === '1'} && !${process.env.SAYSPEC_RECORDING_SHARE_SMOKE === '1'}) {
            [...document.querySelectorAll('.account-panel button')].find((item) => item.textContent.trim() === 'Sign out')?.click();
            signedOut = Boolean(await waitFor(() => document.body.textContent.includes('Continue as guest')));
            selectionCleared = !document.querySelector('tbody input[type="checkbox"]:checked');
          }
          authFlow = { canceled, signedIn, signedOut, selectionCleared };
        }
      }
      const cssText = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules].map((rule) => rule.cssText); } catch { return []; } }).join(' ');
      return { info, nodeAccess, entryGate, authFlow, workspaceFlow, projectGateFlow, guestFlow, bridgeKeys: Object.keys(window.sayspec).sort(), reducedMotionRule: cssText.includes('prefers-reduced-motion') };
      } catch (error) { return { setupError: String(error), setupStack: error?.stack }; }
    })()`);

    if (process.env.SAYSPEC_WORKSPACE_SMOKE === '1') {
      await revokeNativeSmokeMembership();
      setup.workspaceRevocation = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (predicate) => { for (let attempt = 0; attempt < 300; attempt += 1) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
        const visible = Boolean(await waitFor(() => document.body.textContent.includes('Access to the active organization was revoked')));
        const organizationCleared = !document.querySelector('select[aria-label="Organization"]') || document.querySelector('select[aria-label="Organization"]')?.value === '';
        const projectCleared = !document.querySelector('select[aria-label="Project"]') || document.querySelector('select[aria-label="Project"]')?.value === '';
        [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Sign out')?.click();
        const signedOut = Boolean(await waitFor(() => document.body.textContent.includes('Continue as guest')));
        const selectionCleared = !document.querySelector('tbody input[type="checkbox"]:checked');
        return { visible, organizationCleared, projectCleared, signedOut, selectionCleared };
      })()`);
      setup.authFlow.signedOut = setup.workspaceRevocation.signedOut;
      setup.authFlow.selectionCleared = setup.workspaceRevocation.selectionCleared;
    }

    smokeStage = 'interaction';
    const interaction = await window.webContents.executeJavaScript(`(async () => {
      const nav = document.querySelector('nav');
      const recordFirst = !nav || document.querySelector('nav button')?.textContent.trim() === 'Record';
      const navSections = [...document.querySelectorAll('.nav-section')].map((item) => item.textContent.trim());
      const manualAuthoringAbsent = !document.querySelector('[data-testid="new-test"]') && !document.body.textContent.includes('Create a manual test');
      if (nav) { [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Fixes')?.click(); await new Promise((resolve) => requestAnimationFrame(resolve)); }
      return { recordFirst, navSections, manualAuthoringAbsent, heading: document.querySelector('h1')?.textContent, activeNavigation: document.querySelector('nav button[aria-current="page"]')?.textContent?.trim(), noFooter: !document.querySelector('footer'), sidebarRuntime: document.querySelector('.sidebar-foot')?.textContent, topbarHeight: document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0 };
    })()`);

    let settingsFlow = null;
    if (process.env.SAYSPEC_SETTINGS_SMOKE === '1') {
      smokeStage = 'settings';
      settingsFlow = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (predicate) => { for (let attempt = 0; attempt < 400; attempt += 1) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
        const setInput = (input, value) => { if (!input) throw new Error('Native settings input was not found; heading=' + document.querySelector('h1')?.textContent + '; fields=' + [...document.querySelectorAll('input')].map((item) => item.id).join(',')); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
        [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Settings')?.click();
        await waitFor(() => document.querySelector('h1')?.textContent === 'Settings');
        const baseUrl = await waitFor(() => document.querySelector('#field-base-url')); setInput(baseUrl, 'not-a-url');
        const invalidUrlVisible = Boolean(await waitFor(() => baseUrl.getAttribute('aria-invalid') === 'true')); setInput(baseUrl, 'http://127.0.0.1:4173');
        [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Choose source folder')?.click();
        const sourceSelected = Boolean(await waitFor(() => document.querySelector('.settings-actions')?.textContent.includes('neue_qa')));
        [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Check this machine')?.click();
        const readinessReady = Boolean(await waitFor(() => document.querySelector('.settings-status')?.textContent.includes('machine is ready')));
        const modelDefault = Boolean(await waitFor(() => document.querySelector('select[aria-label="Default transcription model"]')?.value.includes('whisper-small')));
        // The seeded workspace is on Free: Gemini is listed for the signed-in workspace but cannot be chosen.
        const geminiGated = Boolean(await waitFor(() => document.querySelector('select[aria-label="Default transcription model"] option[value="gemini-cloud"]')?.disabled));
        const aiChoice = await waitFor(() => document.querySelector('[data-testid="default-ai-select"]')); aiChoice.value = 'codex'; aiChoice.dispatchEvent(new Event('change', { bubbles: true }));
        const aiSelected = Boolean(await waitFor(() => document.querySelector('[data-testid="default-ai-select"]')?.value === 'codex' && document.querySelector('.ai-provider-settings .ai-provider-logo')?.getAttribute('data-provider') === 'codex'));
        const aiSettingsCompact = Boolean(document.querySelector('[data-testid="default-ai-select"]')) && !document.querySelector('[data-testid="ai-provider-settings"] .eyebrow, [data-testid="ai-provider-settings"] .ai-privacy, [data-testid="ai-provider-settings"] .control-help');
        [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Save base URL')?.click();
        const sharedSaved = Boolean(await waitFor(() => document.querySelector('.settings-status')?.textContent.includes('Base URL saved')));
        [...document.querySelectorAll('.topbar-actions button')].find((item) => item.textContent.trim() === 'Create project')?.click();
        const projectName = await waitFor(() => document.querySelector('[role="dialog"] #field-project-name')); setInput(projectName, 'Native acceptance project'); setInput(document.querySelector('[role="dialog"] #field-base-url'), 'http://127.0.0.1:3001'); document.querySelector('[role="dialog"] [data-testid="project-create"]')?.click();
        const projectIndexed = Boolean(await waitFor(() => document.querySelector('select[aria-label="Project"]')?.options.length === 3));
        const createdProject = Boolean(document.querySelector('select[aria-label="Project"]')?.value.includes('native_acceptance_project'));
        return { invalidUrlVisible, sourceSelected, readinessReady, aiSelected, aiSettingsCompact, modelDefault, geminiGated, sharedSaved, createdProject, projectIndexed, heading: document.querySelector('h1')?.textContent };
      })()`);
    }

    let setupFlow = null;
    if (process.env.SAYSPEC_SETUP_SMOKE === '1') {
      smokeStage = 'machine-setup';
      setupFlow = await window.webContents.executeJavaScript(`(async () => {
        try {
          const waitFor = async (predicate, attempts = 600) => { for (let attempt = 0; attempt < attempts; attempt += 1) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); } return null; };
          [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Settings')?.click();
          // A Flutter project is created first so the project-specific checks
          // (SDK pin, Patrol tests, recorder integration) have real inputs.
          let card = await waitFor(() => document.querySelector('[data-testid="machine-setup"]'), 100);
          const existingFlutter = await window.sayspec.getLocalWorkspace().then((workspace) => workspace.projects.some((project) => project.targetType === 'flutter'));
          let projectCreated = existingFlutter;
          let projectError = null;
          if (!existingFlutter) {
           try {
            [...document.querySelectorAll('.topbar-actions button')].find((item) => item.textContent.trim() === 'Create project')?.click();
            const dialog = await waitFor(() => document.querySelector('[role="dialog"]'));
            const nameField = dialog.querySelector('#field-project-name');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameField, 'Flutter setup acceptance');
            nameField.dispatchEvent(new Event('input', { bubbles: true }));
            const technology = dialog.querySelector('select[aria-label="Project technology"]');
            technology.value = 'flutter'; technology.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 100));
            [...dialog.querySelectorAll('button')].find((item) => item.textContent.trim().includes('Choose folder'))?.click();
            await waitFor(() => !dialog.querySelector('.source-name')?.textContent.includes('No folder'));
            dialog.querySelector('[data-testid="local-project-create"]')?.click();
            await waitFor(() => !document.querySelector('[role="dialog"]'));
            projectCreated = true;
           } catch (error) { projectError = String(error); }
          }
          card = await waitFor(() => document.querySelector('[data-testid="machine-setup"]'));
          if (!card) return { error: 'The machine setup card did not render', heading: document.querySelector('h1')?.textContent };
          const checked = Boolean(await waitFor(() => card.querySelectorAll('.setup-group').length === 2));
          const stages = [...card.querySelectorAll('.setup-stage')].map((item) => item.textContent.trim());
          const flutterGroups = [...card.querySelectorAll('.setup-group')].map((item) => item.querySelector('summary strong')?.textContent);
          const items = [...card.querySelectorAll('.setup-item')].map((item) => ({ id: item.getAttribute('data-item-id'), state: item.getAttribute('data-state') }));
          const projectLine = card.querySelector('.setup-project')?.textContent ?? '';
          const androidGroup = [...card.querySelectorAll('.setup-group')].find((item) => item.getAttribute('data-workflow') === 'flutter-android');
          androidGroup.open = true;
          const androidCounts = androidGroup.querySelector('.setup-group__counts')?.textContent?.trim();
          const androidReady = androidGroup.querySelector('.setup-group__counts')?.getAttribute('data-ready');
          const actionable = [...androidGroup.querySelectorAll('.setup-item')].filter((item) => ['missing', 'incompatible'].includes(item.getAttribute('data-state')));
          const actionableWithRecovery = actionable.filter((item) => item.querySelector('.setup-item__recovery') || item.querySelector('.setup-item__manual'));
          const purposeHeadings = [...card.querySelectorAll('.setup-purpose h3')].map((item) => item.textContent.trim());
          const sourceSelected = [...card.querySelectorAll('.setup-requirements strong')].some((item) => item.textContent.trim() === 'Source code') && card.querySelector('.setup-requirements')?.textContent.includes('Selected');
          const aiSetupButton = [...card.querySelectorAll('button')].find((item) => item.textContent.trim().startsWith('Setup with '));
          const legacyInstallActionsAbsent = !card.querySelector('.setup-item__actions, .setup-group__actions, .setup-plan');
          // The reviewed baseline checker/plan remains available as input to
          // the AI session, but Settings no longer starts it directly.
          const plan = await window.sayspec.planMachineSetupInstall({ workflow: 'flutter-android' });

          // Record reuses the same readiness service, so it cannot disagree
          //    with Settings about what this machine still needs.
          [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Record')?.click();
          const readiness = await waitFor(() => document.querySelector('[data-testid="flutter-record-readiness"]'), 200);
          const readinessText = readiness?.textContent ?? '';
          const readinessBlockers = readiness ? [...readiness.querySelectorAll('li')].map((item) => item.textContent.trim().slice(0, 120)) : [];
          [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Settings')?.click();
          await waitFor(() => document.querySelector('[data-testid="machine-setup"]'), 200);

          // Switch to the Web project and prove mobile lanes disappear.
          const workspace = await window.sayspec.getLocalWorkspace();
          const webProject = workspace.projects.find((project) => project.targetType === 'web');
          const switcher = document.querySelector('select[aria-label="Local project"]');
          switcher.value = webProject.id; switcher.dispatchEvent(new Event('change', { bubbles: true }));
          const webCard = await waitFor(() => { const next = document.querySelector('[data-testid="machine-setup"]'); const labels = [...next?.querySelectorAll('.setup-group') ?? []].map((item) => item.querySelector('summary strong')?.textContent); return labels.length === 1 && labels[0] === 'Web · Playwright' ? next : null; }, 300);
          const webGroups = [...webCard.querySelectorAll('.setup-group')].map((item) => item.querySelector('summary strong')?.textContent);
          return {
            checked, stages, flutterGroups, webGroups, items, projectLine, projectCreated, projectError, androidCounts, androidReady,
            readinessText: (readinessText ?? '').slice(0, 300), readinessBlockers, purposeHeadings, sourceSelected,
            aiSetupVisible: Boolean(aiSetupButton), aiSetupDisabled: Boolean(aiSetupButton?.disabled), legacyInstallActionsAbsent,
            actionable: actionable.map((item) => item.getAttribute('data-item-id')),
            actionableWithRecovery: actionableWithRecovery.length, actionableTotal: actionable.length,
            planSteps: plan.steps.map((step) => ({ label: step.label, command: step.command })), planManualSteps: plan.manualSteps,
          };
        } catch (error) { return { error: String(error), stack: error?.stack }; }
      })()`);
    }

    let libraryFlow = null;
    if (process.env.SAYSPEC_LIBRARY_SMOKE === '1') {
      smokeStage = 'library';
      libraryFlow = await window.webContents.executeJavaScript(`(async () => {
        try {
          const waitFor = async (predicate) => { for (let attempt = 0; attempt < 400; attempt += 1) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
          const setValue = (element, value) => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
          const pressEnter = (element) => { element?.focus(); element?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); };
          const project = await waitFor(() => document.querySelector('select[aria-label="Project"]')); project.value = 'project_storefront'; project.dispatchEvent(new Event('change', { bubbles: true }));
          await waitFor(() => document.querySelector('select[aria-label="Project"]')?.value === 'project_storefront');
          [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Tests')?.click();
          const testRow = () => [...document.querySelectorAll('.test-table tbody tr')].find((item) => item.querySelector('.test-table-title')?.textContent === 'Checkout with saved address');
          const published = Boolean(await waitFor(testRow));
          const authorVisible = testRow()?.querySelector('.test-table-author')?.textContent === 'Taylor Tester';
          const compactTable = Boolean(testRow() && [...document.querySelectorAll('.test-table thead th')].map((item) => item.textContent.trim()).join('|') === 'Test|Author|Actions' && !document.querySelector('.inspector, .local-generated-test, .code-view, .version-row') && !document.body.textContent.includes('Generated from your recording'));
          const recordInAppbar = Boolean(document.querySelector('.topbar-actions [data-testid="record-test"]') && !document.querySelector('.test-library h2'));
          const prefix = document.querySelector('#field-search-tests'); setValue(prefix, 'zzzz-no-result');
          const emptyRow = Boolean(await waitFor(() => document.querySelector('.test-table-empty')?.textContent.includes('Nothing to show'))); setValue(prefix, '');
          await waitFor(testRow);
          pressEnter(testRow()?.querySelector('.test-menu-trigger'));
          pressEnter(await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === 'Rename')));
          const renameInput = await waitFor(() => document.querySelector('[role="dialog"] input[name="title"]')); setValue(renameInput, 'Checkout with preferred address');
          [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent.trim() === 'Save name')?.click();
          const renamedRow = () => [...document.querySelectorAll('.test-table tbody tr')].find((item) => item.querySelector('.test-table-title')?.textContent === 'Checkout with preferred address');
          const renamed = Boolean(await waitFor(renamedRow));
          pressEnter(renamedRow()?.querySelector('.test-menu-trigger'));
          pressEnter(await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === 'Delete')));
          const deleted = Boolean(await waitFor(() => !renamedRow()));
          document.querySelector('[data-testid="record-test"]')?.click();
          const recordNavigation = Boolean(await waitFor(() => document.querySelector('h1')?.textContent === 'Record'));
          return { published, authorVisible, compactTable, recordInAppbar, emptyRow, renamed, deleted, recordNavigation, manualAuthoringAbsent: !document.body.textContent.toLowerCase().includes('manual'), heading: document.querySelector('h1')?.textContent };
        } catch (error) { return { error: String(error), stack: error?.stack }; }
      })()`);
    }

    let recordingFlow = null;
    if (process.env.SAYSPEC_RECORDING_SMOKE === '1') {
      smokeStage = 'recording';
      recordingFlow = await window.webContents.executeJavaScript(`(async () => {
        try {
        const waitFor = async (predicate, attempts = 500) => { for (let attempt = 0; attempt < attempts; attempt += 1) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
        const setInput = (element, value) => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
        [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Record')?.click();
        await waitFor(() => document.querySelector('h1')?.textContent === 'Record');
        const phase = ${JSON.stringify(process.env.SAYSPEC_RECORDING_PERSIST_PHASE ?? 'capture')};
        if (phase === 'restore') {
          const recording = await waitFor(() => document.querySelector('.recording-list button'));
          recording?.click();
          const reopened = Boolean(await waitFor(() => document.querySelector('[data-testid="recording-review"]')));
          const audio = await waitFor(() => { const element = document.querySelector('.evidence-viewer audio'); return element && element.readyState >= HTMLMediaElement.HAVE_METADATA && !element.error ? element : null; });
          const seekTarget = [...document.querySelectorAll('.timeline button')].reverse().find((button) => Number(button.getAttribute('data-audio-offset-ms')) > 50); seekTarget?.click();
          const alignedSeek = Boolean(seekTarget && await waitFor(() => { const expected = Number(seekTarget.getAttribute('data-audio-offset-ms')) / 1000; const current = document.querySelector('.evidence-viewer audio')?.currentTime; return typeof current === 'number' && Math.abs(current - expected) < 0.75; }));
          const workspace = await window.sayspec.getLocalWorkspace();
          const summaries = await window.sayspec.listLocalRecordings({ projectId: workspace.projects[0].id });
          const stored = await window.sayspec.getLocalRecording({ projectId: workspace.projects[0].id, recordingId: summaries.find((item) => item.status === 'ready')?.id });
          const generatedDraft = ${process.env.SAYSPEC_GENERATION_SMOKE === '1'} ? stored.generationDraft : null;
          return { reopened, transcriptReopened: stored.transcript?.status === 'ready', formAbsent: !document.querySelector('.intent-form, .transcript-segment textarea'), generationReopened: ${process.env.SAYSPEC_GENERATION_SMOKE === '1'} ? Boolean(generatedDraft) && !document.querySelector('[data-testid="generated-playwright-draft"]') : null, generatedSourceReopened: generatedDraft?.files.some((file) => file.relativePath === 'tests/reviewed-monthly.spec.ts') ?? null, localTestReopened: workspace.tests.some((test) => test.recordingId === stored.id && test.status === 'generated'), firstScreenCaptured: document.querySelector('.timeline button')?.textContent.includes('navigation') ?? false, audio: Boolean(audio), audioReadyState: audio?.readyState ?? 0, audioError: audio?.error?.message ?? null, alignedSeek, screenshot: Boolean(await waitFor(() => { const image = document.querySelector('.evidence-viewer img'); return image?.complete && image.naturalWidth > 0 ? image : null; })), eventCount: document.querySelectorAll('.timeline button').length };
        }
        const url = await waitFor(() => document.querySelector('#field-starting-url'));
        setInput(url, ${JSON.stringify(process.env.SAYSPEC_RECORDING_URL ?? '')});
        const shareCloud = ${process.env.SAYSPEC_RECORDING_SHARE_SMOKE === '1'};
        const sharingChoice = shareCloud ? await waitFor(() => document.querySelector('.sharing-choice input')) : null;
        sharingChoice?.click();
        document.querySelector('[data-testid="open-recording-browser"]')?.click();
        if (phase === 'denied') {
          const denied = Boolean(await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('Microphone access is off')));
          const captureAbsent = !document.querySelector('[data-testid="capture-console"]');
          return { denied, captureAbsent, recordingCount: document.querySelectorAll('.recording-list button').length };
        }
        const recording = Boolean(await waitFor(() => document.querySelector('.status--running')));
        const started = Boolean(document.querySelector('[data-testid="capture-console"]'));
        await new Promise((resolve) => setTimeout(resolve, 4200));
        [...document.querySelectorAll('.record-actions button')].find((item) => item.textContent.trim() === 'Pause')?.click();
        const paused = Boolean(await waitFor(() => document.body.textContent.includes('Capture paused')));
        await new Promise((resolve) => setTimeout(resolve, 350));
        [...document.querySelectorAll('.record-actions button')].find((item) => item.textContent.trim() === 'Resume')?.click();
        const resumed = Boolean(await waitFor(() => document.querySelector('.status--running')));
        await new Promise((resolve) => setTimeout(resolve, 1800));
        const firstReviewed = Boolean(await waitFor(() => document.querySelector('[data-testid="recording-review"]')));
        let secondStarted = null; let secondReviewed = null;
        if (!shareCloud) {
          secondStarted = Boolean(await waitFor(() => document.querySelector('[data-testid="capture-console"]') && document.querySelector('.status--running')));
          secondReviewed = Boolean(await waitFor(() => document.querySelector('[data-testid="recording-review"]')));
        }
        const reviewed = shareCloud ? firstReviewed : Boolean(secondReviewed);
        const claudeTab = [...document.querySelectorAll('.review-tabs [role="tab"]')].some((tab) => tab.textContent?.trim() === 'AI');
        let claudeTerminalSized = null;
        if (${process.env.SAYSPEC_GENERATION_SMOKE === '1'}) {
          let terminalOutput = '';
          const unsubscribeTerminal = window.sayspec.onClaudeTerminalEvent((event) => { if (event.kind === 'data') terminalOutput += event.data ?? ''; });
          [...document.querySelectorAll('.review-tabs [role="tab"]')].find((tab) => tab.textContent?.trim() === 'AI')?.click();
          const size = await waitFor(() => terminalOutput.match(/TERM_SIZE:([0-9]+) ([0-9]+)/));
          claudeTerminalSized = Boolean(size && Number(size[1]) >= 8 && Number(size[2]) >= 20 && Number(size[2]) < 100);
          unsubscribeTerminal();
          [...document.querySelectorAll('.review-tabs [role="tab"]')].find((tab) => tab.textContent?.trim() === 'Recording')?.click();
        }
        const audio = await waitFor(() => { const element = document.querySelector('.evidence-viewer audio'); return element && element.readyState >= HTMLMediaElement.HAVE_METADATA && !element.error ? element : null; });
        const seekTarget = [...document.querySelectorAll('.timeline button')].reverse().find((button) => Number(button.getAttribute('data-audio-offset-ms')) > 50); seekTarget?.click();
        const alignedSeek = Boolean(seekTarget && await waitFor(() => { const expected = Number(seekTarget.getAttribute('data-audio-offset-ms')) / 1000; const current = document.querySelector('.evidence-viewer audio')?.currentTime; return typeof current === 'number' && Math.abs(current - expected) < 0.75; }));
        let shared = null;
        if (shareCloud) {
          const shareButton = await waitFor(() => [...document.querySelectorAll('.share-panel button')].find((button) => button.textContent.trim() === 'Share with Pro workspace'));
          shareButton?.click();
          const shareOutcome = await waitFor(() => { const panel = document.querySelector('.share-panel'); return panel?.textContent.includes('validated evidence package is shared') || panel?.querySelector('[role="alert"]') ? panel : null; }, 1_600);
          shared = Boolean(shareOutcome?.textContent.includes('validated evidence package is shared'));
        }
        const firstScreenCaptured = document.querySelector('.timeline button')?.textContent.includes('navigation') ?? false;
        const screenshot = Boolean(await waitFor(() => { const image = document.querySelector('.evidence-viewer img'); return image?.complete && image.naturalWidth > 0 ? image : null; }));
        const eventCount = document.querySelectorAll('.timeline button').length;
        const shareText = document.querySelector('.share-panel')?.textContent ?? null;
        let transcriptReady = null; let formAbsent = null; let modelSelected = null; let aiSelectedInRecord = null; let aiLogoInRecord = null; let aiOverrideWorks = null; let disclosureAbsent = null; let generationReady = null; let generationUnvalidated = null; let generationEvidenceLinked = null; let localTestSaved = false; let generationState = null; let generationError = null; let generationTerminalOutput = '';
        if (${process.env.SAYSPEC_TRANSCRIPTION_SMOKE === '1' || process.env.SAYSPEC_GENERATION_SMOKE === '1'}) {
          const workspace = await window.sayspec.getLocalWorkspace();
          const summaries = await window.sayspec.listLocalRecordings({ projectId: workspace.projects[0].id });
          let stored = null;
          for (let attempt = 0; attempt < 1600; attempt += 1) { stored = await window.sayspec.getLocalRecording({ projectId: workspace.projects[0].id, recordingId: summaries.find((item) => item.status === 'ready')?.id }); if (stored.transcript?.status === 'ready') break; await new Promise((resolve) => setTimeout(resolve, 50)); }
          transcriptReady = stored?.transcript?.status === 'ready';
          formAbsent = !document.querySelector('.intent-form, .transcript-segment textarea, .evidence-links');
          modelSelected = document.querySelector('[data-testid="playwright-generation"] select[aria-label="Transcription model"]')?.value.includes('whisper-small') ?? false;
          disclosureAbsent = !document.querySelector('[data-testid="playwright-generation"] .provider-disclosure');
          if (${process.env.SAYSPEC_GENERATION_SMOKE === '1'}) {
            aiSelectedInRecord = document.querySelector('[data-testid="playwright-generation"]')?.textContent.includes('Codex') ?? false;
            aiLogoInRecord = Boolean(document.querySelector('[data-testid="playwright-generation"] .provider-select .ai-provider-logo'));
            aiOverrideWorks = true;
            const unsubscribeGenerationTerminal = window.sayspec.onClaudeTerminalEvent((event) => { if (event.kind === 'data') generationTerminalOutput += event.data ?? ''; });
            const generate = await waitFor(() => [...document.querySelectorAll('[data-testid="playwright-generation"] button')].find((button) => button.textContent.trim() === 'Generate tests' && !button.disabled)); generate?.click();
            const switchedToClaude = Boolean(await waitFor(() => document.querySelector('.review-tabs [role="tab"][aria-selected="true"]')?.textContent.includes('AI')));
            const generated = await waitFor(async () => ['draft', 'failed'].includes((await window.sayspec.getLocalRecording({ projectId: workspace.projects[0].id, recordingId: stored.id })).generationDraft?.state), 1_200);
            const saved = (await window.sayspec.getLocalRecording({ projectId: workspace.projects[0].id, recordingId: stored.id })).generationDraft;
            unsubscribeGenerationTerminal(); generationState = saved?.state ?? null; generationError = saved?.error ?? saved?.validation?.summary ?? null; generationTerminalOutput = generationTerminalOutput.slice(-2_000);
            generationReady = switchedToClaude && Boolean(generated) && saved?.state === 'draft' && !document.querySelector('[data-testid="generated-playwright-draft"]'); generationUnvalidated = saved?.provenance.executionValidated === true; generationEvidenceLinked = Boolean(stored?.manifest.events.length && saved?.steps.some((step) => step.evidenceEventIds.length));
            for (let attempt = 0; attempt < 100; attempt += 1) { const library = await window.sayspec.getLocalWorkspace(); if (library.tests.some((test) => test.recordingId === stored?.id && test.status === 'generated')) { localTestSaved = true; break; } await new Promise((resolve) => setTimeout(resolve, 50)); }
          }
        }
        const sessionButton = [...document.querySelectorAll('.review-actions button')].find((button) => button.textContent.includes('Recording session')); sessionButton?.click();
        const resetReady = Boolean(await waitFor(() => document.querySelector('[data-testid="capture-console"]')?.textContent.includes('Browser ready')));
        document.querySelector('[data-testid="cancel-recording"]')?.click();
        await waitFor(() => !document.querySelector('[data-testid="capture-console"]'));
        return { started, recording, paused, resumed, reviewed, claudeTab, claudeTerminalSized, firstReviewed, secondStarted, secondReviewed, resetReady, firstScreenCaptured, sharingChoice: sharingChoice?.checked ?? null, shared, shareText, audio: Boolean(audio), audioReadyState: audio?.readyState ?? 0, audioError: audio?.error?.message ?? null, alignedSeek, screenshot, eventCount, recordingCount: document.querySelectorAll('.recording-list button').length, transcriptReady, formAbsent, modelSelected, aiSelectedInRecord, aiLogoInRecord, aiOverrideWorks, disclosureAbsent, generationReady, generationUnvalidated, generationEvidenceLinked, generationState, generationError, generationTerminalOutput, localTestSaved };
        } catch (error) { return { error: String(error), stack: error?.stack }; }
      })()`);
    }

    smokeStage = 'result';
    const result = { ...setup, ...interaction, settingsFlow, libraryFlow, recordingFlow, setupFlow };
    if (process.env.SAYSPEC_PACKAGED_VALIDATION_SMOKE === '1') {
      smokeStage = 'packaged-validation';
      const source = "import { test, expect } from '@playwright/test'; test('packaged browser', async ({ page }) => { await page.goto('about:blank'); await expect(page).toHaveURL('about:blank'); });";
      const bytes = Buffer.from(source);
      result.packagedValidation = await validatePlaywrightCandidate({ files: [{ id: 'file_1', relativePath: 'tests/packaged.spec.ts', text: source, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'text/typescript' }], entrypoint: 'tests/packaged.spec.ts', baseUrl: 'http://127.0.0.1:1/' });
    }
    window.webContents.setZoomFactor(2);
    const zoomLayout = await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => resolve({ rootOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, shellDisplay: document.querySelector('.shell') ? getComputedStyle(document.querySelector('.shell')).display : 'entry' })))`);
    window.webContents.setZoomFactor(1); result.zoomLayout = zoomLayout;
    console.log(`SAYSPEC_SMOKE_RESULT=${JSON.stringify(result)}`);
    app.exit(result.nodeAccess ? 1 : 0);
  } catch (error) {
    reportStartupFailure('native-smoke', new Error(`${smokeStage}: ${error instanceof Error ? error.message : String(error)}`));
    app.exit(1);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280, height: 840, minWidth: 960, minHeight: 640,
    backgroundColor: '#F5F2EB', title: 'SaySpec',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  if (testMode) window.webContents.on('console-message', (_event, level, message) => console.log(`SAYSPEC_RENDERER_CONSOLE=${level}:${message}`));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('preload-error', (_event, failedPath, error) => {
    reportStartupFailure('preload', new Error(`${failedPath}: ${error.message}`));
    if (testMode) app.exit(1);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!shuttingDown) reportStartupFailure('renderer-process', new Error(details.reason));
  });
  window.webContents.on('unresponsive', () => {
    if (!shuttingDown) reportStartupFailure('renderer-unresponsive', new Error('The renderer stopped responding.'));
  });
  window.once('ready-to-show', () => {
    window.show();
    void runNativeSmoke(window);
  });
  const load = devUrl ? window.loadURL(devUrl) : window.loadFile(rendererPath);
  void load.catch((error) => {
    reportStartupFailure('renderer-load', error);
    if (testMode) app.exit(1);
  });
}

app.whenReady().then(async () => {
  localJobs = new LocalJobManager({ rootDirectory: path.join(app.getPath('userData'), 'local-jobs') });
  await localJobs.initialize();
  localWorkspace = new LocalWorkspaceStore(path.join(app.getPath('userData'), 'local-workspace.json'));
  await localWorkspace.initialize();
  savedWebTests = new SavedWebTestStore(path.join(app.getPath('userData'), 'saved-web-tests'));
  await savedWebTests.initialize();
  patrolRuns = new PatrolRunStore(path.join(app.getPath('userData'), 'patrol-runs'));
  await patrolRuns.initialize();
  recordingStore = new RecordingStore(path.join(app.getPath('userData'), 'recordings'));
  await recordingStore.initialize();
  const testStorageSettings = new TestStorageSettingsStore(path.join(app.getPath('userData'), 'test-storage.json'));
  await testStorageSettings.initialize();
  const cloudUploads = new CloudUploadQueue(path.join(app.getPath('userData'), 'cloud-uploads.json'));
  await cloudUploads.initialize();
  testStorage = new TestStorage({ settings: testStorageSettings, localWorkspace, webTests: savedWebTests, patrolTests: patrolRuns, cloudUploads, localRoot: path.join(app.getPath('userData'), 'local-tests') });
  testInstructions = new TestInstructions((scope) => testStorage!.instructionsLocation(scope));
  const sendTranscriptionLifecycle = (value: Parameters<NonNullable<ConstructorParameters<typeof LocalModelManager>[0]['onLifecycle']>>[0]) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('transcription:lifecycle', value);
  };
  localModels = new LocalModelManager({ rootDirectory: path.join(app.getPath('userData'), 'transcription-models'), onLifecycle: sendTranscriptionLifecycle });
  await localModels.initialize();
  localTranscription = createTranscriptionProvider(DEFAULT_TRANSCRIPTION_PROVIDER, { rootDirectory: path.join(app.getPath('userData'), 'transcription-work'), store: recordingStore, models: localModels, onLifecycle: sendTranscriptionLifecycle });
  await localTranscription.initialize();
  if (__SAYSPEC_CLOUD_FUNCTIONS_URL__) {
    cloudTranscription = createTranscriptionProvider(CLOUD_TRANSCRIPTION_PROVIDER, { rootDirectory: path.join(app.getPath('userData'), 'transcription-work'), store: recordingStore, models: localModels, cloudFunctionsUrl: __SAYSPEC_CLOUD_FUNCTIONS_URL__, onLifecycle: sendTranscriptionLifecycle });
    await cloudTranscription.initialize();
  }
  const codingAgents = new CodingAgentAdapters();
  const agentWorkspaces = new ProjectAgentWorkspaceManager(path.join(app.getPath('userData'), 'agent-project-workspaces'), savedWebTests!, patrolRuns, (scope) => testInstructions!.read(scope));
  failureAnalysis = new FailureAnalysisManager(savedWebTests!, codingAgents, patrolRuns);
  applicationFixes = new ApplicationFixStore(path.join(app.getPath('userData'), 'application-fixes'));
  await applicationFixes.initialize();
  applicationFixSessions = new ApplicationFixSessionManager(agentWorkspaces, selectedDirectories, applicationFixes, codingAgents,
    (value) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('application-fix:event', value); });
  managedFixSessions = new ManagedTestFixSessionManager(agentWorkspaces, savedWebTests!, codingAgents,
    (value) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('managed-fix:event', value); },
    patrolRuns ? patrolTestFixSubject(patrolRuns) : undefined);
  gitWorkspace = new GitWorkspace({ storePath: path.join(app.getPath('userData'), 'git', 'commits.json'), tool: gitTool, environment: gitEnvironment, identity: () => testStorage?.author() ?? null,
    // Test runs record the page they would open instead of opening a browser.
    openExternal: async (url) => { if (!/^https:\/\//.test(url)) throw new Error('Only web pages can be opened.'); if (testMode && process.env.SAYSPEC_TEST_OPENED_URLS) await appendFile(process.env.SAYSPEC_TEST_OPENED_URLS, `${url}\n`); else if (!testMode) await shell.openExternal(url); } });
  await gitWorkspace.initialize();
  rememberedSources = new RememberedSourceStore(path.join(app.getPath('userData'), 'remembered-sources.json'));
  await rememberedSources.initialize();
  entryPoints = new ProjectEntryPointStore(path.join(app.getPath('userData'), 'project-entry-points.json'));
  await entryPoints.initialize();
  const codingAgentPreferenceStore = new CodingAgentPreferenceStore(path.join(app.getPath('userData'), 'coding-agent-preference.json'));
  await codingAgentPreferenceStore.initialize();
  codingAgentPreferences = new CodingAgentPreferenceManager({ store: codingAgentPreferenceStore, agents: codingAgents, openExternal: (url) => shell.openExternal(url) });
  playwrightGeneration = new PlaywrightGenerationManager({
    rootDirectory: path.join(app.getPath('userData'), 'playwright-generation-work'), store: recordingStore,
    adapters: codingAgents,
    validationMode: testMode && process.env.SAYSPEC_GENERATION_SMOKE === '1' ? 'off' : 'on',
    onLifecycle(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('generation:lifecycle', value); },
  });
  await playwrightGeneration.initialize();
  claudeTerminal = new ClaudeTerminalManager({
    workspaces: agentWorkspaces, store: recordingStore, adapters: codingAgents,
    onEvent(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('claude-terminal:event', value); },
    async onSubmission(recordingId, provider, output, signal) {
      const generated = await playwrightGeneration!.importInteractive(recordingId, provider, output, signal);
      if (signal.aborted) throw new Error('Test generation was canceled.');
      if (!generated.provenance.executionValidated) throw new Error(generated.error ?? 'The generated test did not pass Playwright.');
      await testStorage!.saveGeneratedWebTest(generated);
    },
  });
  recordingManager = new RecordingManager({
    store: recordingStore,
    headless: testMode && process.env.SAYSPEC_RECORDING_HEADLESS === '1',
    executablePath: process.env.SAYSPEC_CHROMIUM_EXECUTABLE,
    onLifecycle(event) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('recording:lifecycle', event); },
  });
  flutterCaptures = new FlutterCaptureStore(path.join(app.getPath('userData'), 'flutter-captures'));
  await flutterCaptures.initialize();
  flutterSessions = new FlutterCaptureSessionManager({
    store: flutterCaptures,
    onLifecycle(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('flutter-capture:lifecycle', value); },
    onLaunchLog(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('flutter-capture:launch-log', value); },
  });
  patrolRunAnalysis = new PatrolRunAnalysisManager({
    root: path.join(app.getPath('userData'), 'patrol-run-analysis'), store: patrolRuns, adapters: codingAgents,
    provider: () => codingAgentPreferences?.snapshot().provider,
    emit(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('patrol-run-analysis:event', value); },
    async open(absolutePath) { const error = await shell.openPath(absolutePath); if (error) throw new Error(error); },
  });
  await patrolRunAnalysis.initialize();
  patrolRunner = new PatrolRunner({
    store: patrolRuns, captures: flutterSessions,
    inPlaceRoot: (scope) => testStorage?.inPlaceRoot(scope),
    events: {
      onRunStarted: (runId) => { void patrolRunAnalysis?.discard(runId); },
      onRunFailed: (run, sourcePath) => { void patrolRunAnalysis?.start(run, sourcePath); },
      onConsole: (value) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('patrol-run:console-event', value); },
    },
  });
  patrolGeneration = new PatrolGenerationTerminalManager({
    workspaces: agentWorkspaces, captures: flutterCaptures, runs: patrolRuns, runner: patrolRunner, adapters: codingAgents,
    onEvent(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('patrol-generation:event', value); },
    async onSaved(test) { await testStorage!.savePatrolTest(test); },
  });
  machineSetup = new MachineSetupManager({
    journalPath: path.join(app.getPath('userData'), 'machine-setup-jobs.json'),
    onEvent(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('machine-setup:event', value); },
  });
  await machineSetup.initialize();
  machineSetup.setSourceResolver(async (handle) => { try { return selectedDirectories.root(handle); } catch { return undefined; } });
  machineSetupAgent = new MachineSetupAgentTerminalManager({
    rootDirectory: path.join(app.getPath('userData'), 'machine-setup-agent'), adapters: codingAgents,
    entryPoints: {
      current: (projectId, targetType) => entryPoints!.get(projectId, targetType),
      async save(projectId, targetType, value) {
        const saved = await entryPoints!.save({ projectId, targetType, entryPoints: value, updatedBy: 'agent' });
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('entry-points:changed', saved);
        return saved;
      },
    },
    onEvent(value) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('machine-setup-agent:event', value); },
  });
  void machineSetup.reconcileInterruptedJobs().catch(() => undefined);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const trusted = contents.getURL() === rendererUrl;
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const audioOnly = permission === 'media' && (!mediaTypes?.length || mediaTypes.every((type) => type === 'audio'));
    callback(Boolean(trusted && audioOnly && Date.now() <= microphoneGrantUntil));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const trusted = contents?.getURL() === rendererUrl;
    const audioOnly = permission === 'media' && (!details.mediaType || details.mediaType === 'audio');
    return Boolean(trusted && audioOnly && Date.now() <= microphoneGrantUntil);
  });
  ipcMain.handle('app:info', (event): AppInfo => {
    if (!isTrustedMainFrame(event, rendererUrl)) {
      throw new Error('Untrusted app information request');
    }
    return { name: 'SaySpec', version: app.getVersion(), platform: process.platform };
  });
  ipcMain.handle('app:open-account-portal', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl)) throw new Error('Untrusted account portal request');
    await shell.openExternal(accountPortalUrl(input, __SAYSPEC_ACCOUNT_PORTAL_ORIGIN__));
  });
  ipcMain.handle('local-workspace:get', (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localWorkspace) throw new Error('Untrusted local workspace request');
    return localWorkspace.snapshot();
  });
  ipcMain.handle('local-workspace:create-project', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localWorkspace || typeof input !== 'object' || input === null) throw new Error('Local project request is invalid.');
    return localWorkspace.createProject(input as CreateLocalProjectInput);
  });
  ipcMain.handle('local-workspace:delete-project', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localWorkspace || typeof input !== 'object' || input === null) throw new Error('Local project request is invalid.');
    const value = input as Record<string, unknown>;
    if (typeof value.projectId !== 'string') throw new Error('Local project request is invalid.');
    await localWorkspace.deleteProject({ projectId: value.projectId });
    await testStorage?.forget(value.projectId);
  });
  ipcMain.handle('local-workspace:rename-test', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localWorkspace || typeof input !== 'object' || input === null) throw new Error('Local test request is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.projectId, value.testId, value.title].every((item) => typeof item === 'string')) throw new Error('Local test request is invalid.');
    return localWorkspace.renameTest(value as { projectId: string; testId: string; title: string });
  });
  ipcMain.handle('local-workspace:delete-test', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localWorkspace || typeof input !== 'object' || input === null) throw new Error('Local test request is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.projectId, value.testId].every((item) => typeof item === 'string')) throw new Error('Local test request is invalid.');
    return localWorkspace.deleteTest(value as { projectId: string; testId: string });
  });
  ipcMain.handle('local-workspace:save-suite', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localWorkspace || typeof input !== 'object' || input === null) throw new Error('Local suite request is invalid.');
    return localWorkspace.saveSuite(input as Parameters<LocalWorkspaceStore['saveSuite']>[0]);
  });
  ipcMain.handle('local-workspace:move-test-to-suite', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localWorkspace || typeof input !== 'object' || input === null) throw new Error('Local suite request is invalid.');
    const value = input as Record<string, unknown>;
    if (typeof value.projectId !== 'string' || typeof value.testId !== 'string' || (value.targetSuiteId !== null && typeof value.targetSuiteId !== 'string')) throw new Error('Local suite request is invalid.');
    return localWorkspace.moveTestToSuite(value as Parameters<LocalWorkspaceStore['moveTestToSuite']>[0]);
  });
  /** Folder tests change outside SaySpec, so readers of the version stores pick up the folder first. A missing folder leaves the stores as they are. */
  const syncFolderTests = async (value: { organizationId?: unknown; projectId?: unknown }) => {
    const scope = { organizationId: String(value.organizationId ?? 'local'), projectId: String(value.projectId ?? '') };
    if (!scope.projectId || !testStorage?.usesFiles(scope)) return;
    await testStorage.sync(scope).catch(() => undefined);
  };
  const libraryScope = (event: Electron.IpcMainInvokeEvent, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !testStorage || typeof input !== 'object' || input === null) throw new Error('Test storage request is invalid.');
    const value = input as Record<string, unknown>;
    if (typeof value.projectId !== 'string' || !value.projectId || (value.organizationId !== undefined && typeof value.organizationId !== 'string')) throw new Error('Test storage request is invalid.');
    return { storage: testStorage, value, scope: { organizationId: String(value.organizationId ?? ''), projectId: value.projectId } };
  };
  ipcMain.handle('test-storage:get', (event, input: unknown) => {
    const { storage, scope } = libraryScope(event, input);
    return storage.settingsView(scope);
  });
  ipcMain.handle('test-storage:choose-folder', async (event) => {
    if (!isTrustedMainFrame(event, rendererUrl)) throw new Error('Untrusted test folder request');
    let selectedPath = testMode ? process.env.SAYSPEC_TEST_STORAGE_DIRECTORY : undefined;
    if (!selectedPath) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = { title: 'Choose where to keep this project’s tests', buttonLabel: 'Use for tests', properties: ['openDirectory', 'createDirectory'] };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      selectedPath = result.canceled ? undefined : result.filePaths[0];
    }
    if (!selectedPath) return null;
    return { handle: await selectedDirectories.register(selectedPath), label: path.basename(selectedPath) };
  });
  const storageTarget = (value: Record<string, unknown>) => {
    if (value.targetType !== 'web' && value.targetType !== 'flutter') throw new Error('Test storage request is invalid.');
    if (value.mode !== 'local' && value.mode !== 'cloud' && value.mode !== 'folder') throw new Error('Test storage request is invalid.');
    if (value.folderHandle !== undefined && typeof value.folderHandle !== 'string') throw new Error('Test storage request is invalid.');
    return { mode: value.mode, targetType: value.targetType, ...(typeof value.folderHandle === 'string' ? { directory: selectedDirectories.root(value.folderHandle) } : {}) } as const;
  };
  ipcMain.handle('test-storage:configure', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    return storage.configure(scope, storageTarget(value));
  });
  ipcMain.handle('test-storage:reveal', async (event, input: unknown) => {
    const { storage, scope } = libraryScope(event, input);
    const directory = storage.folderPath(scope.projectId);
    if (!directory) throw new Error('This project has no test storage folder.');
    const error = await shell.openPath(directory); if (error) throw new Error(error);
  });
  ipcMain.handle('test-instructions:get', (event, input: unknown) => {
    const { scope } = libraryScope(event, input);
    return testInstructions!.view(scope);
  });
  ipcMain.handle('test-instructions:reveal', async (event, input: unknown) => {
    const { value, scope } = libraryScope(event, input);
    if (value.targetType !== 'web' && value.targetType !== 'flutter') throw new Error('Test instructions request is invalid.');
    shell.showItemInFolder(await testInstructions!.ensure(scope, value.targetType));
  });
  ipcMain.handle('test-instructions:sync-cloud', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    if (!storage.isCloud(scope)) return {};
    if (value.cloudText !== null && typeof value.cloudText !== 'string') throw new Error('Test instructions request is invalid.');
    return testInstructions!.syncCloud(scope, value.cloudText);
  });
  ipcMain.handle('test-storage:export', (event, input: unknown) => {
    const { storage, scope } = libraryScope(event, input);
    if (storage.isCloud(scope)) throw new Error('SaySpec Cloud tests are read through your account.');
    return storage.export(scope);
  });
  ipcMain.handle('test-storage:import', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    const target = storageTarget(value);
    if (target.mode === 'cloud') throw new Error('SaySpec Cloud tests are written through your account.');
    const library = value.library as PortableLibrary;
    if (!library || !Array.isArray(library.tests) || !Array.isArray(library.suites) || library.tests.length > 5_000 || library.suites.some((name) => typeof name !== 'string') || library.tests.some((test) => !test || typeof test.id !== 'string' || typeof test.title !== 'string')) throw new Error('The tests to copy are invalid.');
    return storage.import(scope, { ...target, mode: target.mode }, library);
  });
  // SaySpec Cloud is reached by the renderer; these move Flutter tests between it and this Mac's store.
  const cloudScope = (event: Electron.IpcMainInvokeEvent, input: unknown) => {
    const resolved = libraryScope(event, input);
    if (!resolved.storage.isCloud(resolved.scope) || resolved.scope.organizationId === 'local') throw new Error('This project does not keep its tests in SaySpec Cloud.');
    return resolved;
  };
  ipcMain.handle('test-storage:cloud-patrol-pending', (event, input: unknown) => {
    const { storage, scope } = cloudScope(event, input);
    return storage.pendingCloudPatrolTests(scope);
  });
  ipcMain.handle('test-storage:cloud-patrol-uploaded', (event, input: unknown) => {
    const { storage, value, scope } = cloudScope(event, input);
    if (typeof value.testId !== 'string' || typeof value.versionId !== 'string') throw new Error('Cloud upload receipt is invalid.');
    return storage.markCloudPatrolUploaded(scope, value.testId, value.versionId);
  });
  ipcMain.handle('test-storage:cloud-patrol-pull', (event, input: unknown) => {
    const { storage, value, scope } = cloudScope(event, input);
    const text = (item: unknown, max: number) => typeof item === 'string' && item.length <= max;
    const versions = value.versions as CloudPatrolTestVersion[];
    if (!Array.isArray(versions) || versions.length > 5_000 || versions.some((item) => !item || typeof item !== 'object' || !text(item.testId, 128) || !text(item.title, 200) || !text(item.relativePath, 512) || !text(item.source, 512 * 1024) || !/^[a-f0-9]{64}$/.test(String(item.contentHash))
      || (item.appVersion !== undefined && !text(item.appVersion, 64)) || (item.recordingId !== undefined && !text(item.recordingId, 128)) || (item.provider !== undefined && item.provider !== 'claude-code' && item.provider !== 'codex')
      || (item.dependencies !== undefined && (typeof item.dependencies !== 'object' || item.dependencies === null || Object.values(item.dependencies).some((version) => !text(version, 64)))))) throw new Error('The tests from SaySpec Cloud are invalid.');
    return storage.pullCloudPatrolTests(scope, versions);
  });
  ipcMain.handle('test-storage:set-author', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !testStorage) throw new Error('Test author request is invalid.');
    const value = input as { name?: unknown; email?: unknown } | null;
    const text = (item: unknown) => typeof item === 'string' ? item.replace(/[\r\n<>]/g, ' ').trim().slice(0, 200) : undefined;
    testStorage.setIdentity(value && typeof value === 'object' ? { name: text(value.name), email: text(value.email) } : null);
  });
  ipcMain.handle('test-library:get', (event, input: unknown) => {
    const { storage, scope } = libraryScope(event, input);
    return storage.library(scope);
  });
  ipcMain.handle('test-library:rename-test', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    if (typeof value.testId !== 'string' || typeof value.title !== 'string') throw new Error('Test storage request is invalid.');
    return storage.renameTest({ ...scope, testId: value.testId, title: value.title });
  });
  ipcMain.handle('test-library:delete-test', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    if (typeof value.testId !== 'string') throw new Error('Test storage request is invalid.');
    return storage.deleteTest({ ...scope, testId: value.testId });
  });
  ipcMain.handle('test-library:save-suite', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    return storage.saveSuite({ ...(value as unknown as SuiteChange), ...scope });
  });
  ipcMain.handle('test-library:move-test', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    if (typeof value.testId !== 'string' || (value.targetSuiteId !== null && typeof value.targetSuiteId !== 'string')) throw new Error('Test storage request is invalid.');
    return storage.moveTest({ ...scope, testId: value.testId, targetSuiteId: value.targetSuiteId as string | null });
  });
  ipcMain.handle('test-library:delete-suite', (event, input: unknown) => {
    const { storage, value, scope } = libraryScope(event, input);
    if (typeof value.suiteId !== 'string') throw new Error('Test storage request is invalid.');
    return storage.deleteSuite({ ...scope, suiteId: value.suiteId });
  });
  ipcMain.handle('machine:choose-source', async (event) => {
    if (!isTrustedMainFrame(event, rendererUrl)) throw new Error('Untrusted source-directory request');
    let selectedPath = testMode ? process.env.SAYSPEC_TEST_SOURCE_DIRECTORY : undefined;
    if (!selectedPath) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = { title: 'Choose local project source', properties: ['openDirectory'] };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      selectedPath = result.canceled ? undefined : result.filePaths[0];
    }
    if (!selectedPath) return null;
    return { handle: await selectedDirectories.register(selectedPath), label: path.basename(selectedPath) };
  });
  ipcMain.handle('machine:remember-source', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !rememberedSources || typeof input !== 'object' || input === null) throw new Error('Source request is invalid.');
    const value = input as Record<string, unknown>;
    if (typeof value.projectId !== 'string' || !value.projectId || typeof value.handle !== 'string') throw new Error('Source request is invalid.');
    await rememberedSources.remember(value.projectId, selectedDirectories.root(value.handle));
  });
  ipcMain.handle('machine:remembered-source', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !rememberedSources || typeof input !== 'object' || input === null) throw new Error('Source request is invalid.');
    const value = input as Record<string, unknown>;
    if (typeof value.projectId !== 'string' || !value.projectId) throw new Error('Source request is invalid.');
    const remembered = await rememberedSources.get(value.projectId);
    if (!remembered) return null;
    try { return { handle: await selectedDirectories.register(remembered), label: path.basename(remembered) }; }
    catch { await rememberedSources.forget(value.projectId); return null; }
  });
  ipcMain.handle('machine:check-readiness', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl)) throw new Error('Untrusted readiness request');
    if (typeof input !== 'object' || input === null) throw new Error('Readiness request is invalid.');
    return checkMachineReadiness(input as Parameters<typeof checkMachineReadiness>[0], selectedDirectories);
  });
  ipcMain.handle('machine-setup:get', async (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetup) throw new Error('Untrusted machine setup request');
    return machineSetup.report();
  });
  ipcMain.handle('machine-setup:check', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetup || typeof input !== 'object' || input === null) throw new Error('Machine setup request is invalid.');
    const value = input as { sourceHandle?: unknown; projectId?: unknown; targetType?: unknown };
    if (value.sourceHandle !== undefined && typeof value.sourceHandle !== 'string') throw new Error('Machine setup request is invalid.');
    if (value.projectId !== undefined && typeof value.projectId !== 'string') throw new Error('Machine setup request is invalid.');
    const projectId = typeof value.projectId === 'string' ? value.projectId : undefined;
    const localProject = projectId ? localWorkspace?.snapshot().projects.find((project) => project.id === projectId) : undefined;
    const targetType = value.targetType === 'flutter' || value.targetType === 'web' ? value.targetType : localProject?.targetType ?? 'flutter';
    let sourcePath: string | undefined;
    if (typeof value.sourceHandle === 'string') {
      try { sourcePath = selectedDirectories.root(value.sourceHandle); } catch { sourcePath = undefined; }
    }
    return machineSetup.checkContext({
      sourcePath,
      ...(projectId ? { project: { projectId, name: localProject?.name ?? projectId, targetType } } : {}),
    });
  });
  ipcMain.handle('machine-setup:plan', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetup || typeof input !== 'object' || input === null) throw new Error('Machine setup plan request is invalid.');
    const value = input as { workflow?: unknown; itemIds?: unknown };
    if (!['general', 'web', 'flutter-android', 'flutter-ios'].includes(String(value.workflow))) throw new Error('Machine setup plan request is invalid.');
    if (value.itemIds !== undefined && (!Array.isArray(value.itemIds) || value.itemIds.some((item) => typeof item !== 'string'))) throw new Error('Machine setup plan request is invalid.');
    return machineSetup.plan({ workflow: value.workflow as 'general' | 'web' | 'flutter-android' | 'flutter-ios', ...(Array.isArray(value.itemIds) ? { itemIds: value.itemIds as string[] } : {}) });
  });
  ipcMain.handle('machine-setup:install', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetup || typeof input !== 'object' || input === null) throw new Error('Machine setup install request is invalid.');
    const value = input as { workflow?: unknown; itemIds?: unknown };
    if (!['general', 'web', 'flutter-android', 'flutter-ios'].includes(String(value.workflow))) throw new Error('Machine setup install request is invalid.');
    if (value.itemIds !== undefined && (!Array.isArray(value.itemIds) || value.itemIds.some((item) => typeof item !== 'string'))) throw new Error('Machine setup install request is invalid.');
    return machineSetup.install({ workflow: value.workflow as 'general' | 'web' | 'flutter-android' | 'flutter-ios', ...(Array.isArray(value.itemIds) ? { itemIds: value.itemIds as string[] } : {}) });
  });
  ipcMain.handle('machine-setup:job', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetup || typeof input !== 'object' || input === null) throw new Error('Machine setup job request is invalid.');
    return machineSetup.job(String((input as { jobId?: unknown }).jobId ?? ''));
  });
  ipcMain.handle('machine-setup:cancel', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetup || typeof input !== 'object' || input === null) throw new Error('Machine setup cancellation is invalid.');
    return machineSetup.cancel(String((input as { jobId?: unknown }).jobId ?? ''));
  });
  ipcMain.handle('machine-setup-agent:start', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetupAgent || !machineSetup || !codingAgentPreferences || typeof input !== 'object' || input === null) throw new Error('AI setup terminal request is invalid.');
    const value = input as { projectId?: unknown; organizationId?: unknown; targetType?: unknown; sourceHandle?: unknown; scope?: unknown; cols?: unknown; rows?: unknown };
    if (typeof value.projectId !== 'string' || !['web', 'flutter'].includes(String(value.targetType)) || ![undefined, 'setup', 'entry-points', 'test-instructions'].includes(value.scope as string | undefined)) throw new Error('AI setup terminal request is invalid.');
    const scope = (value.scope ?? 'setup') as 'setup' | 'entry-points' | 'test-instructions';
    if (scope === 'test-instructions' ? value.sourceHandle !== undefined && typeof value.sourceHandle !== 'string' : typeof value.sourceHandle !== 'string') throw new Error('AI setup terminal request is invalid.');
    const provider = codingAgentPreferences.snapshot().provider;
    if (!provider) throw new Error('Choose Claude Code or Codex in Settings first.');
    if (scope === 'test-instructions') {
      if (typeof value.organizationId !== 'string' || !testStorage || !testInstructions) throw new Error('AI setup terminal request is invalid.');
      const projectScope = { organizationId: value.organizationId, projectId: value.projectId };
      const instructionsPath = await testInstructions.ensure(projectScope, value.targetType as 'web' | 'flutter');
      // Local and Folder storage keep the tests beside SAYSPEC.md, so the session can read them there.
      const testsDirectory = testStorage.usesFiles(projectScope) ? path.dirname(instructionsPath) : undefined;
      return machineSetupAgent.start({ projectId: value.projectId, targetType: value.targetType as 'web' | 'flutter', sourcePath: typeof value.sourceHandle === 'string' ? selectedDirectories.root(value.sourceHandle) : undefined, provider, scope, instructions: { path: instructionsPath, testsDirectory }, cols: Number(value.cols), rows: Number(value.rows) });
    }
    const sourcePath = selectedDirectories.root(value.sourceHandle as string);
    if (scope === 'entry-points') return machineSetupAgent.start({ projectId: value.projectId, targetType: value.targetType as 'web' | 'flutter', sourcePath, provider, scope, cols: Number(value.cols), rows: Number(value.rows) });
    const localProject = localWorkspace?.snapshot().projects.find((project) => project.id === value.projectId);
    const report = await machineSetup.checkContext({ sourcePath, project: { projectId: value.projectId, name: localProject?.name ?? value.projectId, targetType: value.targetType as 'web' | 'flutter' } });
    return machineSetupAgent.start({ projectId: value.projectId, targetType: value.targetType as 'web' | 'flutter', sourcePath, provider, scope, report, cols: Number(value.cols), rows: Number(value.rows) });
  });
  ipcMain.handle('entry-points:get', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !entryPoints || typeof input !== 'object' || input === null) throw new Error('Entry point request is invalid.');
    const value = input as { projectId?: unknown; targetType?: unknown };
    if (typeof value.projectId !== 'string' || (value.targetType !== 'web' && value.targetType !== 'flutter')) throw new Error('Entry point request is invalid.');
    return entryPoints.get(value.projectId, value.targetType);
  });
  ipcMain.handle('entry-points:save', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !entryPoints || typeof input !== 'object' || input === null) throw new Error('Entry point request is invalid.');
    const value = input as { projectId?: unknown; targetType?: unknown; entryPoints?: unknown };
    if (typeof value.projectId !== 'string' || (value.targetType !== 'web' && value.targetType !== 'flutter')) throw new Error('Entry point request is invalid.');
    const saved = await entryPoints.save({ projectId: value.projectId, targetType: value.targetType, entryPoints: value.entryPoints, updatedBy: 'user' });
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('entry-points:changed', saved);
    return saved;
  });
  ipcMain.handle('machine-setup-agent:write', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetupAgent || typeof input !== 'object' || input === null) throw new Error('AI setup terminal input is invalid.');
    const value = input as { projectId?: unknown; data?: unknown };
    if (typeof value.projectId !== 'string' || typeof value.data !== 'string') throw new Error('AI setup terminal input is invalid.');
    machineSetupAgent.write(value.projectId, value.data);
  });
  ipcMain.handle('machine-setup-agent:resize', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetupAgent || typeof input !== 'object' || input === null) throw new Error('AI setup terminal resize is invalid.');
    const value = input as { projectId?: unknown; cols?: unknown; rows?: unknown };
    machineSetupAgent.resize(String(value.projectId ?? ''), Number(value.cols), Number(value.rows));
  });
  ipcMain.handle('machine-setup-agent:close', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !machineSetupAgent || typeof input !== 'object' || input === null) throw new Error('AI setup terminal close is invalid.');
    return machineSetupAgent.close(String((input as { projectId?: unknown }).projectId ?? ''));
  });
  ipcMain.handle('flutter:devices', async (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions) throw new Error('Untrusted Flutter device request');
    return flutterSessions.devices();
  });
  ipcMain.handle('flutter:start-device', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Device start request is invalid.');
    const deviceId = (input as { deviceId?: unknown }).deviceId;
    if (typeof deviceId !== 'string' || !deviceId) throw new Error('Device start request is invalid.');
    return flutterSessions.startDevice(deviceId);
  });
  ipcMain.handle('flutter:recorder-sdk', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter recorder check is invalid.');
    const value = input as { sourceHandle?: unknown };
    const sourcePath = typeof value.sourceHandle === 'string' ? selectedDirectories.root(value.sourceHandle) : undefined;
    return flutterSessions.recorderSdkCompatibility(sourcePath);
  });
  ipcMain.handle('flutter:preview-integration', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || typeof input !== 'object' || input === null) throw new Error('Flutter integration preview is invalid.');
    const value = input as { sourceHandle?: unknown; appId?: unknown };
    if (typeof value.sourceHandle !== 'string' || typeof value.appId !== 'string') throw new Error('Flutter integration preview is invalid.');
    const sourcePath = selectedDirectories.root(value.sourceHandle);
    return previewFlutterIntegration({ sourcePath, appId: value.appId });
  });
  ipcMain.handle('flutter:apply-integration', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || typeof input !== 'object' || input === null) throw new Error('Flutter integration request is invalid.');
    const value = input as { sourceHandle?: unknown; appId?: unknown; relativePaths?: unknown };
    if (typeof value.sourceHandle !== 'string' || typeof value.appId !== 'string' || !Array.isArray(value.relativePaths) || value.relativePaths.some((item) => typeof item !== 'string')) throw new Error('Flutter integration request is invalid.');
    const sourcePath = selectedDirectories.root(value.sourceHandle);
    const preview = await previewFlutterIntegration({ sourcePath, appId: value.appId });
    const { applied, preview: refreshed } = await applyFlutterIntegration({ sourcePath, preview, relativePaths: value.relativePaths as string[] });
    // Nothing selected means the files are already in place and only the
    // dependency is unresolved, which pub get fixes on its own.
    if (applied.includes('pubspec.yaml') || !value.relativePaths.length) await resolveProjectDependencies(sourcePath);
    return { ...refreshed, applied };
  });
  ipcMain.handle('flutter:capture-start', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter recording request is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.organizationId, value.projectId, value.projectName, value.deviceId, value.sourceHandle].every((item) => typeof item === 'string')) throw new Error('Flutter recording request is invalid.');
    return flutterSessions.start({
      organizationId: String(value.organizationId),
      projectId: String(value.projectId),
      projectName: String(value.projectName),
      deviceId: String(value.deviceId),
      ...(typeof value.appId === 'string' && value.appId.trim() ? { appId: value.appId.trim() } : {}),
      ...(typeof value.flavor === 'string' && value.flavor ? { flavor: value.flavor } : {}),
      ...(value.entryPoint !== undefined ? { entryPoint: validateEntryPoints('flutter', [value.entryPoint])[0]! } : {}),
      ...(typeof value.title === 'string' && value.title ? { title: value.title } : {}),
    }, selectedDirectories.root(String(value.sourceHandle)));
  });
  for (const [channel, action] of [['flutter:capture-pause', 'pause'], ['flutter:capture-resume', 'resume']] as const) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter recording control is invalid.');
      const captureId = String((input as { captureId?: unknown }).captureId ?? '');
      return action === 'pause' ? flutterSessions.pause(captureId) : flutterSessions.resume(captureId);
    });
  }
  ipcMain.handle('flutter:capture-stop', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter recording control is invalid.');
    return flutterSessions.stop(String((input as { captureId?: unknown }).captureId ?? ''));
  });
  ipcMain.handle('flutter:capture-active', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter recording query is invalid.');
    return flutterSessions.active(String((input as { projectId?: unknown }).projectId ?? ''));
  });
  ipcMain.handle('flutter:capture-cancel', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter recording control is invalid.');
    await flutterSessions.cancel(String((input as { captureId?: unknown }).captureId ?? ''));
  });
  ipcMain.handle('flutter:narration-begin', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter narration request is invalid.');
    const value = input as { captureId?: unknown; mimeType?: unknown };
    if (typeof value.captureId !== 'string' || typeof value.mimeType !== 'string') throw new Error('Flutter narration request is invalid.');
    return flutterSessions.beginNarration(value.captureId, value.mimeType);
  });
  ipcMain.handle('flutter:narration-append', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter narration request is invalid.');
    const value = input as { captureId?: unknown; mimeType?: unknown; bytes?: unknown };
    if (typeof value.captureId !== 'string' || typeof value.mimeType !== 'string' || !(value.bytes instanceof Uint8Array)) throw new Error('Flutter narration request is invalid.');
    await flutterSessions.appendNarration(value.captureId, value.mimeType, value.bytes);
  });
  ipcMain.handle('flutter:narration-finish', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterSessions || typeof input !== 'object' || input === null) throw new Error('Flutter narration request is invalid.');
    return flutterSessions.finishNarration(String((input as { captureId?: unknown }).captureId ?? ''));
  });
  ipcMain.handle('flutter:capture-list', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterCaptures || typeof input !== 'object' || input === null) throw new Error('Flutter recording query is invalid.');
    return flutterCaptures.list(String((input as { projectId?: unknown }).projectId ?? ''));
  });
  ipcMain.handle('flutter:capture-get', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterCaptures || typeof input !== 'object' || input === null) throw new Error('Flutter recording query is invalid.');
    const value = input as { projectId?: unknown; captureId?: unknown };
    return flutterCaptures.get(String(value.projectId ?? ''), String(value.captureId ?? ''));
  });
  ipcMain.handle('flutter:capture-screenshot', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterCaptures || typeof input !== 'object' || input === null) throw new Error('Flutter recording asset request is invalid.');
    const value = input as { captureId?: unknown; artifactId?: unknown };
    return flutterCaptures.readArtifact(String(value.captureId ?? ''), String(value.artifactId ?? ''));
  });
  ipcMain.handle('flutter:narration-read', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterCaptures || typeof input !== 'object' || input === null) throw new Error('Flutter narration asset request is invalid.');
    return flutterCaptures.readNarration(String((input as { captureId?: unknown }).captureId ?? ''));
  });
  ipcMain.handle('flutter:share-state', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterCaptures || typeof input !== 'object' || input === null) throw new Error('Flutter share state request is invalid.');
    const value = input as { captureId?: unknown; state?: unknown };
    if (typeof value.captureId !== 'string' || !['local', 'uploading', 'shared', 'failed'].includes(String(value.state))) throw new Error('Flutter share state request is invalid.');
    return flutterCaptures.setShareState(value.captureId, value.state as 'local' | 'uploading' | 'shared' | 'failed');
  });
  ipcMain.handle('flutter:transcribe', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !flutterCaptures || !localTranscription || typeof input !== 'object' || input === null) throw new Error('Flutter transcription request is invalid.');
    const value = input as { projectId?: unknown; captureId?: unknown; cloud?: unknown };
    if (typeof value.projectId !== 'string' || typeof value.captureId !== 'string') throw new Error('Flutter transcription request is invalid.');
    const captureId = value.captureId;
    const capture = await flutterCaptures.get(value.projectId, captureId);
    const { path: audioPath, narration } = await flutterCaptures.narrationPath(value.projectId, captureId);
    const events = capture.events.map((item) => ({ id: item.id, elapsedMs: Math.max(0, Math.round(item.hostAlignedMs - narration.startedAtHostMonotonicMs)) }))
      .filter((item) => item.elapsedMs <= narration.durationMs + capture.clock.uncertaintyMs);
    const { provider, options } = await transcriptionFor(captureId, value.cloud);
    return provider.startFlutter({ captureId, audioPath, durationMs: narration.durationMs, timingUncertaintyMs: capture.clock.uncertaintyMs, events, persist: (transcript) => flutterCaptures!.writeTranscript(captureId, transcript) }, options);
  });
  ipcMain.handle('patrol:list-tests', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol test query is invalid.');
    const value = input as { projectId?: unknown; organizationId?: unknown };
    await syncFolderTests(value);
    return patrolRuns.listTests(String(value.projectId ?? ''), String(value.organizationId ?? 'local'));
  });
  ipcMain.handle('patrol:list-versions', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol version query is invalid.');
    const value = input as { projectId?: unknown; organizationId?: unknown; testId?: unknown };
    return patrolRuns.versions(String(value.projectId ?? ''), String(value.organizationId ?? 'local'), String(value.testId ?? ''));
  });
  ipcMain.handle('patrol-generation:start', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolGeneration || !codingAgentPreferences || typeof input !== 'object' || input === null) throw new Error('Patrol generation request is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.projectId, value.sessionId, value.sourceHandle, value.deviceId, value.appId].every((item) => typeof item === 'string')) throw new Error('Patrol generation request is invalid.');
    const provider = codingAgentPreferences.snapshot().provider;
    if (!provider) throw new Error('Choose Claude Code or Codex in Settings first.');
    return patrolGeneration.start({ projectId: String(value.projectId), sessionId: String(value.sessionId), sourcePath: selectedDirectories.root(String(value.sourceHandle)), deviceId: String(value.deviceId), appId: String(value.appId), ...(typeof value.flavor === 'string' && value.flavor ? { flavor: value.flavor } : {}), provider, cols: Number(value.cols), rows: Number(value.rows) });
  });
  ipcMain.handle('patrol-generation:write', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolGeneration || typeof input !== 'object' || input === null) throw new Error('Patrol generation input is invalid.');
    const value = input as { sessionId?: unknown; data?: unknown };
    if (typeof value.data !== 'string') throw new Error('Patrol generation input is invalid.');
    patrolGeneration.write(String(value.sessionId ?? ''), value.data);
  });
  ipcMain.handle('patrol-generation:resize', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolGeneration || typeof input !== 'object' || input === null) throw new Error('Patrol generation resize is invalid.');
    const value = input as { sessionId?: unknown; cols?: unknown; rows?: unknown };
    patrolGeneration.resize(String(value.sessionId ?? ''), Number(value.cols), Number(value.rows));
  });
  ipcMain.handle('patrol-generation:close', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolGeneration || typeof input !== 'object' || input === null) throw new Error('Patrol generation close is invalid.');
    return patrolGeneration.close(String((input as { sessionId?: unknown }).sessionId ?? ''));
  });
  ipcMain.handle('patrol:run', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunner || typeof input !== 'object' || input === null) throw new Error('Patrol run request is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.organizationId, value.projectId, value.testId, value.deviceId, value.sourceHandle].every((item) => typeof item === 'string')) throw new Error('Patrol run request is invalid.');
    // Running a test's latest version runs its file as it is now.
    if (typeof value.versionId !== 'string') await syncFolderTests(value);
    return patrolRunner.run({ organizationId: String(value.organizationId), projectId: String(value.projectId), testId: String(value.testId), ...(typeof value.versionId === 'string' ? { versionId: value.versionId } : {}), deviceId: String(value.deviceId) }, selectedDirectories.root(String(value.sourceHandle)));
  });
  ipcMain.handle('patrol:cancel', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunner || typeof input !== 'object' || input === null) throw new Error('Patrol cancellation is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; testId?: unknown; attemptId?: unknown };
    return patrolRunner.cancel({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), testId: String(value.testId ?? ''), attemptId: String(value.attemptId ?? '') });
  });
  ipcMain.handle('patrol:attempts', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol attempt query is invalid.');
    const value = input as { projectId?: unknown; organizationId?: unknown; testId?: unknown };
    return patrolRuns.attempts(String(value.projectId ?? ''), String(value.organizationId ?? 'local'), String(value.testId ?? ''));
  });
  ipcMain.handle('patrol-run:create', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol run request is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.organizationId, value.projectId, value.name].every((item) => typeof item === 'string') || !Array.isArray(value.testIds) || !value.testIds.every((item) => typeof item === 'string')) throw new Error('Patrol run request is invalid.');
    await syncFolderTests(value);
    return patrolRuns.createRun({ organizationId: String(value.organizationId), projectId: String(value.projectId), name: String(value.name), testIds: value.testIds as string[] });
  });
  ipcMain.handle('patrol-run:start', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunner || typeof input !== 'object' || input === null) throw new Error('Patrol run start is invalid.');
    const value = input as Record<string, unknown>;
    if (![value.organizationId, value.projectId, value.runId, value.deviceId, value.sourceHandle].every((item) => typeof item === 'string')) throw new Error('Patrol run start is invalid.');
    return patrolRunner.startRun({ organizationId: String(value.organizationId), projectId: String(value.projectId), runId: String(value.runId), deviceId: String(value.deviceId) }, selectedDirectories.root(String(value.sourceHandle)));
  });
  ipcMain.handle('patrol-run:list', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol run query is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown };
    return patrolRuns.runs(String(value.projectId ?? ''), String(value.organizationId ?? 'local'));
  });
  ipcMain.handle('patrol-run:stop', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunner || typeof input !== 'object' || input === null) throw new Error('Patrol run stop is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown };
    return patrolRunner.stopRun({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? '') });
  });
  ipcMain.handle('patrol-run:delete', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol run deletion is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown };
    const scope = { organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? '') };
    await patrolRuns.deleteRun(scope);
    await patrolRunAnalysis?.discard(scope.runId);
  });
  ipcMain.handle('patrol-run:log', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol run log request is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown; attemptId?: unknown };
    const scope = { organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? '') };
    return patrolRuns.readRunLog(scope, typeof value.attemptId === 'string' ? value.attemptId : undefined);
  });
  ipcMain.handle('patrol-run:console', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunner || typeof input !== 'object' || input === null) throw new Error('Patrol run console request is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown };
    return patrolRunner.console({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? '') });
  });
  ipcMain.handle('patrol-run-analysis:attach', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunAnalysis || typeof input !== 'object' || input === null) throw new Error('Analysis request is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown };
    return patrolRunAnalysis.attach({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? '') });
  });
  ipcMain.handle('patrol-run-analysis:write', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunAnalysis || typeof input !== 'object' || input === null) throw new Error('Analysis terminal input is invalid.');
    const value = input as { runId?: unknown; sessionToken?: unknown; data?: unknown };
    patrolRunAnalysis.write(String(value.runId ?? ''), String(value.sessionToken ?? ''), value.data as string);
  });
  ipcMain.handle('patrol-run-analysis:resize', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunAnalysis || typeof input !== 'object' || input === null) throw new Error('Analysis terminal resize is invalid.');
    const value = input as { runId?: unknown; sessionToken?: unknown; cols?: unknown; rows?: unknown };
    patrolRunAnalysis.resize(String(value.runId ?? ''), String(value.sessionToken ?? ''), Number(value.cols), Number(value.rows));
  });
  ipcMain.handle('patrol-run-analysis:restart', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || !patrolRunAnalysis || typeof input !== 'object' || input === null) throw new Error('Analysis request is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown; sourceHandle?: unknown };
    const run = patrolRuns.run({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? '') });
    if (run.state === 'running' || run.state === 'queued') throw new Error('Analyze a run after it finishes.');
    await patrolRunAnalysis.start(run, selectedDirectories.root(String(value.sourceHandle ?? '')));
    return patrolRuns.run({ organizationId: run.organizationId, projectId: run.projectId, runId: run.id });
  });
  ipcMain.handle('patrol-run-analysis:open-report', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunAnalysis || typeof input !== 'object' || input === null) throw new Error('Report request is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown };
    return patrolRunAnalysis.openReport({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? '') });
  });
  ipcMain.handle('patrol-run-analysis:prepare-fix', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRunAnalysis || typeof input !== 'object' || input === null) throw new Error('Fix request is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; runId?: unknown; issueId?: unknown; testId?: unknown };
    return patrolRunAnalysis.prepareFix({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), runId: String(value.runId ?? ''), issueId: String(value.issueId ?? ''), testId: String(value.testId ?? '') });
  });
  ipcMain.handle('patrol:artifact', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || typeof input !== 'object' || input === null) throw new Error('Patrol artifact request is invalid.');
    const value = input as { organizationId?: unknown; projectId?: unknown; testId?: unknown; attemptId?: unknown; relativePath?: unknown };
    return patrolRuns.readArtifact({ organizationId: String(value.organizationId ?? ''), projectId: String(value.projectId ?? ''), testId: String(value.testId ?? ''), attemptId: String(value.attemptId ?? ''), relativePath: String(value.relativePath ?? '') });
  });
  ipcMain.handle('patrol:leases', (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns) throw new Error('Untrusted Patrol lease request');
    return patrolRuns.leases();
  });
  ipcMain.handle('recording:microphone-access', async (event) => {
    if (!isTrustedMainFrame(event, rendererUrl)) throw new Error('Untrusted microphone request');
    if (testMode && process.env.SAYSPEC_MICROPHONE_DENIED === '1') return { state: 'denied', detail: 'Microphone access is off in the native verification fixture.' };
    if (testMode && process.env.SAYSPEC_RECORDING_SMOKE === '1') { microphoneGrantUntil = Date.now() + 60_000; return { state: 'granted', detail: 'Synthetic microphone enabled for native verification.' }; }
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      const granted = status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
      if (!granted) return { state: 'denied', detail: 'Microphone access is off. Enable SaySpec in System Settings → Privacy & Security → Microphone.' };
    }
    microphoneGrantUntil = Date.now() + 60_000;
    return { state: 'granted', detail: 'Microphone access is available for this recording.' };
  });
  ipcMain.handle('recording:start-web', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingManager || typeof input !== 'object' || input === null) throw new Error('Recording request is invalid.');
    return recordingManager.start(input as WebRecordingStartInput);
  });
  ipcMain.handle('recording:begin-segment', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingManager || typeof input !== 'object' || input === null) throw new Error('Recording request is invalid.');
    return recordingManager.begin(String((input as { recordingId?: unknown }).recordingId ?? ''));
  });
  ipcMain.handle('recording:append-audio', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingManager || typeof input !== 'object' || input === null) throw new Error('Audio request is invalid.');
    const value = input as { recordingId?: unknown; segmentId?: unknown; mimeType?: unknown; bytes?: unknown };
    const bytes = value.bytes instanceof Uint8Array ? value.bytes : value.bytes instanceof ArrayBuffer ? new Uint8Array(value.bytes) : undefined;
    if (!bytes || typeof value.recordingId !== 'string' || typeof value.segmentId !== 'string' || typeof value.mimeType !== 'string') throw new Error('Audio request is invalid.');
    await recordingManager.appendAudio({ recordingId: value.recordingId, segmentId: value.segmentId, mimeType: value.mimeType, bytes });
  });
  for (const [channel, operation] of [
    ['recording:pause', (id: string) => recordingManager!.pause(id)],
    ['recording:resume', (id: string) => recordingManager!.resume(id)],
    ['recording:cancel', (id: string) => recordingManager!.cancel(id)],
  ] as const) ipcMain.handle(channel, async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingManager || typeof input !== 'object' || input === null) throw new Error('Recording control is invalid.');
    return operation(String((input as { recordingId?: unknown }).recordingId ?? ''));
  });
  ipcMain.handle('recording:stop', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingManager || !localModels || !localTranscription || typeof input !== 'object' || input === null) throw new Error('Recording control is invalid.');
    const result = await recordingManager.stop(String((input as { recordingId?: unknown }).recordingId ?? ''));
    const setup = await localModels.snapshot();
    if (setup.runtime.state === 'ready' && setup.model.state === 'installed') void localTranscription.start(result.review.id);
    return result;
  });
  ipcMain.handle('recording:interrupt', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingManager || typeof input !== 'object' || input === null) throw new Error('Recording control is invalid.');
    const value = input as { recordingId?: unknown; reason?: unknown };
    if (typeof value.recordingId !== 'string' || typeof value.reason !== 'string') throw new Error('Recording control is invalid.');
    return recordingManager.interrupt(value.recordingId, value.reason);
  });
  ipcMain.handle('recording:list', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingStore || typeof input !== 'object' || input === null) throw new Error('Recording query is invalid.');
    return recordingStore.list(String((input as { projectId?: unknown }).projectId ?? ''));
  });
  ipcMain.handle('recording:get', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingStore || typeof input !== 'object' || input === null) throw new Error('Recording query is invalid.');
    const value = input as { projectId?: unknown; recordingId?: unknown };
    return recordingStore.get(String(value.projectId ?? ''), String(value.recordingId ?? ''));
  });
  ipcMain.handle('recording:read-asset', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingStore || typeof input !== 'object' || input === null) throw new Error('Recording asset request is invalid.');
    const value = input as { recordingId?: unknown; artifactId?: unknown };
    return recordingStore.readAsset(String(value.recordingId ?? ''), String(value.artifactId ?? ''));
  });
  ipcMain.handle('recording:share-state', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingStore || typeof input !== 'object' || input === null) throw new Error('Recording share request is invalid.');
    const value = input as { recordingId?: unknown; state?: unknown };
    return recordingStore.setShareState(String(value.recordingId ?? ''), value.state as Parameters<RecordingStore['setShareState']>[1]);
  });
  ipcMain.handle('transcription:setup', (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localModels) throw new Error('Untrusted transcription request.');
    return localModels.snapshot();
  });
  ipcMain.handle('transcription:model-install', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localModels || typeof input !== 'object' || input === null) throw new Error('Model install request is invalid.');
    return localModels.install(String((input as { modelId?: unknown }).modelId ?? ''));
  });
  ipcMain.handle('transcription:model-cancel', (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localModels) throw new Error('Untrusted model cancellation request.');
    return localModels.cancelInstall();
  });
  ipcMain.handle('transcription:model-remove', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localModels || typeof input !== 'object' || input === null) throw new Error('Model removal request is invalid.');
    return localModels.remove(String((input as { modelId?: unknown }).modelId ?? ''));
  });
  ipcMain.handle('transcription:start', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localTranscription || typeof input !== 'object' || input === null) throw new Error('Transcription request is invalid.');
    const value = input as { recordingId?: unknown; cloud?: unknown };
    const recordingId = String(value.recordingId ?? '');
    const { provider, options } = await transcriptionFor(recordingId, value.cloud);
    return provider.start(recordingId, options);
  });
  ipcMain.handle('transcription:cancel', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !localTranscription || typeof input !== 'object' || input === null) throw new Error('Transcription cancellation request is invalid.');
    const recordingId = String((input as { recordingId?: unknown }).recordingId ?? '');
    return (cloudTranscription?.running(recordingId) ? cloudTranscription : localTranscription).cancel(recordingId);
  });
  ipcMain.handle('transcription:save-edits', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingStore || typeof input !== 'object' || input === null) throw new Error('Transcript edit request is invalid.');
    const value = input as { recordingId?: unknown; edits?: unknown };
    if (typeof value.recordingId !== 'string' || !Array.isArray(value.edits)) throw new Error('Transcript edit request is invalid.');
    return recordingStore.saveTranscriptEdits(value.recordingId, value.edits as { segmentId: string; text: string }[]);
  });
  ipcMain.handle('transcription:save-intent', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !recordingStore || typeof input !== 'object' || input === null) throw new Error('Intent review request is invalid.');
    const value = input as { recordingId?: unknown; intent?: unknown };
    if (typeof value.recordingId !== 'string' || typeof value.intent !== 'object' || value.intent === null) throw new Error('Intent review request is invalid.');
    return recordingStore.saveIntent(value.recordingId, value.intent as Parameters<RecordingStore['saveIntent']>[1]).then(() => recordingStore!.get(recordingStore!.listByRecording(value.recordingId as string).projectId, value.recordingId as string));
  });
  ipcMain.handle('generation:readiness', (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !playwrightGeneration) throw new Error('Untrusted coding-agent readiness request.');
    return playwrightGeneration.readiness();
  });
  ipcMain.handle('generation:preference-get', (event) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !codingAgentPreferences) throw new Error('Untrusted coding-agent preference request.');
    return codingAgentPreferences.snapshot();
  });
  ipcMain.handle('generation:preference-select', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !codingAgentPreferences || typeof input !== 'object' || input === null) throw new Error('Coding-agent preference request is invalid.');
    const provider = String((input as { provider?: unknown }).provider ?? '');
    if (!['claude-code', 'codex'].includes(provider)) throw new Error('Choose Claude Code or Codex.');
    return codingAgentPreferences.select(provider as CodingAgentProviderId);
  });
  ipcMain.handle('generation:start', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !playwrightGeneration || typeof input !== 'object' || input === null) throw new Error('Playwright generation request is invalid.');
    const value = input as { recordingId?: unknown; provider?: unknown };
    if (typeof value.recordingId !== 'string' || !['claude-code', 'codex'].includes(String(value.provider))) throw new Error('Playwright generation request is invalid.');
    const generated = await playwrightGeneration.start(value.recordingId, value.provider as CodingAgentProviderId);
    if (generated.state === 'draft' && generated.provenance.executionValidated && testStorage) await testStorage.saveGeneratedWebTest(generated);
    return generated;
  });
  ipcMain.handle('generation:cancel', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !playwrightGeneration || typeof input !== 'object' || input === null) throw new Error('Playwright generation cancellation is invalid.');
    return playwrightGeneration.cancel(String((input as { recordingId?: unknown }).recordingId ?? ''));
  });
  ipcMain.handle('saved-web-test:versions', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test query is invalid.');
    const value = input as { organizationId: string; projectId: string; recordingId: string };
    return savedWebTests.versionsForRecording(value.organizationId, value.projectId, value.recordingId);
  });
  ipcMain.handle('saved-web-test:project-versions', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test query is invalid.');
    const value = input as { organizationId: string; projectId: string };
    await syncFolderTests(value);
    return savedWebTests.projectVersions(value.organizationId, value.projectId);
  });
  ipcMain.handle('saved-web-test:attempts', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test query is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string };
    return savedWebTests.attempts(value.organizationId, value.projectId, value.testId);
  });
  ipcMain.handle('failure-analysis:list', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || !input || typeof input !== 'object') throw new Error('Analysis query is invalid.');
    if ((input as { platform?: unknown }).platform === 'patrol') { if (!patrolRuns) throw new Error('Patrol analysis is unavailable.'); return patrolRuns.failureAnalyses(input as Parameters<PatrolRunStore['failureAnalyses']>[0]); }
    return savedWebTests.failureAnalyses(input as Parameters<SavedWebTestStore['failureAnalyses']>[0]);
  });
  ipcMain.handle('failure-analysis:start', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !failureAnalysis || !input || typeof input !== 'object') throw new Error('Analysis request is invalid.');
    if ((input as { platform?: unknown }).platform === 'patrol') return failureAnalysis.analyzePatrol(input as Parameters<FailureAnalysisManager['analyzePatrol']>[0]);
    return failureAnalysis.analyze(input as Parameters<FailureAnalysisManager['analyze']>[0]);
  });
  ipcMain.handle('failure-analysis:cancel', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !failureAnalysis || !input || typeof input !== 'object') throw new Error('Analysis cancellation is invalid.');
    failureAnalysis.cancel(String((input as { attemptId?: unknown }).attemptId ?? ''));
  });
  // Tests in a storage folder are not in Firebase, so the folder itself is the authority: the test must be in it.
  const locallyAuthorized = (input: { organizationId: string; projectId: string }) => input.organizationId === 'local' || Boolean(testStorage && !testStorage.isCloud(input));
  const authorizeFixScope = async (input: { organizationId: string; projectId: string; testId: string; idToken?: string }) => {
    if (input.organizationId !== 'local' && testStorage && !testStorage.isCloud(input)) {
      if (!await testStorage.has(input, input.testId)) throw new Error('This test is not in the project’s test storage.');
      return 'local_user';
    }
    if (testStorage?.usesFiles(input)) {
      if (!await testStorage.has(input, input.testId)) throw new Error('This test is not in the project’s test storage.');
      return 'guest';
    }
    if (input.organizationId === 'local') {
      const snapshot = localWorkspace?.snapshot();
      if (!snapshot?.projects.some((project) => project.id === input.projectId && project.targetType === 'web') || !snapshot.tests.some((test) => test.id === input.testId && test.projectId === input.projectId && test.status !== 'archived')) throw new Error('This local test is not active in the selected Web project.');
      return 'guest';
    }
    return callManagedFixBackend('managedFixReadAuthorize', input.idToken, { organizationId: input.organizationId, projectId: input.projectId, testId: input.testId });
  };
  ipcMain.handle('managed-fix:list', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || !input || typeof input !== 'object') throw new Error('Fix proposal query is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; idToken?: string };
    await authorizeFixScope(value); return savedWebTests.fixProposals(value);
  });
  ipcMain.handle('managed-fix:start', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !managedFixSessions || !codingAgentPreferences || !input || typeof input !== 'object') throw new Error('Fix session request is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; attemptId: string; analysisId: string; cols: number; rows: number; idToken?: string };
    const provider = codingAgentPreferences.snapshot().provider;
    if (!provider) throw new Error('Choose Claude Code or Codex in Settings first.');
    await authorizeFixScope(value); return managedFixSessions.start(value, provider, value.cols, value.rows);
  });
  ipcMain.handle('managed-fix:write', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !managedFixSessions || !input || typeof input !== 'object') throw new Error('Fix terminal input is invalid.');
    const value = input as { attemptId: string; sessionToken: string; data: string }; managedFixSessions.write(value.attemptId, value.sessionToken, value.data);
  });
  ipcMain.handle('managed-fix:resize', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !managedFixSessions || !input || typeof input !== 'object') throw new Error('Fix terminal resize is invalid.');
    const value = input as { attemptId: string; sessionToken: string; cols: number; rows: number }; managedFixSessions.resize(value.attemptId, value.sessionToken, value.cols, value.rows);
  });
  ipcMain.handle('managed-fix:close', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !managedFixSessions || !input || typeof input !== 'object') throw new Error('Fix terminal closure is invalid.');
    const value = input as { attemptId: string; sessionToken: string }; return managedFixSessions.close(value.attemptId, value.sessionToken);
  });
  ipcMain.handle('managed-fix:decide', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || !input || typeof input !== 'object') throw new Error('Fix decision is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; kind: 'approve' | 'reject'; idToken?: string };
    if (value.kind !== 'approve' && value.kind !== 'reject') throw new Error('Fix decision is invalid.');
    const proposal = savedWebTests.fixProposals(value).find((item) => item.id === value.proposalId);
    if (!proposal || proposal.status !== 'proposed') throw new Error('This proposal is not awaiting a decision.');
    const actorUid = locallyAuthorized(value) ? await authorizeFixScope(value)
      : await callManagedFixBackend('managedFixDecide', value.idToken, { organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, proposalId: proposal.id, attemptId: proposal.attemptId, analysisId: proposal.analysisId, baseVersionId: proposal.baseVersionId, baseContentHash: proposal.baseContentHash, proposalHash: proposal.proposalHash, kind: value.kind });
    return savedWebTests.decideManagedTestFix({ ...value, actorUid });
  });
  ipcMain.handle('managed-fix:apply', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || !input || typeof input !== 'object') throw new Error('Fix application is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; idToken?: string };
    const proposal = savedWebTests.fixProposals(value).find((item) => item.id === value.proposalId);
    if (!proposal) throw new Error('Fix proposal was not found.');
    const actorUid = locallyAuthorized(value) ? await authorizeFixScope(value)
      : proposal.status === 'applied' ? proposal.decision?.actorUid
        : await callManagedFixBackend('managedFixApplyAuthorize', value.idToken, { organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, proposalId: proposal.id, baseContentHash: proposal.baseContentHash, proposalHash: proposal.proposalHash });
    if (!actorUid) throw new Error('The approved actor is missing.');
    const version = await savedWebTests.applyManagedTestFix({ ...value, actorUid });
    await testStorage?.saveWebVersion(version);
    if (!locallyAuthorized(value)) await callManagedFixBackend('managedFixAppliedRecord', value.idToken, { organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, proposalId: proposal.id, baseContentHash: proposal.baseContentHash, proposalHash: proposal.proposalHash, versionId: version.id, versionNumber: version.version, versionHash: version.contentHash });
    return version;
  });
  const authorizeApplicationFixScope = async (input: { organizationId: string; projectId: string; target: 'web' | 'flutter'; testId?: string; idToken?: string }) => {
    if (input.target !== 'web' && input.target !== 'flutter') throw new Error('Application target is invalid.');
    if (input.organizationId === 'local') {
      const snapshot = localWorkspace?.snapshot();
      if (!snapshot?.projects.some((project) => project.id === input.projectId && project.targetType === input.target)) throw new Error('The selected local project is unavailable.');
      if (input.testId) {
        const saved = testStorage?.usesFiles(input) ? await testStorage.has(input, input.testId)
          : input.target === 'flutter'
          ? patrolRuns?.listTests(input.projectId, input.organizationId).some((test) => test.id === input.testId)
          : snapshot.tests.some((test) => test.id === input.testId && test.projectId === input.projectId && test.status !== 'archived');
        if (!saved) throw new Error('The selected local test is unavailable.');
      }
      return 'guest';
    }
    return callManagedFixBackend('applicationFixReadAuthorize', input.idToken, { organizationId: input.organizationId, projectId: input.projectId, target: input.target });
  };
  ipcMain.handle('application-fix:list', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixes || !input || typeof input !== 'object') throw new Error('Application proposal query is invalid.');
    const value = input as { organizationId: string; projectId: string; target: 'web' | 'flutter'; testId?: string; idToken?: string };
    await authorizeApplicationFixScope(value);
    return applicationFixes.list(value);
  });
  ipcMain.handle('application-fix:start', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixSessions || !codingAgentPreferences || !savedWebTests || !patrolRuns || !input || typeof input !== 'object') throw new Error('Application fix session request is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; attemptId: string; analysisId: string; target: 'web' | 'flutter'; sourceHandle: string; cols: number; rows: number; idToken?: string };
    const provider = codingAgentPreferences.snapshot().provider;
    if (!provider) throw new Error('Choose Claude Code or Codex in Settings first.');
    await authorizeApplicationFixScope(value);
    const analyses = value.target === 'web' ? savedWebTests.failureAnalyses(value) : patrolRuns.failureAnalyses(value);
    const analysis = analyses.find((item) => item.id === value.analysisId);
    if (!analysis) throw new Error('The failure analysis was not found in this project.');
    selectedDirectories.root(value.sourceHandle);
    return applicationFixSessions.start(value, analysis, provider, value.cols, value.rows);
  });
  ipcMain.handle('application-fix:write', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixSessions || !input || typeof input !== 'object') throw new Error('Application fix terminal input is invalid.');
    const value = input as { attemptId: string; sessionToken: string; data: string };
    applicationFixSessions.write(value.attemptId, value.sessionToken, value.data);
  });
  ipcMain.handle('application-fix:resize', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixSessions || !input || typeof input !== 'object') throw new Error('Application fix terminal resize is invalid.');
    const value = input as { attemptId: string; sessionToken: string; cols: number; rows: number };
    applicationFixSessions.resize(value.attemptId, value.sessionToken, value.cols, value.rows);
  });
  ipcMain.handle('application-fix:close', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixSessions || !input || typeof input !== 'object') throw new Error('Application fix terminal close is invalid.');
    const value = input as { attemptId: string; sessionToken: string };
    return applicationFixSessions.close(value.attemptId, value.sessionToken);
  });
  ipcMain.handle('application-fix:decide', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixes || !input || typeof input !== 'object') throw new Error('Application fix decision is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceHandle: string; kind: 'approve' | 'reject'; idToken?: string };
    if (value.kind !== 'approve' && value.kind !== 'reject') throw new Error('Application fix decision is invalid.');
    await authorizeApplicationFixScope(value);
    const proposal = applicationFixes.get(value);
    if (proposal.target !== value.target) throw new Error('Application proposal target changed.');
    const actorUid = value.organizationId === 'local' ? 'guest' : await callManagedFixBackend('applicationFixDecide', value.idToken, { organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, proposalId: proposal.id, attemptId: proposal.attemptId, analysisId: proposal.analysisId, target: proposal.target, testVersionId: proposal.testVersionId, testVersionHash: proposal.testVersionHash, sourceRootHash: proposal.sourceRootHash, proposalHash: proposal.proposalHash, kind: value.kind });
    return applicationFixes.decide({ ...value, actorUid, handles: selectedDirectories });
  });
  ipcMain.handle('application-fix:apply', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixes || !input || typeof input !== 'object') throw new Error('Application fix application is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceHandle: string; idToken?: string };
    await authorizeApplicationFixScope(value);
    const proposal = applicationFixes.get(value);
    if (proposal.target !== value.target) throw new Error('Application proposal target changed.');
    const actorUid = value.organizationId === 'local' ? 'guest' : await callManagedFixBackend('applicationFixApplyAuthorize', value.idToken, { organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, proposalId: proposal.id, target: proposal.target, sourceRootHash: proposal.sourceRootHash, proposalHash: proposal.proposalHash });
    const receipt = await applicationFixes.apply({ ...value, actorUid, handles: selectedDirectories });
    if (value.organizationId !== 'local') {
      const appliedHashesHash = createHash('sha256').update(JSON.stringify(Object.entries(receipt.appliedHashes).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
      await callManagedFixBackend('applicationFixAppliedRecord', value.idToken, { organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, proposalId: proposal.id, target: proposal.target, sourceRootHash: proposal.sourceRootHash, proposalHash: proposal.proposalHash, receiptId: receipt.id, appliedHashesHash });
    }
    return receipt;
  });
  ipcMain.handle('application-fix:receipt', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixes || !input || typeof input !== 'object') throw new Error('Application fix receipt query is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; idToken?: string };
    await authorizeApplicationFixScope(value);
    return applicationFixes.receipt(value) ?? null;
  });
  const gitRequest = async (event: Electron.IpcMainInvokeEvent, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !gitWorkspace || !input || typeof input !== 'object') throw new Error('Git request is invalid.');
    const value = input as Record<string, unknown>;
    const target = parseGitTarget(value.target);
    return { value, workspace: gitWorkspace, spec: await resolveGitTarget(target, { applicationFixes, handles: selectedDirectories, testStorage }) };
  };
  ipcMain.handle('git:view', async (event, input: unknown) => { const { workspace, spec } = await gitRequest(event, input); return workspace.view(spec); });
  ipcMain.handle('git:commit', async (event, input: unknown) => {
    const { value, workspace, spec } = await gitRequest(event, input);
    const branch = value.branch as { kind?: unknown; name?: unknown } | undefined;
    if (!branch || (branch.kind !== 'current' && (branch.kind !== 'new' || typeof branch.name !== 'string'))) throw new Error('Git request is invalid.');
    return workspace.commit(spec, { paths: value.paths as string[], message: value.message as string, branch: branch.kind === 'new' ? { kind: 'new', name: branch.name as string } : { kind: 'current' } });
  });
  ipcMain.handle('git:push', async (event, input: unknown) => { const { value, workspace, spec } = await gitRequest(event, input); return workspace.push(spec, String(value.commitId ?? '')); });
  ipcMain.handle('git:pull-request', async (event, input: unknown) => { const { value, workspace, spec } = await gitRequest(event, input); return workspace.pullRequest(spec, String(value.commitId ?? '')); });
  ipcMain.handle('application-fix:rerun', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !applicationFixes || !savedWebTests || !patrolRuns || !patrolRunner || !input || typeof input !== 'object') throw new Error('Application fix rerun is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceHandle: string; deviceId?: string; idToken?: string };
    await authorizeApplicationFixScope(value);
    const { proposal, receipt, sourcePath } = await applicationFixes.validateApplied({ ...value, handles: selectedDirectories });
    if (proposal.target !== value.target) throw new Error('Application proposal target changed.');
    const link = { receiptId: receipt.id, proposalId: proposal.id, proposalHash: proposal.proposalHash, originatingAttemptId: proposal.attemptId, sourceRootHash: receipt.sourceRootHash };
    if (value.target === 'flutter') {
      if (typeof value.deviceId !== 'string' || !value.deviceId) throw new Error('Choose a ready Android device or iOS simulator for the patched Flutter rerun.');
      const original = patrolRuns.failedAttempt({ ...value, attemptId: proposal.attemptId });
      if (original.version.versionId !== proposal.testVersionId || original.version.contentHash !== proposal.testVersionHash) throw new Error('The original Patrol version differs from the approved patch.');
      return patrolRunner.run({ organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, versionId: proposal.testVersionId, deviceId: value.deviceId }, sourcePath, { ...link, runtimeKind: value.deviceId.startsWith('ios:') ? 'ios-simulator-build' : 'android-build' });
    }
    const original = savedWebTests.failedAttempt({ ...value, attemptId: proposal.attemptId });
    if (original.version.id !== proposal.testVersionId || original.version.contentHash !== proposal.testVersionHash) throw new Error('The original Web version differs from the approved patch.');
    const priorBaseUrl = original.attempt.baseUrl ?? savedWebTests.listRuns(value.organizationId, value.projectId).find((run) => run.items.some((item) => item.attemptIds.includes(proposal.attemptId)))?.baseUrl;
    if (!priorBaseUrl) throw new Error('The original Web attempt has no recoverable URL. Run it again locally before proposing an application fix.');
    const prior = new URL(priorBaseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(prior.hostname)) throw new Error('The original failed URL was remote. SaySpec cannot claim a local patch is deployed there. Rerun against a local source server.');
    const server = await startPatchedWebServer(sourcePath, proposal, receipt);
    try {
      const baseUrl = new URL(`${prior.pathname}${prior.search}${prior.hash}`, server.baseUrl).href;
      return await savedWebTests.run({ organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, versionId: proposal.testVersionId, baseUrl }, { ...link, runtimeKind: 'local-web-server', runtimeHash: server.runtimeHash }, server.verify);
    } finally { await server.close(); }
  });
  /**
   * Patrol test fixes. Tests on this Mac (a guest project, or file storage)
   * are authorized here, as their other edits are. In a SaySpec Cloud project
   * the backend confirms membership and access to this Flutter project; the
   * new version itself reaches the cloud through the regular upload, which
   * the project's access rules govern.
   */
  const authorizePatrolTestFixScope = async (input: { organizationId: string; projectId: string; testId?: string; idToken?: string }) => {
    if (testStorage?.isCloud(input)) return callManagedFixBackend('applicationFixReadAuthorize', input.idToken, { organizationId: input.organizationId, projectId: input.projectId, target: 'flutter' });
    if (input.organizationId === 'local' && !localWorkspace?.snapshot().projects.some((project) => project.id === input.projectId && project.targetType === 'flutter')) throw new Error('The selected local Flutter project is unavailable.');
    if (input.testId && !(testStorage?.usesFiles(input) ? await testStorage.has(input, input.testId) : patrolRuns?.listTests(input.projectId, input.organizationId).some((test) => test.id === input.testId))) throw new Error('This test is not in the project’s test storage.');
    return input.organizationId === 'local' ? 'guest' : 'local_user';
  };
  ipcMain.handle('patrol-test-fix:list', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || !input || typeof input !== 'object') throw new Error('Fix proposal query is invalid.');
    const value = input as { organizationId: string; projectId: string; idToken?: string };
    await authorizePatrolTestFixScope(value);
    return patrolRuns.testFixProposals(value);
  });
  ipcMain.handle('patrol-test-fix:start', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !managedFixSessions || !codingAgentPreferences || !input || typeof input !== 'object') throw new Error('Fix session request is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; attemptId: string; analysisId: string; sourceHandle?: string; cols: number; rows: number; idToken?: string };
    const provider = codingAgentPreferences.snapshot().provider;
    if (!provider) throw new Error('Choose Claude Code or Codex in Settings first.');
    await authorizePatrolTestFixScope(value);
    const readDirectory = typeof value.sourceHandle === 'string' && value.sourceHandle ? selectedDirectories.root(value.sourceHandle) : undefined;
    return managedFixSessions.start(value, provider, value.cols, value.rows, { kind: 'patrol', readDirectory });
  });
  ipcMain.handle('patrol-test-fix:decide', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || !input || typeof input !== 'object') throw new Error('Fix decision is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; kind: 'approve' | 'reject'; idToken?: string };
    if (value.kind !== 'approve' && value.kind !== 'reject') throw new Error('Fix decision is invalid.');
    const actorUid = await authorizePatrolTestFixScope(value);
    return patrolRuns.decideTestFix({ ...value, actorUid });
  });
  ipcMain.handle('patrol-test-fix:apply', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !patrolRuns || !input || typeof input !== 'object') throw new Error('Fix application is invalid.');
    const value = input as { organizationId: string; projectId: string; testId: string; proposalId: string; idToken?: string };
    const actorUid = await authorizePatrolTestFixScope(value);
    const version = await patrolRuns.applyTestFix({ ...value, actorUid });
    await testStorage?.savePatrolVersion(version);
    return version;
  });
  ipcMain.handle('saved-web-test:read-artifact', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test artifact request is invalid.');
    return savedWebTests.readArtifact(input as Parameters<SavedWebTestStore['readArtifact']>[0]);
  });
  ipcMain.handle('saved-web-test:run', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test run is invalid.');
    return savedWebTests.run(input as Parameters<SavedWebTestStore['run']>[0]);
  });
  ipcMain.handle('saved-web-run:create', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved run request is invalid.');
    const value = input as Parameters<SavedWebTestStore['createRun']>[0];
    if (testStorage?.usesFiles(value)) {
      // The run freezes whatever is in the folder right now.
      await testStorage.sync(value);
      if (!Array.isArray(value.testIds) || !(await Promise.all(value.testIds.map((id) => testStorage!.has(value, id)))).every(Boolean)) throw new Error('Run members must be tests in the project’s test storage.');
    } else if (value.organizationId === 'local') {
      const snapshot = localWorkspace?.snapshot();
      if (!snapshot?.projects.some((project) => project.id === value.projectId && project.targetType === 'web') || !Array.isArray(value.testIds) || value.testIds.some((id) => !snapshot.tests.some((test) => test.id === id && test.projectId === value.projectId && test.status !== 'archived'))) throw new Error('Run members must be active tests in this local Web project.');
      if (value.suiteId) { const suite = snapshot.suites.find((item) => item.id === value.suiteId && item.projectId === value.projectId); if (!suite || JSON.stringify(suite.testIds) !== JSON.stringify(value.testIds)) throw new Error('Suite membership changed. Reload before submitting.'); }
    }
    return savedWebTests.createRun(value);
  });
  ipcMain.handle('saved-web-run:start', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved run start request is invalid.');
    return savedWebTests.startRun(input as Parameters<SavedWebTestStore['startRun']>[0]);
  });
  ipcMain.handle('saved-web-run:list', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved run query is invalid.');
    const value = input as { organizationId: string; projectId: string };
    return savedWebTests.listRuns(value.organizationId, value.projectId);
  });
  ipcMain.handle('saved-web-run:retry', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved run retry is invalid.');
    return savedWebTests.retryRunItem(input as Parameters<SavedWebTestStore['retryRunItem']>[0]);
  });
  ipcMain.handle('saved-web-run:cancel', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved run cancellation is invalid.');
    savedWebTests.cancelRun(input as Parameters<SavedWebTestStore['cancelRun']>[0]);
  });
  ipcMain.handle('saved-web-test:cancel', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test cancellation is invalid.');
    savedWebTests.cancel(String((input as { attemptId?: unknown }).attemptId ?? ''));
  });
  ipcMain.handle('saved-web-test:export', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test export is invalid.');
    return savedWebTests.export(input as Parameters<SavedWebTestStore['export']>[0]);
  });
  ipcMain.handle('saved-web-test:preview-import', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test import preview is invalid.');
    return savedWebTests.previewImport((input as { bundle: unknown }).bundle);
  });
  ipcMain.handle('saved-web-test:import', async (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !savedWebTests || typeof input !== 'object' || input === null) throw new Error('Saved test import is invalid.');
    const value = input as { organizationId: string; projectId: string; testId?: string; bundle: unknown };
    const localProject = localWorkspace?.snapshot().projects.find((project) => project.id === value.projectId);
    if (localProject && value.organizationId !== 'local') throw new Error('Local import scope is invalid.');
    const imported = await savedWebTests.import(value.organizationId, value.projectId, value.bundle, value.testId);
    await testStorage?.saveImportedWebTest(imported);
    return imported;
  });
  ipcMain.handle('claude-terminal:start', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !claudeTerminal || !codingAgentPreferences || typeof input !== 'object' || input === null) throw new Error('Coding-agent terminal request is invalid.');
    const value = input as { recordingId?: unknown; cols?: unknown; rows?: unknown; mode?: unknown };
    if (value.mode !== 'inspect' && value.mode !== 'generate') throw new Error('Coding-agent terminal mode is invalid.');
    const provider = codingAgentPreferences.snapshot().provider;
    if (!provider) throw new Error('Choose Claude Code or Codex in Settings first.');
    return claudeTerminal.start(String(value.recordingId ?? ''), provider, Number(value.cols), Number(value.rows), value.mode);
  });
  ipcMain.handle('claude-terminal:write', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !claudeTerminal || typeof input !== 'object' || input === null) throw new Error('Coding-agent terminal input is invalid.');
    const value = input as { recordingId?: unknown; data?: unknown };
    if (typeof value.data !== 'string') throw new Error('Coding-agent terminal input is invalid.');
    claudeTerminal.write(String(value.recordingId ?? ''), value.data);
  });
  ipcMain.handle('claude-terminal:resize', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !claudeTerminal || typeof input !== 'object' || input === null) throw new Error('Coding-agent terminal resize is invalid.');
    const value = input as { recordingId?: unknown; cols?: unknown; rows?: unknown };
    claudeTerminal.resize(String(value.recordingId ?? ''), Number(value.cols), Number(value.rows));
  });
  ipcMain.handle('claude-terminal:close', (event, input: unknown) => {
    if (!isTrustedMainFrame(event, rendererUrl) || !claudeTerminal || typeof input !== 'object' || input === null) throw new Error('Coding-agent terminal close is invalid.');
    return claudeTerminal.close(String((input as { recordingId?: unknown }).recordingId ?? ''));
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  startUpdateChecks();
}).catch((error) => {
  reportStartupFailure('app-ready', error);
  app.exit(1);
});
app.on('before-quit', (event) => {
  shuttingDown = true;
  ipcMain.removeHandler('app:info');
  ipcMain.removeHandler('app:open-account-portal');
  ipcMain.removeHandler('local-workspace:get');
  ipcMain.removeHandler('local-workspace:create-project');
  ipcMain.removeHandler('local-workspace:rename-test');
  ipcMain.removeHandler('local-workspace:delete-test');
  ipcMain.removeHandler('local-workspace:save-suite');
  ipcMain.removeHandler('local-workspace:move-test-to-suite');
  ipcMain.removeHandler('machine:choose-source');
  ipcMain.removeHandler('machine:check-readiness');
  for (const channel of ['flutter:narration-begin', 'flutter:narration-append', 'flutter:narration-finish', 'flutter:narration-read', 'flutter:transcribe', 'flutter:share-state']) ipcMain.removeHandler(channel);
  for (const channel of ['flutter:devices', 'flutter:start-device', 'flutter:recorder-sdk', 'flutter:preview-integration', 'flutter:apply-integration', 'flutter:capture-start', 'flutter:capture-pause', 'flutter:capture-resume', 'flutter:capture-stop', 'flutter:capture-cancel', 'flutter:capture-list', 'flutter:capture-get', 'flutter:capture-screenshot', 'patrol:list-tests', 'patrol:list-versions', 'patrol:run', 'patrol:cancel', 'patrol:attempts', 'patrol:artifact', 'patrol:leases', 'patrol-run:create', 'patrol-run:start', 'patrol-run:list', 'patrol-run:stop', 'patrol-run:delete', 'patrol-run:log', 'patrol-run:console', 'patrol-run-analysis:attach', 'patrol-run-analysis:write', 'patrol-run-analysis:resize', 'patrol-run-analysis:restart', 'patrol-run-analysis:open-report', 'patrol-run-analysis:prepare-fix', 'patrol-test-fix:list', 'patrol-test-fix:start', 'patrol-test-fix:decide', 'patrol-test-fix:apply', 'patrol-generation:start', 'patrol-generation:write', 'patrol-generation:resize', 'patrol-generation:close', 'machine-setup:get', 'machine-setup:check', 'machine-setup:plan', 'machine-setup:install', 'machine-setup:job', 'machine-setup:cancel', 'machine-setup-agent:start', 'machine-setup-agent:write', 'machine-setup-agent:resize', 'machine-setup-agent:close', 'entry-points:get', 'entry-points:save', 'recording:microphone-access', 'recording:start-web', 'recording:begin-segment', 'recording:append-audio', 'recording:pause', 'recording:resume', 'recording:stop', 'recording:interrupt', 'recording:cancel', 'recording:list', 'recording:get', 'recording:read-asset', 'recording:share-state', 'transcription:setup', 'transcription:model-install', 'transcription:model-cancel', 'transcription:model-remove', 'transcription:start', 'transcription:cancel', 'transcription:save-edits', 'transcription:save-intent', 'generation:readiness', 'generation:preference-get', 'generation:preference-select', 'generation:start', 'generation:cancel', 'saved-web-test:versions', 'saved-web-test:project-versions', 'saved-web-test:attempts', 'saved-web-test:read-artifact', 'saved-web-test:run', 'saved-web-run:create', 'saved-web-run:start', 'saved-web-run:list', 'saved-web-run:retry', 'saved-web-run:cancel', 'saved-web-test:cancel', 'failure-analysis:list', 'failure-analysis:start', 'failure-analysis:cancel', 'managed-fix:list', 'managed-fix:start', 'managed-fix:write', 'managed-fix:resize', 'managed-fix:close', 'managed-fix:decide', 'managed-fix:apply', 'application-fix:list', 'application-fix:start', 'application-fix:write', 'application-fix:resize', 'application-fix:close', 'application-fix:decide', 'application-fix:apply', 'application-fix:receipt', 'application-fix:rerun', 'git:view', 'git:commit', 'git:push', 'git:pull-request', 'saved-web-test:export', 'saved-web-test:preview-import', 'saved-web-test:import', 'claude-terminal:start', 'claude-terminal:write', 'claude-terminal:resize', 'claude-terminal:close']) ipcMain.removeHandler(channel);
  session.defaultSession?.setPermissionRequestHandler(null);
  session.defaultSession?.setPermissionCheckHandler(null);
  selectedDirectories.clear();
  if ((localJobs || recordingManager || localTranscription || playwrightGeneration || claudeTerminal || savedWebTests || failureAnalysis || managedFixSessions || machineSetup || machineSetupAgent || flutterSessions || patrolRunner || patrolRunAnalysis || patrolGeneration) && !shutdownComplete) {
    event.preventDefault();
    void Promise.all([localJobs?.shutdown(), recordingManager?.shutdown(), localTranscription?.shutdown(), cloudTranscription?.shutdown(), playwrightGeneration?.shutdown(), claudeTerminal?.shutdown(), failureAnalysis?.shutdown(), managedFixSessions?.shutdown(), applicationFixSessions?.shutdown(), savedWebTests?.shutdown(), machineSetup?.shutdown(), machineSetupAgent?.shutdown(), flutterSessions?.shutdown(), patrolGeneration?.shutdown(), patrolRunner?.shutdown(), patrolRunAnalysis?.shutdown()]).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
