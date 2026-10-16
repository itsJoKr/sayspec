import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TestSuite } from '@sayspec/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { testAuthorLabel, type CurrentAuthor } from './test-author';
import { useTestRepository, type RepositorySource, type TestRepository } from './test-repository';
import { Button, Field, StatePanel, TopbarActions } from './ui';
import { ReviewPanel } from './review-panel';
import { GitChangesBar } from './git-changes';

function messageOf(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message.replace(/^(Firebase)?Error:\s*/, '') : fallback; }
// "Just Recorded" suites only stage fresh recordings: tests move out of them, never in, and they vanish once empty.
const isJustRecordedSuite = (suite: TestSuite) => Boolean(suite.sourceRecordingId) && suite.name === 'Just Recorded';

type TestRow = { id: string; title: string; author: string; issue?: string };
type ResolveRunBaseUrl = (testIds: string[]) => Promise<string>;
type CreateRunHandler = (testIds: string[], name: string, baseUrl: string) => Promise<void>;
/** Flutter runs need no name or base URL: the selection goes straight to the device runner. */
type DeviceRunHandler = (testIds: string[]) => void;

function defaultRunName() {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, '0');
  return `Test Run ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

function TriStateCheckbox({ selectedCount, total, label, onChange }: { selectedCount: number; total: number; label: string; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const checked = total > 0 && selectedCount === total;
  useEffect(() => { if (input.current) input.current.indeterminate = selectedCount > 0 && !checked; }, [checked, selectedCount]);
  return <input ref={input} type="checkbox" checked={checked} aria-checked={selectedCount > 0 && !checked ? 'mixed' : checked} aria-label={label} onChange={onChange} />;
}

function TestActions({ title, onMove, onRename, onDelete, onReview, canManage }: { title: string; onMove?: () => void; onRename: () => void; onDelete: () => void; onReview?: () => void; canManage: boolean }) {
  return <DropdownMenu.Root><DropdownMenu.Trigger className="test-menu-trigger" aria-label={`Options for ${title}`} title="Test options">⋯</DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="test-menu-content" align="end" sideOffset={4}>
      {onMove && <DropdownMenu.Item onSelect={onMove}>Move to suite…</DropdownMenu.Item>}
      {canManage && <><DropdownMenu.Item onSelect={onRename}>Rename</DropdownMenu.Item><DropdownMenu.Item onSelect={onDelete}>Delete</DropdownMenu.Item></>}
      {onReview && <DropdownMenu.Item onSelect={onReview}>Review</DropdownMenu.Item>}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

function SuiteActions({ name, onRename }: { name: string; onRename: () => void }) {
  return <DropdownMenu.Root><DropdownMenu.Trigger className="suite-menu-trigger" aria-label={`Options for ${name}`} title="Suite options">⋯</DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="test-menu-content" align="end" sideOffset={4}><DropdownMenu.Item onSelect={onRename}>Rename suite</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

function TestTable({ suiteName, rows, emptyMessage, selectedIds, onToggleTest, canManage = true, onMove, onRename, onDelete, onReview }: { suiteName: string; rows: TestRow[]; emptyMessage: string; selectedIds: Set<string>; onToggleTest: (id: string) => void; canManage?: boolean; onMove?: (id: string) => void; onRename: (id: string) => void; onDelete: (id: string) => void; onReview?: (id: string) => void }) {
  return <div className="test-table-wrap"><table className="test-table" aria-label={`${suiteName} tests`}><colgroup><col className="test-table-name-column" /><col className="test-table-author-column" /><col className="test-table-actions-column" /></colgroup>
    <thead><tr><th scope="col">Test</th><th scope="col">Author</th><th scope="col" className="test-table-actions">Actions</th></tr></thead>
    <tbody>{rows.length ? rows.map((test) => <tr key={test.id}><th scope="row" className="test-table-title"><label className="test-selection"><input type="checkbox" checked={selectedIds.has(test.id)} aria-label={`Select ${test.title}`} onChange={() => onToggleTest(test.id)} /><span>{test.title}</span></label>{test.issue && <span className="test-table-issue" title={test.issue}>Can’t run: {test.issue}</span>}</th><td className="test-table-author">{test.author}</td><td className="test-table-actions">{(canManage || onReview || onMove) && <TestActions title={test.title} canManage={canManage} onMove={onMove ? () => onMove(test.id) : undefined} onRename={() => onRename(test.id)} onDelete={() => onDelete(test.id)} onReview={onReview ? () => onReview(test.id) : undefined} />}</td></tr>) : <tr><td className="test-table-empty" colSpan={3}>{emptyMessage}</td></tr>}</tbody>
  </table></div>;
}

function SuiteList({ tests, suites, selectedIds, canManage, onToggleTest, onToggleSuite, onMove, onRenameSuite, onRenameTest, onDelete, onReview, emptyMessage }: { tests: TestRow[]; suites: TestSuite[]; selectedIds: Set<string>; canManage: boolean; onToggleTest: (id: string) => void; onToggleSuite: (suiteId: string, testIds: string[]) => void; onMove?: (id: string) => void; onRenameSuite: (suite: TestSuite) => void; onRenameTest: (id: string) => void; onDelete: (id: string) => void; onReview?: (id: string) => void; emptyMessage: string }) {
  const assigned = new Set<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const orderedSuites = suites.filter((suite) => !(isJustRecordedSuite(suite) && suite.testIds.length === 0)).sort((left, right) => Number(right.name === 'Just Recorded') - Number(left.name === 'Just Recorded'));
  const groups = orderedSuites.map((suite) => {
    const rows = tests.filter((test) => suite.testIds.includes(test.id) && !assigned.has(test.id));
    rows.forEach((test) => assigned.add(test.id));
    return { suite, rows };
  }).filter(({ suite, rows }) => rows.length > 0 || suite.testIds.length === 0);
  const unassigned = tests.filter((test) => !assigned.has(test.id));
  function toggleCollapsed(suiteId: string) { setCollapsed((current) => { const next = new Set(current); if (next.has(suiteId)) next.delete(suiteId); else next.add(suiteId); return next; }); }
  return <div className="suite-list">
    {groups.map(({ suite, rows }) => { const isCollapsed = collapsed.has(suite.id); const selectedCount = suite.testIds.filter((id) => selectedIds.has(id)).length; return <section className={`suite-section${suite.name === 'Just Recorded' ? ' suite-section--just-recorded' : ''}`} key={suite.id}>
      <div className="suite-section__header"><div className="suite-section__heading"><TriStateCheckbox selectedCount={selectedCount} total={suite.testIds.length} label={`Select all tests in ${suite.name}`} onChange={() => onToggleSuite(suite.id, suite.testIds)} /><button type="button" className="suite-collapse" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${suite.name}`} aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(suite.id)}>{isCollapsed ? '▸' : '▾'}</button><div><h2>{suite.name}</h2><span>{suite.testIds.length} {suite.testIds.length === 1 ? 'test' : 'tests'}{suite.sourceRecordingId && ' · Created from a recording'}</span></div></div>{canManage && <SuiteActions name={suite.name} onRename={() => onRenameSuite(suite)} />}</div>
      {!isCollapsed && <TestTable suiteName={suite.name} rows={rows} emptyMessage={emptyMessage} selectedIds={selectedIds} onToggleTest={onToggleTest} canManage={canManage} onMove={onMove} onRename={onRenameTest} onDelete={onDelete} onReview={onReview} />}
    </section>})}
    {unassigned.length > 0 && <section className="suite-section suite-section--unassigned"><div className="suite-section__header"><div className="suite-section__heading"><TriStateCheckbox selectedCount={unassigned.filter((test) => selectedIds.has(test.id)).length} total={unassigned.length} label="Select all unassigned tests" onChange={() => onToggleSuite('unassigned', unassigned.map((test) => test.id))} /><button type="button" className="suite-collapse" aria-label={`${collapsed.has('unassigned') ? 'Expand' : 'Collapse'} Unassigned`} aria-expanded={!collapsed.has('unassigned')} onClick={() => toggleCollapsed('unassigned')}>{collapsed.has('unassigned') ? '▸' : '▾'}</button><div><h2>Unassigned</h2><span>{unassigned.length} {unassigned.length === 1 ? 'test' : 'tests'}</span></div></div></div>{!collapsed.has('unassigned') && <TestTable suiteName="Unassigned" rows={unassigned} emptyMessage={emptyMessage} selectedIds={selectedIds} onToggleTest={onToggleTest} canManage={canManage} onMove={onMove} onRename={onRenameTest} onDelete={onDelete} onReview={onReview} />}</section>}
    {!groups.length && !unassigned.length && <div className="suite-list-empty">{emptyMessage}</div>}
  </div>;
}

function SuiteDialog({ mode, suite, open, busy, error, onOpenChange, onSubmit }: { mode: 'create' | 'rename'; suite?: TestSuite; open: boolean; busy: boolean; error: string; onOpenChange: (open: boolean) => void; onSubmit: (name: string) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); onSubmit(String(new FormData(event.currentTarget).get('name') ?? '').trim()); }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="suite-dialog-description">
    <Dialog.Title>{mode === 'create' ? 'Create suite' : 'Rename suite'}</Dialog.Title><Dialog.Description id="suite-dialog-description" className={mode === 'rename' ? 'sr-only' : undefined}>{mode === 'create' ? 'Create a place for related tests. Move tests into it by selecting them, or from their row menus.' : 'Give this suite a clear name.'}</Dialog.Description>
    <form className="rename-form" onSubmit={submit}><Field name="name" label="Suite name" defaultValue={suite?.name ?? ''} placeholder="e.g. Checkout flows" autoFocus required />{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><Dialog.Close asChild><Button type="button">Cancel</Button></Dialog.Close><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : mode === 'create' ? 'Create suite' : 'Save name'}</Button></div></form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

const NEW_SUITE = 'new-suite';
const UNASSIGNED = '';
type MoveDestination = { suiteId: string | null } | { newSuiteName: string };

/** Moves one test, or every selected one, into an existing suite, out of all suites, or into a suite named here. */
function MoveTestsDialog({ title, count, currentSuiteId, createdSuiteId, suites, busy, error, onOpenChange, onSubmit }: { title?: string; count: number; currentSuiteId: string | null | undefined; createdSuiteId?: string; suites: TestSuite[]; busy: boolean; error: string; onOpenChange: (open: boolean) => void; onSubmit: (destination: MoveDestination) => void }) {
  // `currentSuiteId` is undefined when the tests come from different places, so every destination stays on offer.
  const choices = suites.filter((suite) => suite.id !== currentSuiteId && !isJustRecordedSuite(suite));
  const options = [...choices.map((suite) => suite.id), ...(currentSuiteId === null ? [] : [UNASSIGNED]), NEW_SUITE];
  const [target, setTarget] = useState(options[0]);
  // A new suite that was created before a move failed is where a retry should go.
  useEffect(() => { if (createdSuiteId) setTarget(createdSuiteId); }, [createdSuiteId]);
  const selected = options.includes(target) ? target : options[0];
  const label = count === 1 ? 'Move test' : `Move ${count} tests`;
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); onSubmit(selected === NEW_SUITE ? { newSuiteName: String(new FormData(event.currentTarget).get('name') ?? '').trim() } : { suiteId: selected || null }); }
  return <Dialog.Root open onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="move-dialog-description">
    <Dialog.Title>{label}</Dialog.Title><Dialog.Description id="move-dialog-description">{title ? <>Choose where “{title}” should live.</> : count === 1 ? 'Choose where the selected test should live.' : <>Choose where the {count} selected tests should live.</>}</Dialog.Description>
    <form className="rename-form" onSubmit={submit}><label className="select-field">Suite<select value={selected} onChange={(event) => setTarget(event.target.value)}>{choices.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}{currentSuiteId !== null && <option value={UNASSIGNED}>Unassigned</option>}<option value={NEW_SUITE}>New suite…</option></select></label>{selected === NEW_SUITE && <Field name="name" label="New suite name" placeholder="e.g. Checkout flows" autoFocus required />}{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><Dialog.Close asChild><Button type="button">Cancel</Button></Dialog.Close><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Moving…' : label}</Button></div></form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function CreateRunDialog({ open, selectedCount, busy, baseUrlBusy, baseUrl, error, onOpenChange, onBaseUrlChange, onSubmit }: { open: boolean; selectedCount: number; busy: boolean; baseUrlBusy: boolean; baseUrl: string; error: string; onOpenChange: (open: boolean) => void; onBaseUrlChange: (value: string) => void; onSubmit: (name: string, baseUrl: string) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); onSubmit(String(form.get('name') ?? '').trim(), String(form.get('baseUrl') ?? '').trim()); }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="create-run-dialog-description">
    <Dialog.Title>Create test run</Dialog.Title><Dialog.Description id="create-run-dialog-description">Create a saved run containing {selectedCount} selected {selectedCount === 1 ? 'test' : 'tests'}. You can start it from the Runs tab.</Dialog.Description>
    <form className="rename-form" onSubmit={submit}><Field name="name" label="Run name" defaultValue={defaultRunName()} autoFocus required /><Field name="baseUrl" label="Web base URL" type="url" value={baseUrl} onChange={(event) => onBaseUrlChange(event.target.value)} placeholder="https://example.com" hint={baseUrlBusy ? 'Loading the URL from the selected recording…' : 'Uses the selected recording’s starting URL when available, otherwise the project Settings URL. You can change it for this run.'} required />{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><Dialog.Close asChild><Button type="button">Cancel</Button></Dialog.Close><Button type="submit" variant="primary" disabled={busy || baseUrlBusy}>{busy ? 'Creating…' : 'Create Test Run'}</Button></div></form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function LibraryHeader({ selectedCount, canCreateRun = true, canMove, onCreateRun, onMove, onCreateSuite }: { selectedCount: number; canCreateRun?: boolean; canMove: boolean; onCreateRun: () => void; onMove: () => void; onCreateSuite: () => void }) {
  return <div className="library-header"><div><p>Keep related tests together in suites. Select tests to build a run or move them to a suite, or select a suite to pick everything inside it.</p></div><div className="library-header__actions"><Button variant="secondary" onClick={onCreateSuite}>New suite</Button></div>
    {selectedCount > 0 && (canMove || canCreateRun) && <TopbarActions>{canMove && <Button data-testid="move-selected-tests" variant="secondary" onClick={onMove}>Move to suite <span className="button-count">({selectedCount})</span></Button>}{canCreateRun && <Button data-testid="create-test-run" variant="primary" onClick={onCreateRun}>Create Test Run <span className="button-count">({selectedCount})</span></Button>}</TopbarActions>}</div>;
}

function suiteForTest(testId: string, suites: TestSuite[]) { return suites.find((suite) => suite.testIds.includes(testId))?.id ?? null; }
/** The suite all of these tests share (`null` when all are unassigned), or undefined when they are spread out. */
function sharedSuite(testIds: string[], suites: TestSuite[]) {
  const homes = new Set(testIds.map((id) => suiteForTest(id, suites)));
  return homes.size === 1 ? [...homes][0] : undefined;
}

function RenameDialog({ title, open, onOpenChange, onSubmit, error }: { title: string; open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="rename-description">
    <Dialog.Title>Rename test</Dialog.Title><Dialog.Description id="rename-description" className="sr-only">Give this test a new name.</Dialog.Description>
    <form className="rename-form" onSubmit={onSubmit}><Field name="title" label="Test name" defaultValue={title} autoFocus required />{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><Dialog.Close asChild><Button type="button">Cancel</Button></Dialog.Close><Button type="submit" variant="primary">Save name</Button></div></form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

/**
 * The test library for any storage. Everything it lists or changes goes
 * through the project's `TestRepository`, so Firebase, the guest workspace and
 * a storage folder behave the same here.
 */
export function TestLibrary({ repository, reviewScope, currentUser, canManage, canCreateRun = true, defaultBaseUrl = '', resolveRunBaseUrl, onRecord, onCreateRun, onCreateDeviceRun }: { repository: TestRepository; reviewScope: { organizationId: string; projectId: string }; currentUser?: CurrentAuthor; canManage: boolean; canCreateRun?: boolean; defaultBaseUrl?: string; resolveRunBaseUrl: ResolveRunBaseUrl; onRecord: () => void; onCreateRun: CreateRunHandler; onCreateDeviceRun?: DeviceRunHandler }) {
  const { tests, suites } = repository;
  const [renameId, setRenameId] = useState<string | null>(null); const [move, setMove] = useState<{ testIds: string[]; fromSelection: boolean; createdSuiteId?: string } | null>(null); const [reviewId, setReviewId] = useState<string | null>(null); const [actionError, setActionError] = useState(''); const [dialogError, setDialogError] = useState(''); const [busy, setBusy] = useState(false); const [suiteDialog, setSuiteDialog] = useState<{ mode: 'create' | 'rename'; suite?: TestSuite } | null>(null); const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()); const [createRunOpen, setCreateRunOpen] = useState(false); const [createRunBusy, setCreateRunBusy] = useState(false); const [createRunBaseUrlBusy, setCreateRunBaseUrlBusy] = useState(false); const [createRunBaseUrl, setCreateRunBaseUrl] = useState(defaultBaseUrl); const [createRunError, setCreateRunError] = useState('');
  useEffect(() => { setRenameId(null); setMove(null); setSelectedIds(new Set()); }, [reviewScope.organizationId, reviewScope.projectId, repository.kind]);
  const renameTarget = tests.find((test) => test.id === renameId); const reviewTarget = repository.supportsReview ? tests.find((test) => test.id === reviewId) : undefined;
  async function saveSuite(name: string) {
    if (!suiteDialog || !name || !canManage) return; setBusy(true); setDialogError(''); const suite = suiteDialog.suite;
    try { await repository.saveSuite({ suiteId: suite?.id ?? `suite_${crypto.randomUUID()}`, expectedRevision: suite?.revision ?? 0, name, testIds: suite?.testIds ?? [], ...(suite?.sourceRecordingId ? { sourceRecordingId: suite.sourceRecordingId } : {}) }); setSuiteDialog(null); }
    catch (reason) { setDialogError(messageOf(reason, 'The suite could not be saved.')); } finally { setBusy(false); }
  }
  function openMove(testIds: string[], fromSelection: boolean) { setDialogError(''); setMove({ testIds, fromSelection }); }
  async function moveTests(destination: MoveDestination) {
    if (!canManage || !move || ('newSuiteName' in destination && !destination.newSuiteName)) return; setBusy(true); setDialogError('');
    try {
      let targetSuiteId = 'suiteId' in destination ? destination.suiteId : null;
      if ('newSuiteName' in destination) {
        const createdSuiteId = await repository.saveSuite({ suiteId: `suite_${crypto.randomUUID()}`, expectedRevision: 0, name: destination.newSuiteName, testIds: [] });
        targetSuiteId = createdSuiteId; setMove((current) => current && { ...current, createdSuiteId });
      }
      // One at a time: a storage folder moves files, and each move reloads the library.
      for (const testId of move.testIds) await repository.moveTest(testId, targetSuiteId);
      if (move.fromSelection) setSelectedIds(new Set());
      setMove(null);
    } catch (reason) { setDialogError(messageOf(reason, move.testIds.length === 1 ? 'The test could not be moved.' : 'The tests could not be moved.')); } finally { setBusy(false); }
  }
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!renameTarget) return; setActionError('');
    try { await repository.renameTest(renameTarget.id, String(new FormData(event.currentTarget).get('title')).trim()); setRenameId(null); }
    catch (reason) { setActionError(messageOf(reason, 'The test could not be renamed. Check the name and try again.')); }
  }
  async function deleteTest(testId: string) { setActionError(''); try { await repository.deleteTest(testId); } catch (reason) { setActionError(messageOf(reason, 'The test could not be deleted. Check your access and try again.')); } }
  async function openCreateRun() {
    setCreateRunError(''); setCreateRunOpen(true); setCreateRunBaseUrl(defaultBaseUrl); setCreateRunBaseUrlBusy(true);
    try { setCreateRunBaseUrl(await resolveRunBaseUrl([...selectedIds])); }
    catch { setCreateRunBaseUrl(defaultBaseUrl); }
    finally { setCreateRunBaseUrlBusy(false); }
  }
  async function createRun(name: string, baseUrl: string) {
    if (!name || !baseUrl || !selectedIds.size) return;
    setCreateRunBusy(true); setCreateRunError('');
    try { await onCreateRun([...selectedIds], name, baseUrl); setSelectedIds(new Set()); setCreateRunOpen(false); }
    catch (reason) { setCreateRunError(messageOf(reason, 'The test run could not be created.')); }
    finally { setCreateRunBusy(false); }
  }
  function toggleTest(testId: string) { setSelectedIds((current) => { const next = new Set(current); if (next.has(testId)) next.delete(testId); else next.add(testId); return next; }); }
  function toggleSuite(_suiteId: string, testIds: string[]) { setSelectedIds((current) => { const next = new Set(current); if (testIds.length && testIds.every((id) => next.has(id))) testIds.forEach((id) => next.delete(id)); else testIds.forEach((id) => next.add(id)); return next; }); }
  const rows = tests.map((test) => ({ id: test.id, title: test.title, author: repository.kind === 'cloud' && currentUser ? testAuthorLabel(test, currentUser) : test.authorLabel ?? 'Unknown author', ...(test.issue ? { issue: test.issue } : {}) }));
  const paged = repository.page > 0 || repository.hasNext;
  // A storage folder in a repository: changed test files can be committed from here. Refreshes as the library changes.
  const gitKey = JSON.stringify([tests.map((test) => [test.id, test.title]), suites.map((suite) => [suite.id, suite.testIds])]);
  return <section className="test-library" aria-label="Test library"><LibraryHeader selectedCount={selectedIds.size} canCreateRun={canCreateRun} canMove={canManage} onMove={() => openMove([...selectedIds], true)} onCreateRun={() => onCreateDeviceRun ? onCreateDeviceRun([...selectedIds]) : void openCreateRun()} onCreateSuite={() => { setDialogError(''); setSuiteDialog({ mode: 'create' }); }} />
    {repository.kind === 'folder' && <GitChangesBar target={{ kind: 'tests', organizationId: reviewScope.organizationId, projectId: reviewScope.projectId }} refreshKey={gitKey} />}
    {repository.status === 'error' ? <StatePanel tone="error" title={repository.kind === 'folder' ? 'Test folder unavailable' : 'Tests unavailable'} action={<Button onClick={repository.reload}>Try again</Button>}>{repository.kind === 'folder' ? 'Check that the folder under Settings → Test storage still exists, then retry.' : 'Check your workspace access, then retry.'}</StatePanel>
      : repository.status === 'loading' && !tests.length ? <div className="library-loading" role="status">Loading tests…</div>
        : !tests.length ? <StatePanel tone="empty" title="No tests yet" action={<Button variant="primary" onClick={onRecord}>Record your first test</Button>}>{repository.kind === 'folder' ? 'Record a walkthrough to make a test. It is saved as a file in your test folder.' : 'Record a walkthrough to make a test.'}</StatePanel>
          : <><SuiteList tests={rows} suites={suites} selectedIds={selectedIds} onToggleTest={toggleTest} onToggleSuite={toggleSuite} canManage={canManage} onMove={canManage ? (id) => openMove([id], false) : undefined} onRenameSuite={(suite) => { setDialogError(''); setSuiteDialog({ mode: 'rename', suite }); }} onRenameTest={(id) => { setActionError(''); setRenameId(id); }} onDelete={(id) => void deleteTest(id)} onReview={repository.supportsReview ? setReviewId : undefined} emptyMessage={paged ? 'No tests from this suite are on this page.' : 'No tests in this suite yet.'} />{paged && <div className="pagination"><Button disabled={repository.page === 0} onClick={repository.previousPage}>Previous</Button><span>Page {repository.page + 1}</span><Button disabled={!repository.hasNext} onClick={repository.nextPage}>Next</Button></div>}</>}
    {renameTarget && <RenameDialog key={renameTarget.id} title={renameTarget.title} open onOpenChange={(open) => { if (!open) setRenameId(null); }} onSubmit={rename} error={actionError} />}
    <CreateRunDialog key={`${reviewScope.projectId}-${selectedIds.size}`} open={createRunOpen} selectedCount={selectedIds.size} busy={createRunBusy} baseUrlBusy={createRunBaseUrlBusy} baseUrl={createRunBaseUrl} error={createRunError} onOpenChange={(open) => { if (!open) setCreateRunOpen(false); }} onBaseUrlChange={setCreateRunBaseUrl} onSubmit={(name, baseUrl) => void createRun(name, baseUrl)} />
    {suiteDialog && <SuiteDialog mode={suiteDialog.mode} suite={suiteDialog.suite} open onOpenChange={(open) => { if (!open) setSuiteDialog(null); }} busy={busy} error={dialogError} onSubmit={(name) => void saveSuite(name)} />}
    {move && <MoveTestsDialog title={move.testIds.length === 1 ? tests.find((test) => test.id === move.testIds[0])?.title : undefined} count={move.testIds.length} currentSuiteId={sharedSuite(move.testIds, suites)} createdSuiteId={move.createdSuiteId} suites={suites} onOpenChange={(open) => { if (!open && !busy) setMove(null); }} busy={busy} error={dialogError} onSubmit={(destination) => void moveTests(destination)} />}
    {reviewTarget && <ReviewPanel key={reviewTarget.id} organizationId={reviewScope.organizationId} projectId={reviewScope.projectId} testId={reviewTarget.id} title={reviewTarget.title} reviewerUid={reviewTarget.reviewerUid} reviewerRevision={reviewTarget.reviewerRevision ?? 0} canManage={canManage} onClose={() => setReviewId(null)} />}
    {actionError && !renameTarget && <p className="inline-error" role="alert">{actionError}</p>}
  </section>;
}

/** The library for a project, reading from whichever storage the project uses. */
export function ProjectTestLibrary({ source, ...props }: { source: RepositorySource } & Omit<Parameters<typeof TestLibrary>[0], 'repository' | 'reviewScope'>) {
  const repository = useTestRepository(source);
  return <TestLibrary repository={repository} reviewScope={{ organizationId: source.organizationId, projectId: source.projectId }} {...props} />;
}
