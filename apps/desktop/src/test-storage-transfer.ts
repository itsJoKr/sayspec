import type { PortableLibrary, PortableLibraryTest, PortableWebSource, SavedWebTestVersion, TestLibraryScope, TestStorageCopyResult, TestStorageMode } from '@sayspec/contracts';
import type { CloudBackend } from './cloud/backend';
import { announceTestStorageChange } from './test-repository';

const JUST_RECORDED = 'Just Recorded';
function requireCloud(cloud: CloudBackend | null) { if (!cloud) throw new Error('This build has no cloud backend.'); return cloud; }

function messageOf(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message.replace(/^(Firebase)?Error:\s*/, '') : fallback; }
const webSource = (value: PortableWebSource & Partial<Pick<SavedWebTestVersion, 'recordingId'>>): PortableWebSource => ({ title: value.title, steps: value.steps, files: value.files, runtime: value.runtime, provenance: value.provenance, ...(value.recordingId ? { recordingId: value.recordingId } : {}) });

/**
 * Reads a project's SaySpec Cloud tests for copying. A test's source is this
 * Mac's latest saved version when there is one, otherwise the generated draft
 * stored in the cloud.
 */
export async function exportCloudLibrary(cloud: CloudBackend, scope: TestLibraryScope): Promise<PortableLibrary> {
  const [tests, suites, versions] = await Promise.all([cloud.tests.list(scope), cloud.tests.listSuites(scope), window.sayspec!.listProjectWebTestVersions(scope)]);
  const latest = new Map<string, SavedWebTestVersion>();
  for (const version of [...versions].sort((left, right) => right.version - left.version)) if (!latest.has(version.testId)) latest.set(version.testId, version);
  const suiteList = suites.filter((suite) => suite.name);
  const portable: PortableLibraryTest[] = [];
  for (const test of tests) {
    const local = latest.get(test.id);
    const source = local ?? await cloud.tests.readDraftSource({ ...scope, testId: test.id });
    portable.push({
      id: test.id, title: test.title || 'Untitled test', suite: suiteList.find((suite) => suite.testIds.includes(test.id))?.name ?? null,
      ...(test.authorLabel ? { authorLabel: test.authorLabel } : {}),
      ...(test.createdAt ? { createdAt: test.createdAt } : {}),
      ...(test.recordingId ? { recordingId: test.recordingId } : {}),
      ...(source?.files?.length ? { web: webSource(source) } : {}),
    });
  }
  return { tests: portable, suites: suiteList.map((suite) => suite.name) };
}

/** Copies tests into SaySpec Cloud as drafts, keeping their IDs and suites. Tests already in the cloud are updated. */
export async function importCloudLibrary(cloud: CloudBackend, scope: TestLibraryScope, library: PortableLibrary): Promise<TestStorageCopyResult> {
  const result: TestStorageCopyResult = { copied: 0, failed: [] };
  const copied: PortableLibraryTest[] = [];
  for (const test of library.tests) {
    try {
      if (!test.web) throw new Error(test.patrol ? 'Flutter tests are not stored in SaySpec Cloud.' : 'Its source is not on this Mac.');
      const web = test.web;
      if (!web.steps.length || web.steps.some((step) => !step.instruction.trim() || !step.assertion.trim())) throw new Error('SaySpec Cloud needs every step to have an instruction and an expected result.');
      const recordingId = web.recordingId ?? test.recordingId ?? web.provenance.recordingId;
      await cloud.tests.saveDraft({
        ...scope, testId: test.id, title: test.title, folder: test.suite ?? 'Copied tests', tags: ['copied'],
        intent: { prerequisites: web.runtime.requirements, steps: web.steps.map((step) => ({ action: step.instruction, target: '', expectedOutcome: step.assertion, evidenceIds: step.evidenceEventIds })), unresolvedQuestions: [] },
        // Copied source has not run in the cloud yet, so it is saved as an unvalidated draft.
        generation: { schemaVersion: 1, id: `generation_${test.id}`, ...scope, recordingId, state: 'draft', title: test.title, steps: web.steps, files: web.files, runtime: web.runtime, unresolvedQuestions: [], warnings: [], provenance: { ...web.provenance, recordingId, executionValidated: false, published: false } },
      });
      copied.push(test); result.copied += 1;
    } catch (reason) { result.failed.push({ title: test.title, reason: messageOf(reason, 'It could not be copied.') }); }
  }
  const existing = await cloud.tests.listSuites(scope);
  for (const name of library.suites) {
    const members = copied.filter((test) => test.suite === name).map((test) => test.id);
    const current = existing.find((suite) => suite.name.toLowerCase() === name.toLowerCase());
    // A "Just Recorded" suite is only a staging area and needs a source recording to exist.
    const recording = name === JUST_RECORDED ? copied.find((test) => test.suite === name && test.recordingId)?.recordingId : undefined;
    if (name === JUST_RECORDED && (!recording || !members.length)) continue;
    await cloud.tests.saveSuite({ ...scope, suiteId: current?.id ?? `suite_${crypto.randomUUID()}`, expectedRevision: current?.revision ?? 0, name: current?.name ?? name, testIds: [...new Set([...(current?.testIds ?? []), ...members])], ...(recording ? { sourceRecordingId: recording } : {}) });
  }
  return result;
}

/**
 * Switches a project to another storage: copies every test into it, records
 * the new choice (for the whole team when signed in), and points this machine
 * at it. Tests in the previous storage are left where they are.
 */
export async function switchTestStorage(cloud: CloudBackend | null, input: TestLibraryScope & { targetType: 'web' | 'flutter'; from: TestStorageMode; to: TestStorageMode; folderHandle?: string; signedIn: boolean; switchDespiteFailures?: boolean }): Promise<TestStorageCopyResult & { switched: boolean }> {
  const scope = { organizationId: input.organizationId, projectId: input.projectId };
  const library = input.from === 'cloud' ? await exportCloudLibrary(requireCloud(cloud), scope) : await window.sayspec!.exportTestLibrary(scope);
  const result = input.to === 'cloud' ? await importCloudLibrary(requireCloud(cloud), scope, library)
    : await window.sayspec!.importTestLibrary({ ...scope, targetType: input.targetType, mode: input.to, ...(input.folderHandle ? { folderHandle: input.folderHandle } : {}), library });
  // Tests that could not be copied would drop out of view, so the switch waits for the user to confirm.
  if (result.failed.length && !input.switchDespiteFailures) return { ...result, switched: false };
  if (input.signedIn) await requireCloud(cloud).projects.setTestStorage({ ...scope, testStorage: input.to });
  await window.sayspec!.configureTestStorage({ ...scope, targetType: input.targetType, mode: input.to, ...(input.folderHandle ? { folderHandle: input.folderHandle } : {}) });
  announceTestStorageChange();
  return { ...result, switched: true };
}

/** Counts the tests a switch would copy, for the confirmation. */
export async function countTests(cloud: CloudBackend | null, scope: TestLibraryScope, mode: TestStorageMode) {
  if (mode === 'cloud') return requireCloud(cloud).tests.count(scope);
  return (await window.sayspec!.getTestLibrary(scope)).tests.length;
}
