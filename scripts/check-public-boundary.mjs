// Fails when SaySpec Cloud code (backend, website, billing) appears in this
// public repository. SaySpec Cloud lives in a separate, private repository.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const forbiddenPaths = [/^apps\/website\//, /^firebase\//, /^firebase\.json$/, /^\.firebaserc$/, /^firestore\.(rules|indexes\.json)$/, /^storage\.rules$/, /(^|\/)\.secret\.local$/, /(^|\/)\.env\.(live|sayspec)$/];
const forbiddenText = [/from ['"]stripe['"]/, /firebase-functions\/(v2|params)/, /\bsk_(test|live)_[A-Za-z0-9]{8,}/, /\brk_(test|live)_[A-Za-z0-9]{8,}/, /\bwhsec_[A-Za-z0-9]{16,}/];
const problems = files.filter((file) => forbiddenPaths.some((pattern) => pattern.test(file))).map((file) => `private path: ${file}`);
const text = files.filter((file) => /\.(m?[jt]sx?|json|md|ya?ml|html|css|env.*)$/.test(file) && file !== 'scripts/check-public-boundary.mjs');
for (const file of text) {
  if (!existsSync(file)) continue;
  const source = readFileSync(file, 'utf8');
  for (const pattern of forbiddenText) if (pattern.test(source)) problems.push(`${file}: matches ${pattern}`);
}
if (problems.length) {
  console.error(`This repository must contain only the SaySpec desktop app:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`Public boundary OK (${files.length} files).`);
