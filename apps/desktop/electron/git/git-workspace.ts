import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitChangedFile, GitCommitRecord, GitRepositoryStatus, GitTargetView } from '@sayspec/contracts';

/**
 * What a Git target resolves to on this machine. `directory` is where the
 * changes live; the repository is whichever one contains it.
 */
export interface GitTargetSpec {
  /** Commits made for this target are recorded under this key. */
  key: string;
  /** The view lists commits whose key starts with this (defaults to `key`). */
  keyPrefix?: string;
  /** Undefined when nothing for this target is kept in files on this machine. */
  directory?: string;
  /** Shown instead of Git details when there is no directory or no repository. */
  note?: string;
  /** Paths relative to `directory` that may be committed; undefined allows the whole directory. */
  paths?: string[];
  /** Narrows a whole-directory target to the files SaySpec keeps there (path relative to `directory`). */
  include?: (relativePath: string) => boolean;
  /** Every changed path must be committed together (an applied fix is one change). */
  exactPaths?: boolean;
  /** Reports the repository without offering commits. */
  statusOnly?: boolean;
  /** Says why committing the current changes would commit more than SaySpec wrote. */
  verify?: (repository: GitRepository) => Promise<string | undefined>;
  branchStem: string;
  message: string;
}

/** A repository as `verify` sees it: paths are relative to the target's directory. */
export interface GitRepository {
  /** SHA-256 of the file as last committed, or undefined when HEAD does not have it. */
  committedSha256(relativePath: string): Promise<string | undefined>;
  /** SHA-256 of the file in the working tree, or undefined when it is missing. */
  workingSha256(relativePath: string): Promise<string | undefined>;
}

type StoredCommit = GitCommitRecord & { root: string };
type Run = { code: number; stdout: string; stderr: string };
type Identity = { name?: string; email?: string };

const SHORT = 10_000;
const COMMIT_TIMEOUT = 5 * 60_000;
const NETWORK_TIMEOUT = 3 * 60_000;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
/** One exact path: never a glob or pathspec magic, without changing how the user's hooks read pathspecs. */
const literal = (value: string) => `:(literal)${value}`;
const clip = (value: string) => { const lines = value.trim().split('\n').filter(Boolean); return lines.slice(-12).join('\n').slice(0, 1_500); };
/** Up to 40 characters of whole words, for branch names. */
function slug(value: string) {
  const words = value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let result = '';
  for (const word of words) { const next = result ? `${result}-${word}` : word; if (next.length > 40) break; result = next; }
  return result || words[0]?.slice(0, 40) || 'change';
}
const matches = (spec: GitTargetSpec, record: GitCommitRecord) => spec.keyPrefix ? record.targetKey.startsWith(spec.keyPrefix) : record.targetKey === spec.key;
export const branchStem = (prefix: string, title: string, id?: string) => `${prefix}-${slug(title)}${id ? `-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase()}` : ''}`;

/** A remote's URL without credentials, its web address and the kind of host. */
export function parseRemote(url: string): NonNullable<GitRepositoryStatus['remote']> & { repository?: string; hostname?: string } {
  const value = url.trim();
  let hostname: string | undefined; let repository: string | undefined; let safe = value;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(value);
  if (scp) { hostname = scp[1]; repository = scp[2]; }
  else {
    try {
      const parsed = new URL(value);
      if (['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) {
        hostname = parsed.hostname; repository = parsed.pathname.replace(/^\/+/, '');
        if (parsed.protocol.startsWith('http')) { parsed.username = ''; parsed.password = ''; safe = parsed.toString(); }
      }
    } catch { /* a local path */ }
  }
  repository = repository?.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const host = !hostname ? 'other' : /github/i.test(hostname) ? 'github' : /gitlab/i.test(hostname) ? 'gitlab' : /bitbucket/i.test(hostname) ? 'bitbucket' : 'other';
  return { name: '', url: safe, host, ...(hostname && repository ? { webUrl: `https://${hostname}/${repository}`, repository, hostname } : {}) };
}

/** The host's page for opening a pull request from `branch` into `base`. */
export function compareUrl(remote: ReturnType<typeof parseRemote>, base: string, branch: string) {
  if (!remote.webUrl) return undefined;
  const ref = (value: string) => value.split('/').map(encodeURIComponent).join('/');
  if (remote.host === 'github') return `${remote.webUrl}/compare/${ref(base)}...${ref(branch)}?expand=1`;
  if (remote.host === 'gitlab') return `${remote.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`;
  if (remote.host === 'bitbucket') return `${remote.webUrl}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(base)}`;
  return undefined;
}

/** Parses `git status --porcelain=v1 -z`. A rename lists its old path as deleted so both sides are committed. */
export function parseStatus(output: string): GitChangedFile[] {
  const parts = output.split('\0'); const files: GitChangedFile[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]; if (entry.length < 4) continue;
    const code = entry.slice(0, 2); const file = entry.slice(3);
    if (code === '!!') continue;
    if (code === '??') { files.push({ path: file, status: 'untracked' }); continue; }
    if (code.includes('R') || code.includes('C')) {
      const previous = parts[index + 1]; index += 1;
      files.push({ path: file, status: 'renamed' });
      if (previous && code.includes('R')) files.push({ path: previous, status: 'deleted' });
      continue;
    }
    files.push({ path: file, status: code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified' });
  }
  return files;
}

/**
 * Commits, pushes and opens pull requests for changes SaySpec made in a Git
 * repository the user chose. SaySpec commits only the files it lists, to a
 * branch it creates or, when the user chooses, to the checked-out branch, and
 * runs the user's own `git` (and GitHub CLI), so their credentials, hooks and
 * configuration apply and SaySpec stores no token.
 */
export class GitWorkspace {
  readonly #path: string;
  readonly #tool: (name: 'git' | 'gh') => Promise<string | undefined>;
  readonly #environment: () => Promise<NodeJS.ProcessEnv>;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #identity: () => Identity | null;
  #records: StoredCommit[] = [];
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(input: { storePath: string; tool: (name: 'git' | 'gh') => Promise<string | undefined>; environment?: () => Promise<NodeJS.ProcessEnv>; openExternal: (url: string) => Promise<void>; identity?: () => Identity | null }) {
    this.#path = input.storePath; this.#tool = input.tool; this.#openExternal = input.openExternal;
    this.#environment = input.environment ?? (async () => process.env);
    this.#identity = input.identity ?? (() => null);
  }

  async initialize() {
    await mkdir(path.dirname(this.#path), { recursive: true });
    try { const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8')); if (Array.isArray(parsed)) this.#records = parsed as StoredCommit[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async view(spec: GitTargetSpec): Promise<GitTargetView> {
    const empty = { changes: [], suggestedBranch: `sayspec/${spec.branchStem}`, suggestedMessage: spec.message, commits: [] };
    if (!spec.directory) return { status: { repository: false, ...(spec.note ? { note: spec.note } : {}) }, ...empty };
    const found = await this.#repository(spec.directory);
    if ('note' in found) return { status: { repository: false, note: found.note === 'not-a-repository' ? spec.note : found.note }, ...empty };
    const { root, prefix } = found;
    const status = await this.#status(root);
    const commits = this.#records.filter((item) => item.root === root && matches(spec, item))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 10).map(({ root: _root, ...item }) => item);
    if (spec.statusOnly) return { status, ...empty, commits };
    const changes = await this.#changes(root, prefix, spec.paths, spec.include);
    let blocked: string | undefined;
    if (changes.length) blocked = await this.#blocked(root, status) ?? await spec.verify?.(this.#handle(root, prefix));
    return { status, changes, ...(blocked ? { blocked } : {}), suggestedBranch: await this.#freeBranch(root, `sayspec/${spec.branchStem}`), suggestedMessage: spec.message, commits };
  }

  /**
   * Commits `paths` (from the repository root) to a new SaySpec branch, or to the
   * checked-out branch. A SaySpec branch keeps its base; any other branch is its
   * own base, so the commit is pushed straight to it with no pull request.
   */
  async commit(spec: GitTargetSpec, input: { paths: string[]; message: string; branch: { kind: 'new'; name: string } | { kind: 'current' } }): Promise<GitCommitRecord> {
    if (!spec.directory || spec.statusOnly) throw new Error('There is nothing SaySpec can commit here.');
    const message = typeof input.message === 'string' ? input.message.replace(/\r\n/g, '\n').trim() : '';
    if (!message || message.length > 5_000 || message.includes('\0')) throw new Error('Write a commit message of up to 5,000 characters.');
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.some((item) => typeof item !== 'string')) throw new Error('Choose at least one file to commit.');
    const found = await this.#repository(spec.directory);
    if ('note' in found) throw new Error('This folder is not in a Git repository.');
    const { root } = found;
    return this.#locked(root, async () => {
      const view = await this.view(spec);
      if (view.blocked) throw new Error(view.blocked);
      const changed = new Set(view.changes.map((item) => item.path));
      const paths = [...new Set(input.paths)];
      if (paths.some((item) => !changed.has(item))) throw new Error('The changes moved on since you looked. Review them again.');
      if (spec.exactPaths && paths.length !== changed.size) throw new Error('An applied fix is committed as a whole.');
      const original = view.status.branch!;
      let branch = original; const baseBranch = view.status.sayspecBranch?.baseBranch ?? original;
      if (input.branch.kind === 'new') {
        branch = String(input.branch.name ?? '').trim();
        if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('.lock') || branch.endsWith('/') || (await this.#git(root, ['check-ref-format', '--branch', branch])).code !== 0) throw new Error('Choose a valid branch name, such as sayspec/fix-login.');
        if ((await this.#git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) throw new Error(`A branch named ${branch} already exists. Choose another name.`);
      }
      // Without --no-renames a staged rename lists only its new path, and undoing a failed commit would unstage the old one.
      const staged = new Set((await this.#git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--', ...paths.map(literal)])).stdout.split('\0').filter(Boolean));
      // A staged deletion, such as the old side of a staged rename, is in neither the index nor the working tree:
      // `git add` rejects its path, and the commit takes the deletion as staged.
      const indexed = new Set((await this.#git(root, ['ls-files', '-z', '--', ...paths.map(literal)])).stdout.split('\0').filter(Boolean));
      const present = await Promise.all(paths.map((item) => indexed.has(item) || lstat(path.join(root, item)).then(() => true, () => false)));
      const adding = paths.filter((_item, index) => present[index]);
      if (input.branch.kind === 'new') await this.#must(root, ['checkout', '-q', '-b', branch], 'Git could not create the branch');
      const identity = await this.#identityOptions(root);
      const added: Run = adding.length ? await this.#git(root, ['add', '-A', '--', ...adding.map(literal)]) : { code: 0, stdout: '', stderr: '' };
      const committed = added.code === 0 ? await this.#git(root, [...identity, 'commit', '-q', '-m', message, '--', ...paths.map(literal)], COMMIT_TIMEOUT) : added;
      if (committed.code !== 0) {
        const unstage = paths.filter((item) => !staged.has(item));
        if (unstage.length) await this.#git(root, ['reset', '-q', '--', ...unstage.map(literal)]);
        if (input.branch.kind === 'new') { await this.#git(root, ['checkout', '-q', original]); await this.#git(root, ['branch', '-q', '-D', branch]); }
        throw new Error(`Git did not commit. ${clip(committed.stderr || committed.stdout) || 'It gave no reason.'}`);
      }
      const commit = (await this.#must(root, ['rev-parse', 'HEAD'], 'Git could not read the new commit')).stdout.trim();
      const record: StoredCommit = { id: `git_commit_${randomUUID()}`, root, targetKey: spec.key, repositoryName: path.basename(root), branch, baseBranch, commit, subject: message.split('\n')[0].slice(0, 200), paths, createdAt: new Date().toISOString(), createdBranch: input.branch.kind === 'new' };
      this.#records.push(record); await this.#persist();
      const { root: _root, ...result } = record; return result;
    });
  }

  async push(spec: GitTargetSpec, commitId: string): Promise<GitCommitRecord> {
    const record = this.#record(spec, commitId);
    return this.#locked(record.root, async () => {
      await this.#contains(record);
      const status = await this.#status(record.root);
      const remote = record.remote ?? status.remote?.name;
      if (!remote) throw new Error('This repository has no remote to push to. Add one, for example with git remote add origin <url>, then push again.');
      const pushed = await this.#git(record.root, ['push', '-u', remote, `refs/heads/${record.branch}:refs/heads/${record.branch}`], NETWORK_TIMEOUT);
      if (pushed.code !== 0) throw new Error(`Git could not push ${record.branch} to ${remote}. ${clip(pushed.stderr || pushed.stdout)}\nCheck that git push works for this repository in Terminal.`);
      const now = new Date().toISOString();
      // Earlier commits on the same branch went up with this one.
      for (const item of this.#records) if (item.root === record.root && item.branch === record.branch && !item.pushedAt && (item === record || (await this.#git(record.root, ['merge-base', '--is-ancestor', item.commit, record.branch])).code === 0)) { item.pushedAt = now; item.remote = remote; }
      await this.#persist();
      const { root: _root, ...result } = record; return result;
    });
  }

  async pullRequest(spec: GitTargetSpec, commitId: string): Promise<GitCommitRecord> {
    const record = this.#record(spec, commitId);
    if (record.branch === record.baseBranch) throw new Error(`This commit went straight to ${record.branch}, so there is no pull request to open.`);
    const sibling = this.#records.find((item) => item.root === record.root && item.branch === record.branch && item.pullRequestUrl);
    if (sibling?.pullRequestUrl) { record.pullRequestUrl = sibling.pullRequestUrl; await this.#persist(); await this.#openExternal(sibling.pullRequestUrl); const { root: _root, ...result } = record; return result; }
    if (!record.pushedAt || !record.remote) throw new Error('Push the branch before opening a pull request.');
    const url = (await this.#must(record.root, ['remote', 'get-url', record.remote], `The remote ${record.remote} is gone`)).stdout.trim();
    const remote = parseRemote(url);
    const base = await this.#pullRequestBase(record);
    const body = `${(await this.#git(record.root, ['log', '-1', '--format=%b', record.commit])).stdout.trim()}\n\nOpened from SaySpec.`.trim();
    const gh = remote.host === 'github' && remote.repository ? await this.#tool('gh') : undefined;
    if (gh) {
      const repository = remote.hostname === 'github.com' ? remote.repository! : `${remote.hostname}/${remote.repository}`;
      const existing = await this.#run(gh, ['pr', 'list', '--repo', repository, '--head', record.branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], record.root, NETWORK_TIMEOUT);
      let created = existing.code === 0 ? /https:\/\/\S+/.exec(existing.stdout)?.[0] : undefined;
      if (!created && existing.code === 0) {
        const result = await this.#run(gh, ['pr', 'create', '--repo', repository, '--base', base, '--head', record.branch, '--title', record.subject, '--body', body], record.root, NETWORK_TIMEOUT);
        created = result.code === 0 ? /https:\/\/\S+/.exec(result.stdout)?.[0] : undefined;
      }
      if (created) {
        for (const item of this.#records) if (item.root === record.root && item.branch === record.branch) item.pullRequestUrl = created;
        await this.#persist(); await this.#openExternal(created);
        const { root: _root, ...result } = record; return result;
      }
      // Not signed in to the GitHub CLI, or it failed: the browser still works.
    }
    const page = compareUrl(remote, base, record.branch);
    if (!page) throw new Error(`Open a pull request for ${record.branch} into ${base} in your Git host.`);
    await this.#openExternal(page);
    record.pullRequestOpenedAt = new Date().toISOString(); await this.#persist();
    const { root: _root, ...result } = record; return result;
  }

  async #pullRequestBase(record: StoredCommit) {
    if ((await this.#git(record.root, ['show-ref', '--verify', '--quiet', `refs/remotes/${record.remote}/${record.baseBranch}`])).code === 0) return record.baseBranch;
    const head = (await this.#git(record.root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${record.remote}/HEAD`])).stdout.trim();
    return head.startsWith(`${record.remote}/`) ? head.slice(record.remote!.length + 1) : record.baseBranch;
  }

  #record(spec: GitTargetSpec, commitId: string) {
    const record = this.#records.find((item) => item.id === commitId && matches(spec, item));
    if (!record) throw new Error('That commit is not one SaySpec made here.');
    return record;
  }

  async #contains(record: StoredCommit) {
    if ((await this.#git(record.root, ['merge-base', '--is-ancestor', record.commit, `refs/heads/${record.branch}`])).code !== 0) throw new Error(`The branch ${record.branch} no longer contains commit ${record.commit.slice(0, 7)}.`);
  }

  async #repository(directory: string): Promise<{ root: string; prefix: string } | { note: string }> {
    if (!await stat(directory).then((value) => value.isDirectory(), () => false)) return { note: 'The folder is not available on this Mac.' };
    if (!await this.#tool('git')) return { note: 'Git is not installed, so changes stay as edits in the folder.' };
    const top = await this.#git(directory, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || !top.stdout.trim()) return { note: 'not-a-repository' };
    const root = await realpath(top.stdout.trim()); const real = await realpath(directory);
    const prefix = path.relative(root, real).split(path.sep).join('/');
    if (prefix.startsWith('..')) return { note: 'not-a-repository' };
    return { root, prefix };
  }

  async #status(root: string): Promise<GitRepositoryStatus> {
    const branch = (await this.#git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || undefined;
    const upstream = branch ? (await this.#git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])).stdout.trim() : '';
    const remotes = (await this.#git(root, ['remote'])).stdout.split('\n').map((item) => item.trim()).filter(Boolean);
    const upstreamRemote = remotes.find((name) => upstream.startsWith(`${name}/`));
    const sayspec = this.#records.filter((item) => item.root === root && item.branch === branch && item.createdBranch).sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    const remoteName = sayspec?.remote ?? upstreamRemote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
    let remote: GitRepositoryStatus['remote'];
    if (remoteName) {
      const { repository: _repository, hostname: _hostname, ...parsed } = parseRemote((await this.#git(root, ['remote', 'get-url', remoteName])).stdout.trim());
      remote = { ...parsed, name: remoteName };
    }
    return {
      repository: true, name: path.basename(root), ...(branch ? { branch } : { detached: true }),
      ...(sayspec ? { sayspecBranch: { name: sayspec.branch, baseBranch: sayspec.baseBranch } } : {}),
      ...(remote ? { remote, pullRequests: remote.host === 'github' && await this.#tool('gh') ? 'github-cli' as const : 'browser' as const } : {}),
    };
  }

  async #blocked(root: string, status: GitRepositoryStatus) {
    if (!status.branch) return 'The repository has no branch checked out. Check out a branch, then commit.';
    if ((await this.#git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return 'The repository has no commits yet. Make a first commit, then SaySpec can commit on top of it.';
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      const location = (await this.#git(root, ['rev-parse', '--git-path', marker])).stdout.trim();
      if (location && await stat(path.resolve(root, location)).then(() => true, () => false)) return 'A merge or rebase is in progress in this repository. Finish it first.';
    }
    return undefined;
  }

  async #changes(root: string, prefix: string, paths: string[] | undefined, include?: (relativePath: string) => boolean) {
    const join = (relative: string) => [prefix, relative].filter(Boolean).join('/');
    const specs = (paths === undefined ? [prefix || '.'] : paths.map(join)).map(literal);
    if (!specs.length) return [];
    const result = await this.#git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...specs]);
    if (result.code !== 0) throw new Error(`Git could not read the changes. ${clip(result.stderr)}`);
    const files = parseStatus(result.stdout);
    return include ? files.filter((file) => include(prefix ? file.path.slice(prefix.length + 1) : file.path)) : files;
  }

  #handle(root: string, prefix: string): GitRepository {
    const join = (relative: string) => [prefix, relative].filter(Boolean).join('/');
    return {
      committedSha256: async (relative) => { const result = await this.#bytes(root, ['show', `HEAD:${join(relative)}`]); return result ? sha(result) : undefined; },
      workingSha256: async (relative) => readFile(path.join(root, ...join(relative).split('/'))).then(sha, () => undefined),
    };
  }

  async #freeBranch(root: string, wanted: string) {
    for (let attempt = 1; attempt < 50; attempt += 1) {
      const name = attempt === 1 ? wanted : `${wanted}-${attempt}`;
      if ((await this.#git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code !== 0) return name;
    }
    return `${wanted}-${Date.now()}`;
  }

  /** The signed-in SaySpec identity stands in only when Git has no author configured for this repository. */
  async #identityOptions(root: string) {
    const [name, email] = await Promise.all([this.#git(root, ['config', 'user.name']), this.#git(root, ['config', 'user.email'])]);
    if (name.stdout.trim() && email.stdout.trim()) return [];
    const identity = this.#identity();
    if (!identity?.email) return [];
    return ['-c', `user.name=${name.stdout.trim() || identity.name || identity.email}`, '-c', `user.email=${email.stdout.trim() || identity.email}`];
  }

  async #locked<T>(root: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const settled = next.catch(() => undefined); this.#locks.set(root, settled);
    void settled.then(() => { if (this.#locks.get(root) === settled) this.#locks.delete(root); });
    return next;
  }

  async #must(root: string, args: string[], failure: string) {
    const result = await this.#git(root, args);
    if (result.code !== 0) throw new Error(`${failure}. ${clip(result.stderr || result.stdout)}`);
    return result;
  }

  async #git(cwd: string, args: string[], timeout = SHORT): Promise<Run> {
    const git = await this.#tool('git');
    if (!git) return { code: 127, stdout: '', stderr: 'Git is not installed.' };
    return this.#run(git, args, cwd, timeout);
  }

  async #bytes(cwd: string, args: string[]) {
    const git = await this.#tool('git'); if (!git) return undefined;
    const env = await this.#env();
    return new Promise<Buffer | undefined>((resolve) => execFile(git, args, { cwd, env, timeout: SHORT, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout)));
  }

  async #run(command: string, args: string[], cwd: string, timeout: number): Promise<Run> {
    const env = await this.#env();
    return new Promise((resolve) => execFile(command, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1 : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && !stderr ? error.message : '') });
    }));
  }

  async #env(): Promise<NodeJS.ProcessEnv> {
    // Never wait for a password prompt or an editor nobody can see.
    return { ...await this.#environment(), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  }

  async #persist() {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(this.#records, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.#path);
  }
}
