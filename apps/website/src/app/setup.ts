import { OperationError, type Services } from './adapters/types.ts';
import { newOrganizationId } from './validation.ts';

// Workspace provisioning after sign-up. The organization ID is generated once
// and reused across retries so a lost response cannot create a duplicate
// workspace. Only the ID and name are stored (session storage, non-sensitive).
interface PendingWorkspace { organizationId: string; name: string }
const key = (uid: string) => `sayspec.portal.pendingWorkspace.${uid}`;

export function readPendingWorkspace(uid: string): PendingWorkspace | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(uid)) ?? 'null') as PendingWorkspace | null;
    return value && typeof value.organizationId === 'string' && typeof value.name === 'string' ? value : null;
  } catch { return null; }
}

function write(uid: string, value: PendingWorkspace | null) {
  try { if (value) sessionStorage.setItem(key(uid), JSON.stringify(value)); else sessionStorage.removeItem(key(uid)); } catch { /* ignore */ }
}

export async function provisionWorkspace(services: Services, uid: string, name: string) {
  const previous = readPendingWorkspace(uid);
  const pending = previous && previous.name === name.trim() ? previous : { organizationId: newOrganizationId(), name: name.trim() };
  write(uid, pending);
  try {
    await services.workspace.createWorkspace(pending);
    write(uid, null);
  } catch (error) {
    if (error instanceof OperationError && error.kind === 'already-exists') {
      // Either an earlier attempt succeeded (the workspace list will show it)
      // or the ID collided; the next attempt uses a fresh ID.
      write(uid, null);
      throw new OperationError('already-exists', 'This workspace may already have been created. Wait a moment for it to appear, or try again.');
    }
    throw error;
  }
}

/** One-shot message carried from sign-up to the finish-setup screen. */
let setupMessage: string | null = null;
export function setSetupMessage(message: string | null) { setupMessage = message; }
export function takeSetupMessage() { const message = setupMessage; setupMessage = null; return message; }
