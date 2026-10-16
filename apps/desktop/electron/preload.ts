import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@sayspec/contracts';

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openAccountPortal: (input) => ipcRenderer.invoke('app:open-account-portal', input),
  getLocalWorkspace: () => ipcRenderer.invoke('local-workspace:get'),
  createLocalProject: (input) => ipcRenderer.invoke('local-workspace:create-project', input),
  deleteLocalProject: (input) => ipcRenderer.invoke('local-workspace:delete-project', input),
  renameLocalTest: (input) => ipcRenderer.invoke('local-workspace:rename-test', input),
  deleteLocalTest: (input) => ipcRenderer.invoke('local-workspace:delete-test', input),
  saveLocalSuite: (input) => ipcRenderer.invoke('local-workspace:save-suite', input),
  moveLocalTestToSuite: (input) => ipcRenderer.invoke('local-workspace:move-test-to-suite', input),
  getTestStorage: (input) => ipcRenderer.invoke('test-storage:get', input),
  chooseTestStorageFolder: () => ipcRenderer.invoke('test-storage:choose-folder'),
  configureTestStorage: (input) => ipcRenderer.invoke('test-storage:configure', input),
  revealTestStorageFolder: (input) => ipcRenderer.invoke('test-storage:reveal', input),
  getTestInstructions: (input) => ipcRenderer.invoke('test-instructions:get', input),
  revealTestInstructions: (input) => ipcRenderer.invoke('test-instructions:reveal', input),
  syncCloudTestInstructions: (input) => ipcRenderer.invoke('test-instructions:sync-cloud', input),
  exportTestLibrary: (input) => ipcRenderer.invoke('test-storage:export', input),
  importTestLibrary: (input) => ipcRenderer.invoke('test-storage:import', input),
  listPendingCloudPatrolTests: (input) => ipcRenderer.invoke('test-storage:cloud-patrol-pending', input),
  markCloudPatrolTestUploaded: (input) => ipcRenderer.invoke('test-storage:cloud-patrol-uploaded', input),
  pullCloudPatrolTests: (input) => ipcRenderer.invoke('test-storage:cloud-patrol-pull', input),
  setTestAuthor: (input) => ipcRenderer.invoke('test-storage:set-author', input),
  getTestLibrary: (input) => ipcRenderer.invoke('test-library:get', input),
  renameLibraryTest: (input) => ipcRenderer.invoke('test-library:rename-test', input),
  deleteLibraryTest: (input) => ipcRenderer.invoke('test-library:delete-test', input),
  saveLibrarySuite: (input) => ipcRenderer.invoke('test-library:save-suite', input),
  moveLibraryTest: (input) => ipcRenderer.invoke('test-library:move-test', input),
  chooseSourceDirectory: () => ipcRenderer.invoke('machine:choose-source'),
  rememberSourceDirectory: (input) => ipcRenderer.invoke('machine:remember-source', input),
  getRememberedSourceDirectory: (input) => ipcRenderer.invoke('machine:remembered-source', input),
  checkReadiness: (input) => ipcRenderer.invoke('machine:check-readiness', input),
  getMachineSetup: () => ipcRenderer.invoke('machine-setup:get'),
  checkMachineSetup: (input) => ipcRenderer.invoke('machine-setup:check', input),
  planMachineSetupInstall: (input) => ipcRenderer.invoke('machine-setup:plan', input),
  startMachineSetupInstall: (input) => ipcRenderer.invoke('machine-setup:install', input),
  getMachineSetupJob: (input) => ipcRenderer.invoke('machine-setup:job', input),
  cancelMachineSetupInstall: (input) => ipcRenderer.invoke('machine-setup:cancel', input),
  onMachineSetupEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('machine-setup:event', handler);
    return () => ipcRenderer.removeListener('machine-setup:event', handler);
  },
  startMachineSetupAgent: (input) => ipcRenderer.invoke('machine-setup-agent:start', input),
  writeMachineSetupAgent: (input) => ipcRenderer.invoke('machine-setup-agent:write', input),
  resizeMachineSetupAgent: (input) => ipcRenderer.invoke('machine-setup-agent:resize', input),
  closeMachineSetupAgent: (input) => ipcRenderer.invoke('machine-setup-agent:close', input),
  onMachineSetupAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('machine-setup-agent:event', handler);
    return () => ipcRenderer.removeListener('machine-setup-agent:event', handler);
  },
  getProjectEntryPoints: (input) => ipcRenderer.invoke('entry-points:get', input),
  saveProjectEntryPoints: (input) => ipcRenderer.invoke('entry-points:save', input),
  onProjectEntryPointsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('entry-points:changed', handler);
    return () => ipcRenderer.removeListener('entry-points:changed', handler);
  },
  listFlutterDevices: () => ipcRenderer.invoke('flutter:devices'),
  startFlutterDevice: (input) => ipcRenderer.invoke('flutter:start-device', input),
  checkFlutterRecorderSdk: (input) => ipcRenderer.invoke('flutter:recorder-sdk', input),
  previewFlutterIntegration: (input) => ipcRenderer.invoke('flutter:preview-integration', input),
  applyFlutterIntegration: (input) => ipcRenderer.invoke('flutter:apply-integration', input),
  startFlutterCapture: (input) => ipcRenderer.invoke('flutter:capture-start', input),
  pauseFlutterCapture: (input) => ipcRenderer.invoke('flutter:capture-pause', input),
  resumeFlutterCapture: (input) => ipcRenderer.invoke('flutter:capture-resume', input),
  stopFlutterCapture: (input) => ipcRenderer.invoke('flutter:capture-stop', input),
  getActiveFlutterCapture: (input) => ipcRenderer.invoke('flutter:capture-active', input),
  cancelFlutterCapture: (input) => ipcRenderer.invoke('flutter:capture-cancel', input),
  beginFlutterNarration: (input) => ipcRenderer.invoke('flutter:narration-begin', input),
  appendFlutterNarration: (input) => ipcRenderer.invoke('flutter:narration-append', input),
  finishFlutterNarration: (input) => ipcRenderer.invoke('flutter:narration-finish', input),
  transcribeFlutterCapture: (input) => ipcRenderer.invoke('flutter:transcribe', input),
  readFlutterCaptureNarration: (input) => ipcRenderer.invoke('flutter:narration-read', input),
  setFlutterCaptureShareState: (input) => ipcRenderer.invoke('flutter:share-state', input),
  listFlutterCaptures: (input) => ipcRenderer.invoke('flutter:capture-list', input),
  getFlutterCapture: (input) => ipcRenderer.invoke('flutter:capture-get', input),
  readFlutterCaptureScreenshot: (input) => ipcRenderer.invoke('flutter:capture-screenshot', input),
  onFlutterCaptureLifecycle: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('flutter-capture:lifecycle', handler);
    return () => ipcRenderer.removeListener('flutter-capture:lifecycle', handler);
  },
  onFlutterCaptureLaunchLog: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('flutter-capture:launch-log', handler);
    return () => ipcRenderer.removeListener('flutter-capture:launch-log', handler);
  },
  startPatrolGeneration: (input) => ipcRenderer.invoke('patrol-generation:start', input),
  writePatrolGeneration: (input) => ipcRenderer.invoke('patrol-generation:write', input),
  resizePatrolGeneration: (input) => ipcRenderer.invoke('patrol-generation:resize', input),
  closePatrolGeneration: (input) => ipcRenderer.invoke('patrol-generation:close', input),
  onPatrolGenerationEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('patrol-generation:event', handler);
    return () => ipcRenderer.removeListener('patrol-generation:event', handler);
  },
  listPatrolTests: (input) => ipcRenderer.invoke('patrol:list-tests', input),
  listPatrolTestVersions: (input) => ipcRenderer.invoke('patrol:list-versions', input),
  runPatrolTest: (input) => ipcRenderer.invoke('patrol:run', input),
  cancelPatrolRun: (input) => ipcRenderer.invoke('patrol:cancel', input),
  listPatrolAttempts: (input) => ipcRenderer.invoke('patrol:attempts', input),
  createPatrolRun: (input) => ipcRenderer.invoke('patrol-run:create', input),
  startPatrolRun: (input) => ipcRenderer.invoke('patrol-run:start', input),
  listPatrolRuns: (input) => ipcRenderer.invoke('patrol-run:list', input),
  stopPatrolRun: (input) => ipcRenderer.invoke('patrol-run:stop', input),
  deletePatrolRun: (input) => ipcRenderer.invoke('patrol-run:delete', input),
  readPatrolArtifact: (input) => ipcRenderer.invoke('patrol:artifact', input),
  readPatrolRunLog: (input) => ipcRenderer.invoke('patrol-run:log', input),
  attachPatrolRunConsole: (input) => ipcRenderer.invoke('patrol-run:console', input),
  onPatrolRunConsole: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('patrol-run:console-event', handler);
    return () => ipcRenderer.removeListener('patrol-run:console-event', handler);
  },
  attachPatrolRunAnalysis: (input) => ipcRenderer.invoke('patrol-run-analysis:attach', input),
  writePatrolRunAnalysis: (input) => ipcRenderer.invoke('patrol-run-analysis:write', input),
  resizePatrolRunAnalysis: (input) => ipcRenderer.invoke('patrol-run-analysis:resize', input),
  restartPatrolRunAnalysis: (input) => ipcRenderer.invoke('patrol-run-analysis:restart', input),
  openPatrolRunReport: (input) => ipcRenderer.invoke('patrol-run-analysis:open-report', input),
  onPatrolRunAnalysisEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('patrol-run-analysis:event', handler);
    return () => ipcRenderer.removeListener('patrol-run-analysis:event', handler);
  },
  preparePatrolIssueFix: (input) => ipcRenderer.invoke('patrol-run-analysis:prepare-fix', input),
  listPatrolTestFixProposals: (input) => ipcRenderer.invoke('patrol-test-fix:list', input),
  startPatrolTestFixSession: (input) => ipcRenderer.invoke('patrol-test-fix:start', input),
  decidePatrolTestFix: (input) => ipcRenderer.invoke('patrol-test-fix:decide', input),
  applyPatrolTestFix: (input) => ipcRenderer.invoke('patrol-test-fix:apply', input),
  listPatrolLeases: () => ipcRenderer.invoke('patrol:leases'),
  getGitView: (input) => ipcRenderer.invoke('git:view', input),
  commitGitChanges: (input) => ipcRenderer.invoke('git:commit', input),
  pushGitCommit: (input) => ipcRenderer.invoke('git:push', input),
  openGitPullRequest: (input) => ipcRenderer.invoke('git:pull-request', input),
  requestMicrophoneAccess: () => ipcRenderer.invoke('recording:microphone-access'),
  startWebRecording: (input) => ipcRenderer.invoke('recording:start-web', input),
  beginRecordingSegment: (input) => ipcRenderer.invoke('recording:begin-segment', input),
  appendRecordingAudio: (input) => ipcRenderer.invoke('recording:append-audio', input),
  pauseRecording: (input) => ipcRenderer.invoke('recording:pause', input),
  resumeRecording: (input) => ipcRenderer.invoke('recording:resume', input),
  stopRecording: (input) => ipcRenderer.invoke('recording:stop', input),
  interruptRecording: (input) => ipcRenderer.invoke('recording:interrupt', input),
  cancelRecording: (input) => ipcRenderer.invoke('recording:cancel', input),
  listLocalRecordings: (input) => ipcRenderer.invoke('recording:list', input),
  getLocalRecording: (input) => ipcRenderer.invoke('recording:get', input),
  readRecordingAsset: (input) => ipcRenderer.invoke('recording:read-asset', input),
  setRecordingShareState: (input) => ipcRenderer.invoke('recording:share-state', input),
  onRecordingLifecycle: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('recording:lifecycle', handler);
    return () => ipcRenderer.removeListener('recording:lifecycle', handler);
  },
  getLocalTranscriptionSetup: () => ipcRenderer.invoke('transcription:setup'),
  installLocalTranscriptionModel: (input) => ipcRenderer.invoke('transcription:model-install', input),
  cancelLocalTranscriptionModelInstall: () => ipcRenderer.invoke('transcription:model-cancel'),
  removeLocalTranscriptionModel: (input) => ipcRenderer.invoke('transcription:model-remove', input),
  transcribeRecording: (input) => ipcRenderer.invoke('transcription:start', input),
  cancelRecordingTranscription: (input) => ipcRenderer.invoke('transcription:cancel', input),
  saveTranscriptEdits: (input) => ipcRenderer.invoke('transcription:save-edits', input),
  saveRecordingIntent: (input) => ipcRenderer.invoke('transcription:save-intent', input),
  onLocalTranscriptionLifecycle: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('transcription:lifecycle', handler);
    return () => ipcRenderer.removeListener('transcription:lifecycle', handler);
  },
  checkCodingAgentReadiness: () => ipcRenderer.invoke('generation:readiness'),
  getCodingAgentPreference: () => ipcRenderer.invoke('generation:preference-get'),
  selectCodingAgentProvider: (input) => ipcRenderer.invoke('generation:preference-select', input),
  generatePlaywrightDraft: (input) => ipcRenderer.invoke('generation:start', input),
  cancelPlaywrightGeneration: (input) => ipcRenderer.invoke('generation:cancel', input),
  runSavedWebTest: (input) => ipcRenderer.invoke('saved-web-test:run', input),
  createSavedWebRun: (input) => ipcRenderer.invoke('saved-web-run:create', input),
  startSavedWebRun: (input) => ipcRenderer.invoke('saved-web-run:start', input),
  listSavedWebRuns: (input) => ipcRenderer.invoke('saved-web-run:list', input),
  retrySavedWebRunItem: (input) => ipcRenderer.invoke('saved-web-run:retry', input),
  cancelSavedWebRun: (input) => ipcRenderer.invoke('saved-web-run:cancel', input),
  listSavedWebTestVersions: (input) => ipcRenderer.invoke('saved-web-test:versions', input),
  listProjectWebTestVersions: (input) => ipcRenderer.invoke('saved-web-test:project-versions', input),
  cancelSavedWebTest: (input) => ipcRenderer.invoke('saved-web-test:cancel', input),
  listSavedWebTestAttempts: (input) => ipcRenderer.invoke('saved-web-test:attempts', input),
  analyzeSavedWebFailure: (input) => ipcRenderer.invoke('failure-analysis:start', input),
  listFailureAnalyses: (input) => ipcRenderer.invoke('failure-analysis:list', input),
  cancelFailureAnalysis: (input) => ipcRenderer.invoke('failure-analysis:cancel', input),
  listManagedFixProposals: (input) => ipcRenderer.invoke('managed-fix:list', input),
  startManagedFixSession: (input) => ipcRenderer.invoke('managed-fix:start', input),
  writeManagedFixSession: (input) => ipcRenderer.invoke('managed-fix:write', input),
  resizeManagedFixSession: (input) => ipcRenderer.invoke('managed-fix:resize', input),
  closeManagedFixSession: (input) => ipcRenderer.invoke('managed-fix:close', input),
  onManagedFixTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('managed-fix:event', handler);
    return () => ipcRenderer.removeListener('managed-fix:event', handler);
  },
  decideManagedFix: (input) => ipcRenderer.invoke('managed-fix:decide', input),
  applyManagedFix: (input) => ipcRenderer.invoke('managed-fix:apply', input),
  listApplicationFixProposals: (input) => ipcRenderer.invoke('application-fix:list', input),
  startApplicationFixSession: (input) => ipcRenderer.invoke('application-fix:start', input),
  writeApplicationFixSession: (input) => ipcRenderer.invoke('application-fix:write', input),
  resizeApplicationFixSession: (input) => ipcRenderer.invoke('application-fix:resize', input),
  closeApplicationFixSession: (input) => ipcRenderer.invoke('application-fix:close', input),
  onApplicationFixTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('application-fix:event', handler);
    return () => ipcRenderer.removeListener('application-fix:event', handler);
  },
  decideApplicationFix: (input) => ipcRenderer.invoke('application-fix:decide', input),
  applyApplicationFix: (input) => ipcRenderer.invoke('application-fix:apply', input),
  readApplicationFixReceipt: (input) => ipcRenderer.invoke('application-fix:receipt', input),
  rerunApplicationFix: (input) => ipcRenderer.invoke('application-fix:rerun', input),
  readSavedWebTestArtifact: (input) => ipcRenderer.invoke('saved-web-test:read-artifact', input),
  exportSavedWebTest: (input) => ipcRenderer.invoke('saved-web-test:export', input),
  previewWebTestImport: (input) => ipcRenderer.invoke('saved-web-test:preview-import', input),
  importWebTest: (input) => ipcRenderer.invoke('saved-web-test:import', input),
  onPlaywrightGenerationLifecycle: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('generation:lifecycle', handler);
    return () => ipcRenderer.removeListener('generation:lifecycle', handler);
  },
  startClaudeTerminal: (input) => ipcRenderer.invoke('claude-terminal:start', input),
  writeClaudeTerminal: (input) => ipcRenderer.invoke('claude-terminal:write', input),
  resizeClaudeTerminal: (input) => ipcRenderer.invoke('claude-terminal:resize', input),
  closeClaudeTerminal: (input) => ipcRenderer.invoke('claude-terminal:close', input),
  onClaudeTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('claude-terminal:event', handler);
    return () => ipcRenderer.removeListener('claude-terminal:event', handler);
  },
};
contextBridge.exposeInMainWorld('sayspec', Object.freeze(bridge));
