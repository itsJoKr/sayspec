import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPubspecVersion, resolveProjectFlutterToolchain } from './toolchain.ts';
import { RECORDER_SDK_VERSION } from './recorder-sdk.ts';
import { previewFlutterIntegration } from './integration.ts';

async function executable(candidate: string, body: string) {
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, `#!/bin/sh\n${body}\n`);
  await chmod(candidate, 0o755);
}

test('selected project resolves its pinned Flutter and bundled Dart instead of PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-toolchain-'));
  const project = path.join(root, 'project');
  const sdk = path.join(project, '.fvm', 'flutter_sdk');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, '.fvmrc'), '{"flutter":"9.8.7"}\n');
  await executable(path.join(sdk, 'bin', 'flutter'), "echo 'Flutter 9.8.7 • channel stable'");
  await executable(path.join(sdk, 'bin', 'dart'), "echo 'Dart SDK version: 3.9.1' >&2");
  try {
    const resolved = await resolveProjectFlutterToolchain(project);
    assert.equal(resolved.flutterPath, path.join(sdk, 'bin', 'flutter'));
    assert.equal(resolved.dartPath, path.join(sdk, 'bin', 'dart'));
    assert.equal(resolved.flutterVersion, '9.8.7');
    assert.equal(resolved.dartVersion, '3.9.1');
    assert.equal(resolved.resolution, 'project-fvm');
    assert.equal(resolved.environment.PATROL_FLUTTER_COMMAND, resolved.flutterPath);
    assert.equal(resolved.environment.PATH?.split(path.delimiter)[0], path.join(sdk, 'bin'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fresh customer projects receive the pinned pub.dev recorder dependency', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recorder-dependency-'));
  const project = path.join(root, 'customer-app');
  await mkdir(path.join(project, 'lib'), { recursive: true });
  await writeFile(path.join(project, 'pubspec.yaml'), 'name: customer_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  await writeFile(path.join(project, 'lib', 'main.dart'), "import 'package:flutter/material.dart';\nvoid main() { runApp(const SizedBox()); }\n");
  try {
    const preview = await previewFlutterIntegration({ sourcePath: project, appId: 'dev.example.customer' });
    const pubspec = preview.files.find((file) => file.relativePath === 'pubspec.yaml');
    assert.ok(pubspec);
    assert.equal(pubspec.proposedText, `name: customer_app\ndependencies:\n  sayspec_flutter_recorder: ${RECORDER_SDK_VERSION}\n  flutter:\n    sdk: flutter\n`);
    assert.match(pubspec.description, /pub\.dev/);
    const main = preview.files.find((file) => file.relativePath === 'lib/main.dart');
    assert.ok(main);
    assert.match(main.proposedText, /Future<void> main\(\) async/);
    assert.match(main.proposedText, /initializeFromEnvironment/);
    assert.match(main.proposedText, /appId: "dev\.example\.customer"/);
    assert.doesNotMatch(main.proposedText, /SAYSPEC_RECORDING_/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a harness main that delegates to another package attaches the recorder after the delegate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recorder-delegated-'));
  const project = path.join(root, 'e2e');
  await mkdir(path.join(project, 'lib'), { recursive: true });
  await mkdir(path.join(project, 'android', 'app'), { recursive: true });
  await writeFile(path.join(project, 'pubspec.yaml'), 'name: shop_e2e\ndependencies:\n  flutter:\n    sdk: flutter\n');
  await writeFile(path.join(project, 'android', 'app', 'build.gradle.kts'), 'android {\n    defaultConfig {\n        applicationId = "com.example.shop_e2e"\n        testInstrumentationRunner = "pl.leancode.patrol.PatrolJUnitRunner"\n    }\n}\n');
  await writeFile(path.join(project, 'lib', 'main.dart'), "import 'package:shop/main.dart' as shop;\n\n/// Harness entrypoint.\nFuture<void> main() => shop.main();\n");
  try {
    const preview = await previewFlutterIntegration({ sourcePath: project, appId: '' });
    const main = preview.files.find((file) => file.relativePath === 'lib/main.dart');
    assert.ok(main);
    assert.equal(main.proposedText, [
      "import 'package:shop/main.dart' as shop;",
      "import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';",
      '',
      '/// Harness entrypoint.',
      'Future<void> main() async {',
      '  await shop.main();',
      '  await SaySpecRecorder.instance.initializeFromEnvironment(appId: "com.example.shop_e2e");',
      '}',
      '',
    ].join('\n'));
    assert.ok(preview.notes.some((note) => /screenshots are not/.test(note)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a recorder declared as a machine-local path is re-pinned to pub.dev', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recorder-repin-'));
  const project = path.join(root, 'app');
  await mkdir(path.join(project, 'lib'), { recursive: true });
  await writeFile(path.join(project, 'pubspec.yaml'), 'name: app\ndependencies:\n  sayspec_flutter_recorder:\n    path: "/Users/someone/Library/Application Support/@sayspec/desktop/flutter-recorder-sdk/0.11.0"\n  flutter:\n    sdk: flutter\n');
  await writeFile(path.join(project, 'lib', 'main.dart'), "import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';\nvoid main() {}\n");
  try {
    const preview = await previewFlutterIntegration({ sourcePath: project, appId: '' });
    const pubspec = preview.files.find((file) => file.relativePath === 'pubspec.yaml');
    assert.ok(pubspec);
    assert.equal(pubspec.proposedText, `name: app\ndependencies:\n  sayspec_flutter_recorder: ${RECORDER_SDK_VERSION}\n  flutter:\n    sdk: flutter\n`);
    await writeFile(path.join(project, 'pubspec.yaml'), pubspec.proposedText);
    const pinned = await previewFlutterIntegration({ sourcePath: project, appId: '' });
    assert.equal(pinned.files.some((file) => file.relativePath === 'pubspec.yaml'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the app version is read from pubspec.yaml', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-pubspec-version-'));
  try {
    const read = async (pubspec: string) => { await writeFile(path.join(root, 'pubspec.yaml'), pubspec); return readPubspecVersion(root); };
    assert.equal(await read('name: shop\nversion: 2.4.0+57\n\nenvironment:\n  sdk: ^3.5.0\n'), '2.4.0+57');
    assert.equal(await read('name: shop\nversion: "1.0.0" # release\n'), '1.0.0');
    // A nested `version:` key (a dependency's) is not the app's version.
    assert.equal(await read('name: shop\ndependencies:\n  foo:\n    version: 1.2.3\n'), undefined);
    await rm(path.join(root, 'pubspec.yaml'));
    assert.equal(await readPubspecVersion(root), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
