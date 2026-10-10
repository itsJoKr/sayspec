import assert from 'node:assert/strict';
import test from 'node:test';
import { entryPointsSkill, machineSetupSkill } from './setup-agent-skill.ts';

test('web setup skill excludes unrelated mobile tooling and separates testing from fixing', () => {
  const skill = machineSetupSkill('web');
  assert.match(skill, /only the Playwright browser\/runtime/);
  assert.match(skill, /Do not install or diagnose Flutter/);
  assert.match(skill, /Testing and Fixing/);
  assert.match(skill, /selected source tree/);
});

test('Flutter setup skill analyzes both platform lanes and keeps source edits approved', () => {
  const skill = machineSetupSkill('flutter');
  assert.match(skill, /Android and iOS as separate lanes/);
  assert.match(skill, /Patrol package and CLI compatibility/);
  assert.match(skill, /explicitly confirmed/);
  assert.match(skill, /Never apply a product-generated fix/);
});

test('setup skill asks for ordered entry points written back to SaySpec', () => {
  const files = { entryPointsPath: '/tmp/session/entry-points.json', entryPointsResultPath: '/tmp/session/entry-points-result.json' };
  const flutter = machineSetupSkill('flutter', files);
  assert.match(flutter, /fvm flutter run/);
  assert.match(flutter, /productFlavors/);
  assert.match(flutter, /Leave out `-d`/);
  assert.match(flutter, /pre-selects the first entry/);
  assert.match(flutter, /\/tmp\/session\/entry-points\.json/);
  assert.match(flutter, /\/tmp\/session\/entry-points-result\.json/);
  assert.doesNotMatch(flutter, /"url"/);
  assert.match(flutter, /"appId"/);
  assert.match(flutter, /applicationIdSuffix/);
  const web = machineSetupSkill('web', files);
  assert.match(web, /package\.json scripts/);
  assert.match(web, /"url"/);
  assert.doesNotMatch(web, /"appId"/);
});

test('entry-points skill only detects and saves entry points', () => {
  const files = { entryPointsPath: '/tmp/session/entry-points.json', entryPointsResultPath: '/tmp/session/entry-points-result.json' };
  const flutter = entryPointsSkill('flutter', files);
  assert.match(flutter, /only task is to detect the project's entry points/);
  assert.match(flutter, /productFlavors/);
  assert.match(flutter, /\/tmp\/session\/entry-points\.json/);
  assert.match(flutter, /\/tmp\/session\/entry-points-result\.json/);
  assert.doesNotMatch(flutter, /Testing and Fixing/);
  assert.doesNotMatch(flutter, /Patrol/);
  assert.match(entryPointsSkill('web', files), /"url"/);
});

test('setup and entry-point skills end by telling the user they can close the window', () => {
  const closing = '✅ You can now close the window and use SaySpec.';
  assert.ok(entryPointsSkill('flutter').includes(closing));
  assert.ok(entryPointsSkill('web').includes(closing));
  assert.ok(machineSetupSkill('flutter').includes(closing));
  assert.ok(machineSetupSkill('web').includes(closing));
});
