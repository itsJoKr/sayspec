import assert from 'node:assert/strict';
import test from 'node:test';
import { readableFlutterRunLines } from './flutter-run-log.ts';

test('flutter run --machine events become readable launch output', () => {
  const machine = (event: string, params: Record<string, unknown>) => JSON.stringify([{ event, params }]);
  assert.deepEqual(readableFlutterRunLines(machine('daemon.connected', { version: '0.6.1', pid: 1 })), []);
  assert.deepEqual(readableFlutterRunLines(machine('app.start', { appId: 'a', deviceId: 'emulator-5554' })), []);
  assert.deepEqual(readableFlutterRunLines(machine('app.progress', { appId: 'a', message: "Running Gradle task 'assembleDebug'...", finished: false })), ["Running Gradle task 'assembleDebug'..."]);
  assert.deepEqual(readableFlutterRunLines(machine('app.progress', { appId: 'a', finished: true })), []);
  assert.deepEqual(
    readableFlutterRunLines(machine('daemon.logMessage', { level: 'error', message: 'FAILURE: Build failed with an exception.\n\n* What went wrong:\n' })),
    ['FAILURE: Build failed with an exception.', '* What went wrong:'],
  );
  assert.deepEqual(readableFlutterRunLines(machine('app.log', { appId: 'a', log: '\x1b[31mI/flutter: boom\x1b[0m' })), ['I/flutter: boom']);
  assert.deepEqual(readableFlutterRunLines(machine('app.started', { appId: 'a' })), ['The app started.']);
});

test('plain lines outside the daemon protocol are kept', () => {
  assert.deepEqual(readableFlutterRunLines('lib/main.dart:3:1: Error: Expected a declaration.  '), ['lib/main.dart:3:1: Error: Expected a declaration.']);
  assert.deepEqual(readableFlutterRunLines('   '), []);
  assert.deepEqual(readableFlutterRunLines('{"not":"an event list"}'), ['{"not":"an event list"}']);
});
