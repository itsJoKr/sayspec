import { useEffect, useRef, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { GitCommitRecord, GitTarget, GitTargetView } from '@sayspec/contracts';
import { Button } from './ui';

const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error:\s*/, '') : String(error);
const STATUS: Record<GitTargetView['changes'][number]['status'], string> = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'New' };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Every Git view reloads after a commit, push or pull request anywhere: a pull request covers every commit on its branch. */
const GIT_CHANGED = 'sayspec:git-changed';

/** Loads a target's Git view, again when `refreshKey` changes and when the window regains focus. */
function useGitView(target: GitTarget | null, refreshKey?: unknown) {
  const [view, setView] = useState<GitTargetView | null>(null); const [error, setError] = useState('');
  const key = target ? JSON.stringify(target) : '';
  const revision = useRef(0);
  async function load() {
    if (!target) { setView(null); return; }
    const current = ++revision.current;
    try { const next = await window.sayspec!.getGitView({ target }); if (current === revision.current) { setView(next); setError(''); } }
    catch (reason) { if (current === revision.current) setError(messageOf(reason)); }
  }
  useEffect(() => { setView(null); void load(); }, [key]);
  useEffect(() => { if (refreshKey !== undefined) void load(); }, [refreshKey]);
  useEffect(() => { const refresh = () => { void load(); }; window.addEventListener('focus', refresh); window.addEventListener(GIT_CHANGED, refresh); return () => { window.removeEventListener('focus', refresh); window.removeEventListener(GIT_CHANGED, refresh); }; }, [key]);
  return { view, error, reload: load };
}

function Where({ view }: { view: GitTargetView }) {
  const { status } = view;
  return <span className="git-where">{status.name}{status.branch ? <> · on <code>{status.branch}</code></> : ' · no branch checked out'}{status.remote && <> · {status.remote.name} <span title={status.remote.url}>{status.remote.webUrl?.replace(/^https:\/\//, '') ?? status.remote.url}</span></>}</span>;
}

/** One line about a folder's repository, for Settings. */
export function GitSummary({ target }: { target: GitTarget | null }) {
  const { view } = useGitView(target);
  if (!view) return null;
  if (!view.status.repository) return view.status.note ? <span className="git-summary git-summary--none">{view.status.note}</span> : null;
  return <span className="git-summary" data-testid="git-summary">Git repository · <Where view={view} /></span>;
}

/**
 * Commit, push and pull request for changes SaySpec made in a Git repository.
 * SaySpec commits only the listed files, only to a branch it creates (or one it
 * created earlier), and runs the user's own Git, so their login and hooks apply.
 */
export function GitChanges({ target, refreshKey, title = 'Commit to Git', onChanged }: { target: GitTarget | null; refreshKey?: unknown; title?: string; onChanged?: () => void }) {
  const { view, error: loadError, reload } = useGitView(target, refreshKey);
  if (!target || !view) return loadError ? <p className="inline-error" role="alert">{loadError}</p> : null;
  if (!view.status.repository) return view.status.note ? <p className="git-note">{view.status.note}</p> : null;
  return <GitPanel target={target} view={view} title={title} reload={async () => { await reload(); onChanged?.(); }} />;
}

/** The library's line for a test folder in a repository: changed test files, with commit in a dialog. */
export function GitChangesBar({ target, refreshKey }: { target: GitTarget | null; refreshKey?: unknown }) {
  const { view, reload } = useGitView(target, refreshKey);
  const [open, setOpen] = useState(false);
  if (!target || !view?.status.repository) return null;
  const waiting = view.commits.filter((item) => !item.pushedAt || (!item.pullRequestUrl && !item.pullRequestOpenedAt));
  if (!view.changes.length && !waiting.length) return null;
  return <div className="git-bar" data-testid="git-bar"><span><strong>Git</strong> · {view.changes.length ? `${plural(view.changes.length, 'changed test file')} not committed` : 'committed tests ready to push or review'} · <Where view={view} /></span>
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><Button>{view.changes.length ? 'Commit…' : 'Push or review…'}</Button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content git-dialog" aria-describedby="git-dialog-description"><Dialog.Title>Commit tests to Git</Dialog.Title><Dialog.Description id="git-dialog-description">Test files SaySpec keeps in this folder. Other files in the repository are left alone.</Dialog.Description>
        <GitPanel target={target} view={view} title="" reload={reload} />
        <div className="dialog-actions"><Dialog.Close asChild><Button type="button">Close</Button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}

function GitPanel({ target, view, title, reload }: { target: GitTarget; view: GitTargetView; title: string; reload: () => Promise<void> }) {
  const { status, changes, commits } = view;
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [message, setMessage] = useState(view.suggestedMessage);
  const [mode, setMode] = useState<'current' | 'new'>(status.sayspecBranch ? 'current' : 'new'); const [branch, setBranch] = useState(view.suggestedBranch);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const exact = target.kind === 'application-fix';
  const changeKey = changes.map((item) => item.path).join('\0');
  useEffect(() => { setSelected(new Set(changes.map((item) => item.path))); }, [changeKey]);
  useEffect(() => { setMessage(view.suggestedMessage); }, [view.suggestedMessage]);
  useEffect(() => { setBranch(view.suggestedBranch); }, [view.suggestedBranch]);
  useEffect(() => { setMode(status.sayspecBranch ? 'current' : 'new'); }, [status.sayspecBranch?.name]);
  async function act(action: () => Promise<string>) {
    setBusy(true); setError(''); setNotice('');
    let text = ''; try { text = await action(); } catch (reason) { setError(messageOf(reason)); }
    // The notice appears once the panel shows the new state.
    await reload().catch(() => undefined); window.dispatchEvent(new Event(GIT_CHANGED));
    setNotice(text); setBusy(false);
  }
  const commit = (event: FormEvent) => { event.preventDefault(); void act(async () => {
    const record = await window.sayspec!.commitGitChanges({ target, paths: [...selected], message, branch: mode === 'current' ? { kind: 'current' } : { kind: 'new', name: branch.trim() } });
    return `Committed ${record.commit.slice(0, 7)} on ${record.branch}.${record.createdBranch ? ` This checkout is now on ${record.branch}.` : ''}`;
  }); };
  const push = (record: GitCommitRecord) => act(async () => { const next = await window.sayspec!.pushGitCommit({ target, commitId: record.id }); return `Pushed ${next.branch} to ${next.remote}.`; });
  const pullRequest = (record: GitCommitRecord) => act(async () => { const next = await window.sayspec!.openGitPullRequest({ target, commitId: record.id }); return next.pullRequestUrl ? `Pull request: ${next.pullRequestUrl}` : 'Opened the new pull request page in your browser.'; });
  // Only the newest commit on each branch needs buttons; pushing it pushes the ones before it.
  const shown = commits.filter((item, index) => commits.findIndex((other) => other.branch === item.branch) === index).slice(0, 4);
  return <section className="git-panel" aria-label="Git">
    {title && <h4>{title}</h4>}
    <p className="git-panel__where"><Where view={view} /></p>
    {view.blocked && <p className="inline-error" role="alert">{view.blocked}</p>}
    {changes.length > 0 && !view.blocked && <form className="git-commit-form" onSubmit={commit}>
      <fieldset><legend>{exact ? 'Files in this fix' : 'Files to commit'}</legend>
        <ul className="git-files">{changes.map((file) => <li key={file.path}>{exact
          ? <span className="git-files__row"><code>{file.path}</code><span>{STATUS[file.status]}</span></span>
          : <label className="git-files__row"><input type="checkbox" checked={selected.has(file.path)} disabled={busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })} /><code>{file.path}</code><span>{STATUS[file.status]}</span></label>}</li>)}</ul>
      </fieldset>
      <fieldset className="git-branch"><legend>Branch</legend>
        {status.sayspecBranch && <label className="git-branch__choice"><input type="radio" name="git-branch" checked={mode === 'current'} disabled={busy} onChange={() => setMode('current')} /><span>Add to <code>{status.sayspecBranch.name}</code>, the SaySpec branch you are on</span></label>}
        <label className="git-branch__choice">{status.sayspecBranch && <input type="radio" name="git-branch" checked={mode === 'new'} disabled={busy} onChange={() => setMode('new')} />}<span>New branch from <code>{status.branch}</code></span><input aria-label="New branch name" value={branch} disabled={busy || mode !== 'new'} onChange={(event) => setBranch(event.target.value)} spellCheck={false} /></label>
      </fieldset>
      <label className="git-message">Commit message<textarea value={message} rows={4} disabled={busy} onChange={(event) => setMessage(event.target.value)} /></label>
      <div className="git-actions"><Button variant="primary" type="submit" disabled={busy || !selected.size || !message.trim() || (mode === 'new' && !branch.trim())}>{busy ? 'Working…' : `Commit ${plural(selected.size, 'file')}`}</Button>
        <span className="control-help">{mode === 'new' ? 'SaySpec creates the branch, switches this checkout to it and commits only these files. Your other changes stay as they are.' : 'SaySpec commits only these files to this branch.'}</span></div>
    </form>}
    {!changes.length && !commits.length && <p className="git-note">Nothing to commit: these files match the last commit.</p>}
    {shown.length > 0 && <ul className="git-commits" aria-label="Commits made by SaySpec">{shown.map((record) => <li key={record.id}>
      <span><code>{record.commit.slice(0, 7)}</code> {record.subject} · <code>{record.branch}</code>{record.pushedAt ? ` · pushed to ${record.remote}` : ''}</span>
      <span className="git-commits__actions">{!record.pushedAt
        ? status.remote ? <Button disabled={busy} onClick={() => void push(record)}>Push to {status.remote.name}</Button> : <span className="control-help">No remote is set up, so the commit stays in this repository.</span>
        : <Button disabled={busy} onClick={() => void pullRequest(record)}>{record.pullRequestUrl ? 'Open pull request' : status.pullRequests === 'github-cli' ? 'Create pull request' : 'Open pull request page'}</Button>}</span>
    </li>)}</ul>}
    {error && <p className="inline-error git-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
