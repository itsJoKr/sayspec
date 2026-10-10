import { access } from 'node:fs/promises';
import path from 'node:path';
import type { ReadinessItem, ReadinessReport, ReadinessRequest } from '@sayspec/contracts';
import { DirectoryHandleRegistry } from './jobs/directory-handles.ts';

async function executableOnPath(name: string, pathValue = process.env.PATH ?? '') {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try { await access(candidate); return true; } catch { /* continue */ }
  }
  return false;
}

export async function checkMachineReadiness(input: ReadinessRequest, directories: DirectoryHandleRegistry, pathValue = process.env.PATH ?? ''): Promise<ReadinessReport> {
  if (!['web', 'flutter'].includes(input.targetType) || !['configure', 'record', 'run'].includes(input.task)) throw new Error('Readiness request is invalid.');
  const items: ReadinessItem[] = [];
  if (input.sourceHandle) {
    try { await directories.resolve(input.sourceHandle, 'pubspec.yaml', { mustExist: input.targetType === 'flutter' }); items.push({ id: 'source', label: 'Local source', state: 'ready', detail: 'Selected directory handle is valid.' }); }
    catch { items.push({ id: 'source', label: 'Local source', state: 'missing', detail: 'The selected source is unavailable or does not match the target.', recovery: 'Choose the source directory again.' }); }
  } else if (input.targetType === 'flutter') items.push({ id: 'source', label: 'Flutter source', state: 'missing', detail: 'Flutter setup needs a local project containing pubspec.yaml.', recovery: 'Choose a Flutter project directory.' });
  else items.push({ id: 'source', label: 'Local source', state: 'ready', detail: 'Optional for URL-only Web projects.' });

  if (input.targetType === 'flutter') {
    const flutter = await executableOnPath('flutter', pathValue);
    const patrol = await executableOnPath('patrol', pathValue);
    items.push({ id: 'flutter', label: 'Flutter SDK', state: flutter ? 'ready' : 'missing', detail: flutter ? 'flutter is available for this task.' : 'flutter was not found on this machine.', recovery: flutter ? undefined : 'Install/configure Flutter yourself, then retry discovery.' });
    items.push({ id: 'patrol', label: 'Patrol CLI', state: patrol ? 'ready' : 'missing', detail: patrol ? 'patrol is available for this task.' : 'Patrol capture/run support is unavailable.', recovery: patrol ? undefined : 'Install Patrol through your approved developer setup, then retry.' });
  } else items.push({ id: 'web', label: 'Web target', state: 'ready', detail: 'URL-only setup does not require a Git repository.' });
  return { ready: items.every((item) => item.state === 'ready'), checkedAt: new Date().toISOString(), items };
}
