import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFlutterRunCommand, tokenizeCommand, validateEntryPoints } from './index.ts';

test('parses flutter and fvm run commands into launch arguments', () => {
  assert.deepEqual(parseFlutterRunCommand('fvm flutter run --flavor dev -t lib/main_dev.dart --dart-define-from-file=env/dev.json'), {
    runner: 'fvm', args: ['--flavor', 'dev', '-t', 'lib/main_dev.dart', '--dart-define-from-file=env/dev.json'], flavor: 'dev', target: 'lib/main_dev.dart',
  });
  assert.deepEqual(parseFlutterRunCommand('flutter run'), { runner: 'flutter', args: [] });
  assert.deepEqual(parseFlutterRunCommand('flutter run --target=lib/main_qa.dart --dart-define "API=https://qa.example.com"').args, ['--target=lib/main_qa.dart', '--dart-define', 'API=https://qa.example.com']);
});

test('rejects shell syntax, other programs, and flags SaySpec owns', () => {
  assert.throws(() => tokenizeCommand('cd app && flutter run'), /Shell syntax/);
  assert.throws(() => parseFlutterRunCommand('flutter run --dart-define=KEY=$SECRET'), /Shell syntax/);
  assert.throws(() => parseFlutterRunCommand('npm run dev'), /flutter run/);
  assert.throws(() => parseFlutterRunCommand('flutter build apk'), /flutter run/);
  assert.throws(() => parseFlutterRunCommand('flutter run -d emulator-5554'), /chooses the device/);
  assert.throws(() => parseFlutterRunCommand('flutter run --machine'), /chooses the device/);
  assert.throws(() => parseFlutterRunCommand('flutter run --dart-define=SAYSPEC_RECORDING_URL=x'), /reserved/);
  assert.throws(() => parseFlutterRunCommand('flutter run -t ../other/main.dart'), /inside the project/);
  assert.throws(() => parseFlutterRunCommand('flutter run lib/main.dart'), /-t/);
});

test('validates ordered entry points per technology', () => {
  assert.deepEqual(validateEntryPoints('flutter', [{ name: ' Dev ', command: 'fvm flutter run --flavor dev' }, { name: 'Prod', command: 'fvm flutter run --flavor prod', url: 'ignored' }]), [
    { name: 'Dev', command: 'fvm flutter run --flavor dev' }, { name: 'Prod', command: 'fvm flutter run --flavor prod' },
  ]);
  assert.deepEqual(validateEntryPoints('web', [{ name: 'Local', command: 'npm run dev', url: 'http://localhost:5173' }, { name: 'Staging', command: '', url: 'https://staging.example.com' }]), [
    { name: 'Local', command: 'npm run dev', url: 'http://localhost:5173' }, { name: 'Staging', command: '', url: 'https://staging.example.com' },
  ]);
  assert.throws(() => validateEntryPoints('web', [{ name: 'Local', command: 'npm run dev' }]), /HTTP\(S\) URL/);
  assert.throws(() => validateEntryPoints('flutter', [{ name: 'Dev', command: 'flutter run' }, { name: 'dev', command: 'flutter run' }]), /already used/);
  assert.throws(() => validateEntryPoints('flutter', [{ name: 'Dev', command: '' }]), /needs a flutter run command/);
  assert.throws(() => validateEntryPoints('flutter', 'nope'), /must be a list/);
});

test('keeps a Flutter entry point application ID and rejects malformed ones', () => {
  assert.deepEqual(validateEntryPoints('flutter', [{ name: 'Dev', command: 'flutter run --flavor dev', appId: ' com.example.shop.dev ' }, { name: 'Prod', command: 'flutter run', appId: '' }]), [
    { name: 'Dev', command: 'flutter run --flavor dev', appId: 'com.example.shop.dev' }, { name: 'Prod', command: 'flutter run' },
  ]);
  assert.deepEqual(validateEntryPoints('web', [{ name: 'Local', command: '', url: 'http://localhost:5173', appId: 'com.example.shop' }]), [{ name: 'Local', command: '', url: 'http://localhost:5173' }]);
  assert.throws(() => validateEntryPoints('flutter', [{ name: 'Dev', command: 'flutter run', appId: 'shop' }]), /application ID/);
  assert.throws(() => validateEntryPoints('flutter', [{ name: 'Dev', command: 'flutter run', appId: 'com.example.$shop' }]), /application ID/);
});
