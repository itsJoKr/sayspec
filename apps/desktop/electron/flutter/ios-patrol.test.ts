import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyFlutterIntegration, previewFlutterIntegration } from './integration.ts';
import { dartTestName, flutterDeviceId, IOS_PATROL_FILES, patchPodfile, previewPatrolIosConfig, readIosPatrolWiring, simulatorOsVersion, xcodeBundleIds, xcresultCases } from './ios-patrol.ts';
import { ownerOf } from './patrol-log.ts';

/** The sample app's Xcode project and Podfile as `flutter create` left them, before Patrol wiring. */
const fixtureIos = fileURLToPath(new URL('./test-fixtures/ios-unwired', import.meta.url));

/** A project with that real, unwired Xcode project and Podfile. */
async function iosProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-ios-patrol-'));
  const project = path.join(root, 'app');
  await mkdir(path.join(project, 'ios'), { recursive: true });
  await cp(path.join(fixtureIos, 'Runner.xcodeproj'), path.join(project, 'ios', 'Runner.xcodeproj'), { recursive: true });
  await cp(path.join(fixtureIos, 'Podfile'), path.join(project, 'ios', 'Podfile'));
  return { root, project };
}

test('device ids map to what flutter, patrol and simctl accept', () => {
  assert.equal(flutterDeviceId({ id: 'ios:EB53E3BE-AB3C-4C14-B5A3-4A489A5AB4CE', name: 'iPhone 17' }), 'EB53E3BE-AB3C-4C14-B5A3-4A489A5AB4CE');
  assert.equal(flutterDeviceId({ id: 'avd:Pixel_8', name: 'Pixel_8' }), 'Pixel_8');
  assert.equal(flutterDeviceId({ id: 'emulator-5554', name: 'Pixel_8' }), 'emulator-5554');
  assert.equal(simulatorOsVersion({ runtime: 'iOS 26.5' }), '26.5');
  assert.equal(simulatorOsVersion({ runtime: 'iOS 18' }), '18');
  assert.equal(simulatorOsVersion({}), undefined);
});

test('xcresult test cases become Patrol outcomes titled like the Dart test', () => {
  const tests = xcresultCases([{ nodeType: 'Test Plan', children: [{ nodeType: 'UI test bundle', children: [{ nodeType: 'Test Suite', children: [
    { nodeType: 'Test Case', name: 'f05_recorded_test+recorded+sign-in+email+key+is+present', result: 'Passed', durationInSeconds: 5.25, children: [{ nodeType: 'Runtime Warning', name: 'UIScene' }] },
    { nodeType: 'Test Case', name: 'checkout.cart_test+total+is+1__PLUS__1', result: 'Failed', durationInSeconds: 2, children: [{ nodeType: 'Failure Message', name: 'Expected: <2> Actual: <3>' }] },
  ] }] }] }]);
  assert.deepEqual(tests.map((item) => [item.title, item.outcome, item.durationMs]), [
    ['f05_recorded_test recorded sign-in email key is present', 'passed', 5250],
    ['checkout.cart_test total is 1+1', 'failed', 2000],
  ]);
  assert.deepEqual(tests[1]!.errors, ['Expected: <2> Actual: <3>']);
  // The same owner mapping as Android's JUnit titles splits a combined run per file.
  const owner = ownerOf(['patrol_test/f05_recorded_test.dart', 'patrol_test/checkout/cart_test.dart']);
  assert.equal(owner(tests[0]!.title), 'patrol_test/f05_recorded_test.dart');
  assert.equal(owner(tests[1]!.title), 'patrol_test/checkout/cart_test.dart');
  assert.equal(dartTestName('a+b__PLUS__c'), 'a b+c');
});

test('the Podfile nests RunnerUITests in the Runner target', () => {
  const podfile = "platform :ios, '13.0'\n\ntarget 'Runner' do\n  use_frameworks!\n\n  target 'RunnerTests' do\n    inherit! :search_paths\n  end\nend\n\npost_install do |installer|\nend\n";
  const patched = patchPodfile(podfile)!;
  assert.match(patched, /  target 'RunnerTests' do\n    inherit! :search_paths\n  end\n\n  target 'RunnerUITests' do\n    inherit! :complete\n  end\nend\n\npost_install/);
  assert.equal(patchPodfile('# no targets\n'), undefined);
});

test('Runner bundle ids exclude test targets and prefer the launched configuration', async () => {
  const { root, project } = await iosProject();
  try {
    assert.deepEqual(await xcodeBundleIds(project), ['dev.sayspec.flutterSampleApp']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the iOS Patrol wiring is previewed deterministically, applied as one unit, then reported ready', async () => {
  const { root, project } = await iosProject();
  try {
    assert.equal((await readIosPatrolWiring(project)).ready, false);
    const first = await previewPatrolIosConfig(project);
    const again = await previewPatrolIosConfig(project);
    assert.deepEqual(first.files.map((file) => file.relativePath).sort(), [...IOS_PATROL_FILES].sort(), first.notes.join('\n'));
    // Apply re-creates the preview, so the reviewed text must be what gets written.
    assert.deepEqual(again.files.map((file) => file.proposedText), first.files.map((file) => file.proposedText));

    const pbxproj = first.files.find((file) => file.relativePath === 'ios/Runner.xcodeproj/project.pbxproj')!.proposedText;
    assert.match(pbxproj, /productType = "com\.apple\.product-type\.bundle\.ui-testing";/);
    assert.match(pbxproj, /PRODUCT_BUNDLE_IDENTIFIER = dev\.sayspec\.flutterSampleApp\.RunnerUITests;/);
    assert.match(pbxproj, /baseConfigurationReference = \w+ \/\* Debug\.xcconfig \*\//);
    assert.match(pbxproj, /xcode_backend\.sh\\" embed_and_thin/);
    assert.doesNotMatch(pbxproj, /iPhoneOS\d+\.\d+\.sdk/);
    const targetId = /(\w{24}) \/\* RunnerUITests \*\/ = \{\s*\n\s*isa = PBXNativeTarget;/.exec(pbxproj)?.[1];
    assert.ok(targetId);
    assert.ok(first.files.find((file) => file.relativePath.endsWith('Runner.xcscheme'))!.proposedText.includes(`BlueprintIdentifier = "${targetId}"`));

    // The iOS files are applied through the normal integration path, which
    // refuses a partial selection.
    await writeFile(path.join(project, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    await mkdir(path.join(project, 'lib'), { recursive: true });
    await writeFile(path.join(project, 'lib', 'main.dart'), "import 'package:flutter/material.dart';\nvoid main() { runApp(const SizedBox()); }\n");
    const preview = await previewFlutterIntegration({ sourcePath: project, appId: 'dev.sayspec.flutterSampleApp' });
    await assert.rejects(applyFlutterIntegration({ sourcePath: project, preview, relativePaths: ['ios/Podfile'] }), /only work together/);
    await applyFlutterIntegration({ sourcePath: project, preview, relativePaths: [...IOS_PATROL_FILES] });
    assert.deepEqual(await readIosPatrolWiring(project), { ready: true, detail: 'The iOS Patrol test target is configured.' });
    assert.match(await readFile(path.join(project, 'ios', 'RunnerUITests', 'RunnerUITests.m'), 'utf8'), /PATROL_INTEGRATION_TEST_IOS_RUNNER\(RunnerUITests\)/);
    assert.deepEqual((await previewPatrolIosConfig(project)).files, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
