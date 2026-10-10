import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FlutterCapture, PatrolGenerationSubmission } from '@sayspec/contracts';

const EXACT_KEYS = ['captureId', 'dependencies', 'evidenceEventIds', 'framework', 'relativePath', 'source', 'title', 'transcriptSegmentIds'];

export async function readPatrolDependencyManifest(sourcePath: string) {
  const pubspec = await readFile(path.join(sourcePath, 'pubspec.yaml'), 'utf8').catch(() => undefined);
  if (!pubspec) throw new Error('The selected source is not a Flutter project: pubspec.yaml is missing.');
  const patrol = /^\s{2}patrol:\s*([^\s#]+)/m.exec(pubspec)?.[1]?.replace(/["']/g, '');
  if (!patrol) throw new Error('The selected project does not pin the Patrol package. Finish Flutter setup first.');
  return { patrol } as const;
}

/**
 * Checks one test of a session: `captureId` names the session recording it is
 * generated from, and every citation must belong to that recording. The other
 * recordings are context only.
 */
export function validatePatrolGenerationSubmission(input: unknown, session: readonly FlutterCapture[], expectedDependencies: Readonly<Record<string, string>>) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The Patrol submission must be one JSON object.');
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== EXACT_KEYS.length || keys.some((key, index) => key !== EXACT_KEYS[index])) throw new Error(`The Patrol submission must contain exactly: ${EXACT_KEYS.join(', ')}.`);
  const capture = session.find((item) => item.summary.id === value.captureId);
  if (!capture) throw new Error('captureId must name one recording of this session.');
  if (value.framework !== 'patrol') throw new Error('Unsupported framework. This recording can only generate a Patrol test.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) throw new Error('The Patrol title is missing or too long.');
  if (typeof value.relativePath !== 'string' || !/^patrol_test\/[A-Za-z0-9_./-]+_test\.dart$/.test(value.relativePath) || value.relativePath.includes('..')) throw new Error('The Patrol entrypoint must be a safe patrol_test/*_test.dart path.');
  if (typeof value.source !== 'string' || !value.source.length || value.source.length > 512 * 1024) throw new Error('The Patrol source is missing or exceeds 512 KiB.');
  if (!value.source.includes('SAYSPEC_GENERATED') || !value.source.includes("package:patrol/patrol.dart") || !/patrolTest\s*\(/.test(value.source)) throw new Error('The source is not a marked Patrol test.');
  if (!/\bexpect\s*\(/.test(value.source)) throw new Error('The generated Patrol test has no explicit assertion for the narrated expectation.');
  if (!value.dependencies || typeof value.dependencies !== 'object' || Array.isArray(value.dependencies)) throw new Error('The dependency manifest is missing.');
  if (JSON.stringify(sortRecord(value.dependencies as Record<string, unknown>)) !== JSON.stringify(sortRecord(expectedDependencies))) throw new Error('The submitted dependency manifest differs from the selected project pins.');
  if (!capture.narration?.sha256 || !capture.narration.byteLength) throw new Error('This capture has no verified microphone narration.');
  if (!capture.transcript || capture.transcript.status !== 'ready' || !capture.transcript.segments.length) throw new Error('Transcribe this Flutter narration before generating a Patrol test.');
  if (capture.summary.status !== 'ready') throw new Error(`The Flutter capture is ${capture.summary.status}; only a completed capture can generate a test.`);
  const transcriptSegmentIds = stringIds(value.transcriptSegmentIds, 'transcript segment');
  const evidenceEventIds = stringIds(value.evidenceEventIds, 'evidence event');
  const transcriptIds = new Set(capture.transcript.segments.map((segment) => segment.id));
  const eventIds = new Set(capture.events.map((event) => event.id));
  if (transcriptSegmentIds.some((id) => !transcriptIds.has(id))) throw new Error('The submission cites a transcript segment outside its recording.');
  if (evidenceEventIds.some((id) => !eventIds.has(id))) throw new Error('The submission cites an evidence event outside its recording.');
  const citedActions = capture.events.filter((event) => evidenceEventIds.includes(event.id) && event.kind === 'action');
  const missingIdentity = citedActions.find((event) => !event.widget);
  if (missingIdentity) throw new Error(`${missingIdentity.id} has no widget identity. Record the flow again with an instrumented widget instead of inventing a finder.`);
  const suggestions = capture.assertions.filter((item) => evidenceEventIds.includes(item.eventId));
  if (citedActions.length && suggestions.length && suggestions.every((item) => item.confidence === 'low')) throw new Error('The cited widgets have only ambiguous type-based finders. Add a key or semantics label and record again.');
  const submission: PatrolGenerationSubmission = {
    captureId: capture.summary.id, title: value.title.trim(), framework: 'patrol', relativePath: value.relativePath, source: value.source,
    dependencies: value.dependencies as Record<string, string>, transcriptSegmentIds, evidenceEventIds,
  };
  return { submission, capture, sourceSha256: createHash('sha256').update(submission.source).digest('hex'), dependencyManifestSha256: createHash('sha256').update(JSON.stringify(sortRecord(submission.dependencies))).digest('hex') };
}

function stringIds(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((item) => typeof item !== 'string' || !item || item.length > 160)) throw new Error(`Cite at least one valid ${label} ID.`);
  return [...new Set(value as string[])];
}

function sortRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
