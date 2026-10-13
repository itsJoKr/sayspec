import { spawn, type ChildProcess } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { CodingAgentProviderId, CodingAgentProviderReadiness, CodingAgentReadinessReport } from '@sayspec/contracts';

const OUTPUT_BUDGET = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class CodingAgentError extends Error {
  readonly code: 'missing' | 'unauthenticated' | 'unsupported' | 'canceled' | 'timeout' | 'malformed-output' | 'provider-error';
  constructor(code: CodingAgentError['code'], message: string) { super(message); this.name = 'CodingAgentError'; this.code = code; }
}

export interface CodingAgentInvocation {
  provider: CodingAgentProviderId;
  workingDirectory: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  evidenceImagePaths?: readonly string[];
  noTools?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?(message: string): void;
}

export interface CodingAgentInvocationResult {
  provider: CodingAgentProviderId;
  cliVersion: string;
  output: unknown;
}

type CommandResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function boundedAppend(current: string, chunk: Buffer) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next) > OUTPUT_BUDGET) throw new CodingAgentError('provider-error', 'Coding-agent output exceeded the 2 MiB safety budget.');
  return next;
}

function safeEnvironment() {
  const names = [
    'PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
    'CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  ] as const;
  const result: NodeJS.ProcessEnv = { DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' };
  for (const name of names) if (process.env[name] !== undefined) result[name] = process.env[name];
  return result;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already exited */ } }
}

function runCommand(executable: string, args: readonly string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; onProgress?(message: string): void } = {}) {
  return new Promise<CommandResult>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new CodingAgentError('canceled', 'Coding-agent invocation canceled.')); return; }
    const child = spawn(executable, [...args], {
      cwd: options.cwd, shell: false, detached: process.platform !== 'win32',
      env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let settled = false;
    const finishError = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    child.stdout?.on('data', (chunk: Buffer) => {
      try { stdout = boundedAppend(stdout, chunk); options.onProgress?.('Coding agent returned structured progress.'); }
      catch (error) { killProcessTree(child, 'SIGKILL'); finishError(error); }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      try { stderr = boundedAppend(stderr, chunk); }
      catch (error) { killProcessTree(child, 'SIGKILL'); finishError(error); }
    });
    child.once('error', (error: NodeJS.ErrnoException) => finishError(new CodingAgentError(error.code === 'ENOENT' ? 'missing' : 'provider-error', error.code === 'ENOENT' ? 'Coding-agent CLI is not installed.' : error.message)));
    const abort = () => killProcessTree(child, 'SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      killProcessTree(child, 'SIGTERM');
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 1_500).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();
    child.once('close', (code, signal) => {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      if (settled) return; settled = true;
      if (options.signal?.aborted) { reject(new CodingAgentError('canceled', 'Coding-agent invocation canceled.')); return; }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') { reject(new CodingAgentError('timeout', 'Coding-agent invocation timed out and its process tree was stopped.')); return; }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function versionNumber(text: string) { return text.match(/(\d+\.\d+\.\d+)/)?.[1]; }
function providerError(result: CommandResult) {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  if (/not logged in|not authenticated|authentication|unauthorized|401|login required|api key/i.test(detail)) return new CodingAgentError('unauthenticated', 'The coding-agent CLI is installed but is not authenticated. Sign in with that CLI, then check again.');
  return new CodingAgentError('provider-error', `Coding-agent CLI exited with code ${result.code ?? 'unknown'}: ${detail.slice(-2_000)}`);
}

function parseCodexOutput(stdout: string) {
  let message = '';
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') message = item.text;
  }
  if (!message) throw new CodingAgentError('malformed-output', 'Codex completed without a structured final message.');
  try { return JSON.parse(message) as unknown; }
  catch { throw new CodingAgentError('malformed-output', 'Codex returned malformed structured output.'); }
}

function parseClaudeOutput(stdout: string) {
  let wrapper: Record<string, unknown>;
  try { wrapper = JSON.parse(stdout) as Record<string, unknown>; }
  catch { throw new CodingAgentError('malformed-output', 'Claude Code returned malformed JSON output.'); }
  if (wrapper.is_error === true) throw new CodingAgentError('provider-error', String(wrapper.result ?? 'Claude Code reported an error.'));
  if (wrapper.structured_output && typeof wrapper.structured_output === 'object') return wrapper.structured_output;
  if (typeof wrapper.result === 'string') {
    try { return JSON.parse(wrapper.result) as unknown; }
    catch { throw new CodingAgentError('malformed-output', 'Claude Code did not return the required structured object.'); }
  }
  throw new CodingAgentError('malformed-output', 'Claude Code completed without structured output.');
}

export class CodingAgentAdapters {
  readonly #candidates: Record<CodingAgentProviderId, readonly string[]>;
  readonly #resolved = new Map<CodingAgentProviderId, { executable: string; version: string }>();

  constructor(options: { candidates?: Partial<Record<CodingAgentProviderId, readonly string[]>> } = {}) {
    this.#candidates = {
      'claude-code': options.candidates?.['claude-code'] ?? [process.env.SAYSPEC_CLAUDE_CLI ?? '', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', 'claude'].filter(Boolean),
      codex: options.candidates?.codex ?? [process.env.SAYSPEC_CODEX_CLI ?? '', '/opt/homebrew/bin/codex', '/usr/local/bin/codex', 'codex'].filter(Boolean),
    };
  }

  async readiness(): Promise<CodingAgentReadinessReport> {
    const providers = await Promise.all((['claude-code', 'codex'] as const).map((provider) => this.#check(provider)));
    return {
      checkedAt: new Date().toISOString(), providers,
      disclosure: 'Local Whisper keeps transcription on this machine; Gemini transcription sends narration audio to SaySpec Cloud. Generating with a customer coding CLI sends narration text, recorded actions, and selected screenshots to that CLI and may send them to its configured provider.',
    };
  }

  async qualifiedExecutable(provider: CodingAgentProviderId) {
    const ready = await this.#check(provider);
    if (ready.state !== 'ready') throw new CodingAgentError(ready.state === 'missing' ? 'missing' : ready.state === 'unauthenticated' ? 'unauthenticated' : 'unsupported', ready.detail);
    return { executable: this.#resolved.get(provider)!.executable, version: ready.version! };
  }

  async interactiveExecutable(provider: CodingAgentProviderId) {
    for (const candidate of this.#candidates[provider]) {
      if (!path.isAbsolute(candidate)) return candidate;
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* try the next location */ }
    }
    throw new CodingAgentError('missing', `${provider === 'claude-code' ? 'Claude Code' : 'Codex'} was not found on this machine.`);
  }

  async invoke(input: CodingAgentInvocation): Promise<CodingAgentInvocationResult> {
    const readiness = await this.#check(input.provider);
    if (readiness.state !== 'ready') throw new CodingAgentError(readiness.state === 'missing' ? 'missing' : readiness.state === 'unauthenticated' ? 'unauthenticated' : 'unsupported', readiness.detail);
    const resolved = this.#resolved.get(input.provider)!;
    input.onProgress?.(`Starting ${readiness.displayName} in a write-disabled environment…`);
    const result = input.provider === 'codex'
      ? await this.#invokeCodex(resolved.executable, input)
      : await this.#invokeClaude(resolved.executable, input);
    return { provider: input.provider, cliVersion: resolved.version, output: result };
  }

  async #check(provider: CodingAgentProviderId): Promise<CodingAgentProviderReadiness> {
    const base = provider === 'codex'
      ? { id: provider, displayName: 'Codex', isolation: { writeAccess: 'none' as const, enforcement: 'codex-os-read-only-sandbox' as const, verified: true } }
      : { id: provider, displayName: 'Claude Code', isolation: { writeAccess: 'none' as const, enforcement: 'claude-restricted-read-tools' as const, verified: true } };
    let executable: string | undefined; let version: string | undefined;
    for (const candidate of this.#candidates[provider]) {
      if (path.isAbsolute(candidate)) { try { await access(candidate, constants.X_OK); } catch { continue; } }
      try {
        const result = await runCommand(candidate, ['--version'], { timeoutMs: 5_000 });
        if (result.code === 0 && versionNumber(`${result.stdout}\n${result.stderr}`)) {
          executable = candidate; version = versionNumber(`${result.stdout}\n${result.stderr}`); break;
        }
      } catch (error) { if (!(error instanceof CodingAgentError) || error.code !== 'missing') continue; }
    }
    if (!executable || !version) return { ...base, state: 'missing', detail: `${base.displayName} was not found on this machine.` };
    const testedVersion = provider === 'claude-code' ? '2.1.269' : '0.144.6';
    const tested = version === testedVersion;
    const qualification = tested ? 'tested' as const : 'untested-version' as const;
    const isolation = { ...base.isolation, verified: tested };
    this.#resolved.set(provider, { executable, version });
    const auth = provider === 'claude-code'
      ? await runCommand(executable, ['auth', 'status', '--json'], { timeoutMs: 10_000 })
      : await runCommand(executable, ['login', 'status'], { timeoutMs: 10_000 });
    const authenticated = provider === 'claude-code'
      ? (() => { try { return (JSON.parse(auth.stdout) as { loggedIn?: unknown }).loggedIn === true; } catch { return false; } })()
      : auth.code === 0 && /logged in/i.test(`${auth.stdout}\n${auth.stderr}`);
    if (!authenticated) return { ...base, isolation, state: 'unauthenticated', version, qualification, testedVersion, detail: `${base.displayName} ${version} is installed but not authenticated. SaySpec will not claim generation success.` };
    return { ...base, isolation, state: 'ready', version, qualification, testedVersion, detail: `${base.displayName} ${version} is installed and authenticated for explicit generation.` };
  }

  async #invokeCodex(executable: string, input: CodingAgentInvocation) {
    const schemaPath = path.join(input.workingDirectory, 'output-schema.json');
    await writeFile(schemaPath, `${JSON.stringify(input.outputSchema, null, 2)}\n`, { mode: 0o600 });
    const args = [
      '-a', 'never', '-s', 'read-only', '-C', input.workingDirectory,
      ...(input.noTools ? ['--disable', 'shell_tool', '--disable', 'code_mode_host', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation'] : []),
      'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--json', '--color', 'never', '--output-schema', schemaPath,
    ];
    for (const imagePath of input.evidenceImagePaths ?? []) args.push('-i', imagePath);
    args.push('--', input.prompt);
    const result = await runCommand(executable, args, { cwd: input.workingDirectory, signal: input.signal, timeoutMs: input.timeoutMs, onProgress: input.onProgress });
    if (result.code !== 0) throw providerError(result);
    return parseCodexOutput(result.stdout);
  }

  async #invokeClaude(executable: string, input: CodingAgentInvocation) {
    const tools = input.evidenceImagePaths?.length ? 'Read' : '';
    const args = [
      '--print', '--output-format', 'json', '--json-schema', JSON.stringify(input.outputSchema),
      '--restricted', '--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', tools,
      '--disallowedTools', 'Bash,Edit,Write,WebFetch,WebSearch,NotebookEdit', '--', input.prompt,
    ];
    const result = await runCommand(executable, args, { cwd: input.workingDirectory, signal: input.signal, timeoutMs: input.timeoutMs, onProgress: input.onProgress });
    if (result.code !== 0) throw providerError(result);
    return parseClaudeOutput(result.stdout);
  }
}
