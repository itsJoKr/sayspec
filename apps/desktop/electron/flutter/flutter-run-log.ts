import { stripAnsi } from './patrol-log.ts';

interface MachineEvent { event?: unknown; params?: Record<string, unknown> }

/**
 * The human-readable text of one `flutter run --machine` stdout line.
 *
 * The daemon wraps build output, progress and app logs in JSON events; those
 * are unwrapped, bookkeeping events (debug ports, app ids) are dropped, and a
 * plain line (Gradle or Xcode output that bypasses the protocol) is kept as is.
 */
export function readableFlutterRunLines(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let events: MachineEvent[] | undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) events = parsed as MachineEvent[];
  } catch { /* plain output */ }
  if (!events) return [stripAnsi(line.replace(/\s+$/, ''))];
  const lines: string[] = [];
  for (const { event, params = {} } of events) {
    const text = (value: unknown) => typeof value === 'string' ? stripAnsi(value).replace(/\s+$/, '') : '';
    switch (event) {
      case 'daemon.logMessage': lines.push(text(params.message)); break;
      case 'daemon.log': case 'app.log': lines.push(text(params.log)); break;
      case 'app.progress': if (params.finished !== true) lines.push(text(params.message)); break;
      case 'app.started': lines.push('The app started.'); break;
      case 'app.stop': lines.push(params.error ? `The app stopped: ${text(params.error)}` : 'The app stopped.'); break;
      default: break;
    }
  }
  return lines.flatMap((value) => value.split('\n')).filter((value) => value.trim().length > 0);
}
