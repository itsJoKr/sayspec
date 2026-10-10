import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

/**
 * Settings → Machine setup acceptance on the built Electron app.
 *
 * This runs real checks against the host and verifies the project-scoped
 * Testing/Fixing presentation. Installation now belongs to the interactive
 * selected coding agent, so this smoke never starts an unattended installer.
 */
const cwd = new URL('..', import.meta.url).pathname;
const profile = await mkdtemp(path.join(tmpdir(), 'sayspec-setup-native-'));
const fixtureProject = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
try {
const child = spawn(electron, ['.'], {
  cwd,
  env: {
    ...process.env,
    SAYSPEC_TEST_MODE: '1',
    SAYSPEC_NATIVE_SMOKE: '1',
    SAYSPEC_TEST_USER_DATA: profile,
    SAYSPEC_SETUP_SMOKE: '1',
    SAYSPEC_GUEST_SMOKE: '1',
    SAYSPEC_TEST_SOURCE_DIRECTORY: fixtureProject,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const closed = new Promise((resolve) => {
  const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'timeout' }); }, 20 * 60_000);
  child.on('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
});
const outcome = await closed;
const match = /SAYSPEC_SMOKE_RESULT=(\{.*\})/s.exec(output);
if (!match) {
  process.stderr.write(output.slice(-4_000));
  throw new Error(`The machine setup smoke produced no result (exit ${outcome.code}).`);
}
const result = JSON.parse(match[1]);
if (result.setupError) throw new Error(`The native smoke failed during ${result.setupError}`);
const flow = result.setupFlow;
if (!flow) throw new Error('The machine setup flow did not run.');
if (flow.error) throw new Error(`Machine setup flow failed: ${flow.error} ${flow.stack ?? ''}`);
const problems = [];
if (!flow.checked) problems.push('no check ran');
if (!flow.stages?.length) problems.push('no Flutter readiness stages were reported');
if (flow.actionableTotal !== flow.actionableWithRecovery) problems.push(`${flow.actionableTotal - flow.actionableWithRecovery} actionable item(s) had no recovery text`);
if (flow.actionableTotal > 0 && flow.androidReady === 'true') problems.push('an incomplete Android group reported ready');
if (JSON.stringify(flow.flutterGroups) !== JSON.stringify(['Flutter Android', 'Flutter iOS'])) problems.push(`Flutter project showed wrong groups: ${JSON.stringify(flow.flutterGroups)}`);
if (JSON.stringify(flow.webGroups) !== JSON.stringify(['Web · Playwright'])) problems.push(`Web project showed wrong groups: ${JSON.stringify(flow.webGroups)}`);
if (JSON.stringify(flow.purposeHeadings) !== JSON.stringify(['Run tests on this machine', 'Let AI diagnose and prepare the project'])) problems.push('Testing and Fixing sections were not clearly separated');
if (!flow.sourceSelected) problems.push('selected source was not shown inside machine setup');
if (!flow.aiSetupVisible) problems.push('Setup with the selected Coding AI was not shown');
if (!flow.legacyInstallActionsAbsent) problems.push('legacy direct installer actions remained in Settings');
if (!flow.planSteps?.every((step) => step.command)) problems.push('a retained baseline plan step had no command');
if (!/Machine tools:/.test(flow.readinessText ?? '')) problems.push('the Record page did not report the shared readiness summary');
if (!flow.readinessText?.includes('recording integration')) problems.push('the Record readiness summary did not include recording integration');
process.stdout.write(`SETUP_NATIVE_RESULT=${JSON.stringify({ ...flow, problems })}\n`);
if (problems.length) {
  process.stderr.write(`SETUP_PROBLEMS=${JSON.stringify(problems)}\n`);
  process.exitCode = 1;
}
} finally {
  await rm(profile, { recursive: true, force: true });
}
