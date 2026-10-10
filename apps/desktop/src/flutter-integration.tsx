import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { FlutterIntegrationPreview } from '@sayspec/contracts';
import { Button } from './ui';

const messageOf = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error));

/**
 * Reviewable recorder integration for the selected Flutter project.
 *
 * Every proposed file is shown with its reason and full content, and only the
 * files the user keeps checked are written. Applying the pubspec change also
 * runs the project's pinned `flutter pub get` so recording can start.
 */
export function RecorderIntegrationDialog({ open, onOpenChange, sourceHandle, onApplied }: { open: boolean; onOpenChange: (open: boolean) => void; sourceHandle: string; onApplied: () => void }) {
  const [preview, setPreview] = useState<FlutterIntegrationPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setPreview(null); setError('');
    void window.sayspec!.previewFlutterIntegration({ sourceHandle, appId: '' })
      .then((next) => { setPreview(next); setSelected(new Set(next.files.map((file) => file.relativePath))); })
      .catch((reason) => setError(messageOf(reason)));
  }, [open, sourceHandle]);

  function toggle(relativePath: string, checked: boolean) {
    setSelected((current) => { const next = new Set(current); if (checked) next.add(relativePath); else next.delete(relativePath); return next; });
  }

  async function apply() {
    setBusy(true); setError('');
    try {
      await window.sayspec!.applyFlutterIntegration({ sourceHandle, appId: '', relativePaths: [...selected] });
      onApplied();
      onOpenChange(false);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }

  const nothingToChange = preview !== null && !preview.files.length;
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content recorder-integration-dialog" aria-describedby="recorder-integration-description">
    <Dialog.Title>Add the SaySpec recorder</Dialog.Title>
    <Dialog.Description id="recorder-integration-description">Review each change to <strong>{preview?.sourcePath ?? 'the selected project'}</strong>. Only the checked files are written.</Dialog.Description>
    {!preview && !error && <p role="status">Preparing the integration…</p>}
    {preview && (nothingToChange
      ? <p>The recorder files are already in place. Resolve the dependency to finish.</p>
      : <ul className="recorder-integration-files">{preview.files.map((file) => <li key={file.relativePath}>
        <label><input type="checkbox" checked={selected.has(file.relativePath)} disabled={busy} onChange={(event) => toggle(file.relativePath, event.target.checked)} /><code>{file.relativePath}</code>{!file.baseSha256 && <span className="recorder-integration-files__new">new file</span>}</label>
        <p>{file.description}</p>
        <details><summary>Show proposed file</summary><pre>{file.proposedText}</pre></details>
      </li>)}</ul>)}
    {preview && preview.notes.length > 0 && <ul className="recorder-integration-notes">{preview.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    {busy && <p role="status">{selected.has('pubspec.yaml') || nothingToChange ? 'Applying and running flutter pub get…' : 'Applying…'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="dialog-actions"><Dialog.Close asChild><Button type="button" disabled={busy}>Cancel</Button></Dialog.Close>
      <Button variant="primary" disabled={busy || !preview || (!nothingToChange && selected.size === 0)} onClick={() => void apply()}>{nothingToChange ? 'Run flutter pub get' : `Apply ${selected.size} ${selected.size === 1 ? 'file' : 'files'}`}</Button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
