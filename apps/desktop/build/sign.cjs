const { execFileSync } = require('node:child_process');

// Sign with the certificate's SHA-1 hash from the signing keychain instead of its name. The same
// "Developer ID Application" name also exists in the login keychain, so codesign rejects the name
// as ambiguous even when --keychain is passed.
exports.default = async function sign(opts) {
  const { signAsync } = await import('@electron/osx-sign');
  if (!opts.keychain || !opts.identity) return signAsync(opts);
  const lines = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', opts.keychain], { encoding: 'utf8' }).split('\n');
  const match = lines.map((line) => /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"$/.exec(line)).find((m) => m && (m[1] === opts.identity || m[2].includes(opts.identity)));
  if (!match) throw new Error(`No signing identity matching "${opts.identity}" in ${opts.keychain}`);
  return signAsync({ ...opts, identity: match[1], identityValidation: false });
};
