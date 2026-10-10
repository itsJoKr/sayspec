import { createHash } from 'node:crypto';

/**
 * Tests kept in a storage folder carry their metadata in a comment header, so a
 * git checkout alone says who wrote a test and what it checks:
 *
 *   // SaySpec test · the @ lines are maintained by SaySpec
 *   // @id: test_3f1c…
 *   // @title: Checkout with saved address
 *   // @author: Jane Doe <jane@example.com>
 *   // @created: 2026-09-26T10:00:00.000Z
 *   // @step: Open the cart
 *   // @expect: The cart lists two items
 *
 *   import { test } from '@playwright/test';
 *
 * The same `//` comments work in TypeScript and Dart. The source after the
 * header is what SaySpec versions and runs, so editing the header never makes
 * a new test version.
 */
export type TestFramework = 'playwright' | 'patrol';
export type TestFileStep = { instruction: string; assertion: string };
export interface TestFileHeader {
  id?: string; title?: string; author?: string; created?: string; updated?: string;
  recording?: string; entrypoint?: string; steps: TestFileStep[];
}

const MARKER = '// SaySpec test · the @ lines are maintained by SaySpec';
const HEADER_LINE = /^\/\/\s*@([a-z][a-z-]*):\s?(.*)$/;
const HEADER_KEYS = new Set(['id', 'title', 'author', 'created', 'updated', 'recording', 'entrypoint', 'step', 'expect']);
const TEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;

export const testFileSuffix = (framework: TestFramework) => framework === 'playwright' ? '.spec.ts' : '_test.dart';
export const isTestFile = (name: string, framework: TestFramework) => name.endsWith(testFileSuffix(framework)) && name.length > testFileSuffix(framework).length;

/** A stable ID for a file without an `@id`, such as a test written by hand. */
export const fileTestId = (relativePath: string) => `file_${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`;
export const isValidTestId = (value: unknown): value is string => typeof value === 'string' && TEST_ID.test(value);

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

export function parseTestFile(text: string): { header: TestFileHeader; source: string } {
  const lines = text.split('\n');
  const header: TestFileHeader = { steps: [] };
  const marked = lines[0]?.trim() === MARKER;
  let index = marked ? 1 : 0; let sawField = false;
  for (; index < lines.length; index += 1) {
    const match = HEADER_LINE.exec(lines[index].trimEnd());
    // Unknown keys end the header, so a source comment such as `// @ts-expect-error: …` is never swallowed.
    if (!match || !HEADER_KEYS.has(match[1])) break;
    sawField = true;
    const [, key, raw] = match; const value = raw.trim();
    if (key === 'step') header.steps.push({ instruction: value, assertion: '' });
    else if (key === 'expect') { const last = header.steps.at(-1); if (last && !last.assertion) last.assertion = value; else header.steps.push({ instruction: '', assertion: value }); }
    else header[key as Exclude<keyof TestFileHeader, 'steps'>] = value;
  }
  if (!sawField && !marked) return { header: { steps: [] }, source: text };
  if (lines[index] === '') index += 1;
  return { header, source: lines.slice(index).join('\n') };
}

export function serializeTestFile(header: TestFileHeader, source: string) {
  const lines = [MARKER];
  const field = (key: string, value: string | undefined) => { if (value?.trim()) lines.push(`// @${key}: ${oneLine(value)}`); };
  field('id', header.id); field('title', header.title); field('author', header.author);
  field('created', header.created); field('updated', header.updated); field('recording', header.recording); field('entrypoint', header.entrypoint);
  for (const step of header.steps) { field('step', step.instruction); field('expect', step.assertion); }
  return `${lines.join('\n')}\n\n${source}`;
}

/** A readable, filesystem-safe file stem for a test title. */
export function testFileStem(title: string, framework: TestFramework) {
  const separator = framework === 'patrol' ? '_' : '-';
  const stem = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, separator).replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '').slice(0, 60).replace(new RegExp(`\\${separator}+$`), '');
  return stem || 'test';
}

/** A suite's folder name. Suites are plain folders, so the name is kept as typed apart from characters a folder cannot hold. */
export function suiteFolderName(name: string) {
  const cleaned = name.replace(/[/\\:\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120).trim();
  if (!cleaned) throw new Error('Suite name is required.');
  return cleaned;
}

export const suiteIdFor = (folderName: string) => `suite_${createHash('sha256').update(folderName).digest('hex').slice(0, 24)}`;
