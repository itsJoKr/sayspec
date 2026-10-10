import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const modulePath = require.resolve('node-pty');
  const packageRoot = path.resolve(path.dirname(modulePath), '..');
  const helper = path.join(packageRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  const status = await stat(helper);
  if (!status.isFile()) throw new Error('node-pty spawn helper is missing.');
  await chmod(helper, 0o755);
}
