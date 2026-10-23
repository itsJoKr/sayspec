/** A paragraph of a test's description, or a preformatted block such as the command that runs it. */
export type TestAboutBlock = { kind: 'text' | 'code'; text: string };

/**
 * What a Patrol file says about itself, for people who do not read Dart: its
 * first top-level `///` comment before `main` (the file's description of the
 * test) and the name of every patrolTest it declares.
 */
export function describePatrolSource(source: string): { about: TestAboutBlock[]; cases: string[] } {
  const lines = source.split(/\r?\n/);
  const main = lines.findIndex((line) => /^(?:Future<void>|void)\s+main\s*\(/.test(line));
  const start = lines.findIndex((line, index) => line.startsWith('///') && (main < 0 || index < main));
  const about: TestAboutBlock[] = [];
  let current: TestAboutBlock | undefined; let fenced = false;
  const add = (kind: TestAboutBlock['kind'], text: string) => {
    if (current?.kind === kind) current.text += kind === 'code' ? `\n${text}` : ` ${text}`;
    else { current = { kind, text }; about.push(current); }
  };
  for (let index = start; index >= 0 && index < lines.length && lines[index].startsWith('///'); index += 1) {
    const line = lines[index].slice(3).replace(/^ /, '');
    if (line.trim().startsWith('```')) { fenced = !fenced; current = undefined; continue; }
    if (fenced) { add('code', line); continue; }
    if (!line.trim()) { current = undefined; continue; }
    // dartdoc reads an indented line as code, e.g. "  patrol test -t patrol_test/cart_test.dart".
    if (/^ {2,}/.test(line)) add('code', line.trim());
    else add('text', line.trim());
  }
  const cases = [...source.matchAll(/\bpatrolTest\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) => match[2].replace(/\\(.)/g, '$1'));
  return { about, cases };
}
