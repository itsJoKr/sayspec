import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildInstallPlan, collectWorkflowItemIds, shellQuote } from './installers.ts';
import { checkMachineSetup, readFlutterProjectRequirements, SHARED_ITEM_IDS } from './checks.ts';
import { compareVersions, firstVersion } from './environment.ts';

test('install plan installs a shared dependency once and skips satisfied items', async () => {
  const report = await checkMachineSetup({});
  const items = report.groups.flatMap((group) => group.items);
  const satisfied = new Set(items.filter((item) => item.state === 'installed' || item.state === 'verified').map((item) => item.id));
  const plan = await buildInstallPlan({ workflow: 'flutter-android', items, runtime: { androidRoot: '/tmp/android', sdkManager: '/tmp/android/cmdline-tools/latest/bin/sdkmanager', javaHome: '/tmp/jdk', fvm: '/tmp/fvm' } });
  const itemIds = plan.steps.map((step) => step.itemId);
  assert.equal(new Set(itemIds).size, itemIds.length, 'every item appears at most once');
  for (const id of itemIds) {
    assert.ok(!satisfied.has(id), `${id} is satisfied and must not be installed again`);
  }
  // Homebrew is listed by several workflows; the plan must still contain one step for it.
  const shared = plan.steps.filter((step) => step.itemId === 'homebrew');
  assert.ok(shared.length <= 1);
});

test('web plan never installs Flutter dependencies', async () => {
  const report = await checkMachineSetup({});
  const items = report.groups.flatMap((group) => group.items);
  const plan = await buildInstallPlan({ workflow: 'web', items, runtime: {} });
  for (const step of plan.steps) {
    assert.ok(['homebrew', 'node', 'playwright_browser', 'coding_agent_cli', 'local_transcription'].includes(step.itemId), `${step.itemId} is not a Web dependency`);
  }
  assert.ok(!plan.itemIds.includes('flutter_sdk'));
});

test('workflow dependency order installs prerequisites before consumers', () => {
  const items = checkOrderItems();
  const order = collectWorkflowItemIds('flutter-android', items);
  assert.ok(order.indexOf('jdk') < order.indexOf('android_platform'));
  assert.ok(order.indexOf('android_cmdline_tools') < order.indexOf('android_platform'));
  assert.ok(order.indexOf('android_licenses') < order.indexOf('android_system_image'));
  assert.ok(order.indexOf('android_system_image') < order.indexOf('android_emulator'));
  assert.ok(order.indexOf('flutter_sdk') < order.indexOf('patrol_cli'));
});

test('plan reports substantial downloads and manual steps instead of hiding them', async () => {
  const items = checkOrderItems().filter((item) => item.id !== 'android_system_image');
  const plan = await buildInstallPlan({ workflow: 'flutter-android', items, runtime: { sdkManager: '/tmp/sdkmanager', androidRoot: '/tmp/android' } });
  assert.ok(plan.manualSteps.length > 0, 'license acceptance and device setup are user actions');
  assert.ok(plan.substantialDownloads.length > 0);
});

test('shell quoting neutralizes injected project text', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('a; rm -rf /'), "'a; rm -rf /'");
});

test('version helpers compare and extract honestly', () => {
  assert.equal(compareVersions('3.38.5', '3.32.0'), 1);
  assert.equal(compareVersions('3.8.0', '3.8.0'), 0);
  assert.equal(compareVersions('3.7.9', '3.8.0'), -1);
  assert.equal(firstVersion('Flutter 3.38.5 • channel stable'), '3.38.5');
  assert.equal(firstVersion('no digits here'), undefined);
});

test('an Android group is ready only when every item is installed or verified', async () => {
  const report = await checkMachineSetup({});
  const androidGroup = report.groups.find((group) => group.workflow === 'flutter-android');
  assert.ok(androidGroup);
  const satisfied = (item: { state: string }) => item.state === 'installed' || item.state === 'verified' || item.state === 'unsupported';
  assert.equal(androidGroup.ready, androidGroup.items.every(satisfied));
  for (const item of androidGroup.items) {
    if (satisfied(item)) continue;
    assert.ok(item.recovery, `${item.id} must explain the required action`);
    assert.notEqual(item.state, 'verified', `${item.id} cannot claim verification before a real build`);
  }
});

test('stage summary separates machine tools, project build, device and recording integration', async () => {
  const report = await checkMachineSetup({});
  assert.deepEqual(Object.keys(report.stages).sort(), ['device', 'machineTools', 'projectBuild', 'recordingIntegration']);
  // Without a selected project the project-specific stages stay unknown.
  assert.equal(report.stages.projectBuild, 'unknown');
  assert.equal(report.stages.recordingIntegration, 'not-required');
  const ambiguous = report.groups.flatMap((group) => group.items).find((item) => item.id === 'android_device');
  assert.ok(ambiguous);
  if (ambiguous.state !== 'installed') assert.equal(ambiguous.manual, true);
});

test('shared dependencies are declared as shared', () => {
  for (const id of ['homebrew', 'node', 'jdk', 'flutter_sdk', 'patrol_cli']) assert.ok(SHARED_ITEM_IDS.has(id), `${id} installs once across workflows`);
});

/** Minimal item set used to assert ordering without probing the host. */
function checkOrderItems() {
  const ids = ['homebrew', 'jdk', 'android_sdk_root', 'android_cmdline_tools', 'flutter_sdk', 'dart', 'patrol_cli', 'android_platform', 'android_build_tools', 'android_licenses', 'android_system_image', 'android_emulator', 'android_device', 'patrol_integration', 'recorder_sdk'];
  return ids.map((id) => ({
    id, group: 'flutter-android' as const, label: id, purpose: 'fixture', state: 'missing' as const,
    detail: 'fixture', action: 'install' as const, manual: false, checkedAt: new Date().toISOString(),
  }));
}

test('a nested harness inherits the parent FVM pin and never reads the Dart constraint as Flutter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-nested-pin-'));
  const harness = path.join(root, 'shop', 'e2e');
  await mkdir(harness, { recursive: true });
  await writeFile(path.join(harness, 'pubspec.yaml'), 'name: shop_e2e\nenvironment:\n  sdk: ^3.10.4\n');
  try {
    assert.equal((await readFlutterProjectRequirements(harness)).pinnedFlutterSdk, undefined);
    await writeFile(path.join(root, 'shop', '.fvmrc'), '{\n  "flutter": "3.38.5"\n}\n');
    assert.equal((await readFlutterProjectRequirements(harness)).pinnedFlutterSdk, '3.38.5');
  } finally { await rm(root, { recursive: true, force: true }); }
});
