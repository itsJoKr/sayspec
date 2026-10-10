import { useEffect, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Field } from './ui';

/** A small Delete project button for the project's settings header; deletes after the user types the project's name. */
export function DeleteProjectButton({ projectName, consequence, disabledReason, onDelete }: { projectName: string; consequence: string; disabledReason?: string; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setTyped(''); setError(''); } }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (typed.trim() !== projectName) return;
    setDeleting(true); setError('');
    try { await onDelete(); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^(Firebase)?Error:\s*/, '') : 'The project could not be deleted.'); }
    finally { setDeleting(false); }
  }

  return <>
    <Button type="button" variant="quiet" className="delete-project-button" data-testid="project-delete" disabled={Boolean(disabledReason)} title={disabledReason ?? `Delete ${projectName}`} onClick={() => setOpen(true)}>Delete project</Button>
    <Dialog.Root open={open} onOpenChange={(next) => { if (!deleting) setOpen(next); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="delete-project-description">
      <Dialog.Title>Delete “{projectName}”?</Dialog.Title>
      <Dialog.Description id="delete-project-description">{consequence} This cannot be undone.</Dialog.Description>
      <form className="rename-form" onSubmit={submit}>
        <Field label={`Type ${projectName} to confirm`} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoFocus />
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions"><Dialog.Close asChild><Button type="button" disabled={deleting}>Cancel</Button></Dialog.Close><Button type="submit" variant="danger" data-testid="project-delete-confirm" disabled={deleting || typed.trim() !== projectName}>{deleting ? 'Deleting…' : 'Delete project'}</Button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
