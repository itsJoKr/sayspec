export const ACCOUNT_PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function accountPasswordError(password: string): string | null {
  if (!password) return 'Enter a password.';
  if (password.length < ACCOUNT_PASSWORD_MIN) return `Use at least ${ACCOUNT_PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function emailError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Enter your email address.';
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address.';
  return null;
}

export function displayNameError(raw: string): string | null {
  const value = raw.trim();
  if (value.length > 80) return 'Use 80 characters or fewer.';
  return null;
}

export function workspaceNameError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Enter a workspace name.';
  if (value.length > 120) return 'Use 120 characters or fewer.';
  return null;
}

type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
const defaultRandom: RandomBytes = (bytes) => crypto.getRandomValues(bytes);

/** Organization IDs must match the backend ID pattern /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/. */
export function newOrganizationId(random: RandomBytes = defaultRandom) {
  return `org_${Array.from(random(new Uint8Array(10)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------------ company codes
// Eight letters from a 24-letter alphabet without I and O (easily confused with
// 1 and 0): 24^8 ≈ 1.1 × 10^11 codes. The server generates and validates codes;
// these helpers are the display/input contract shared with the desktop app.
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const JOIN_CODE_LENGTH = 8;

/** Accepts any case, spaces and hyphens ("abcd-efgh"), returning "ABCDEFGH" or null. */
export function normalizeJoinCode(raw: string): string | null {
  const value = raw.replace(/[\s-]/g, '').toUpperCase();
  if (value.length !== JOIN_CODE_LENGTH) return null;
  return [...value].every((char) => JOIN_CODE_ALPHABET.includes(char)) ? value : null;
}

/** Displays a code in two readable groups: "ABCD-EFGH". */
export function formatJoinCode(code: string) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Uniform random code with rejection sampling. Production codes are generated server-side. */
export function generateJoinCode(random: RandomBytes = defaultRandom) {
  const limit = 256 - (256 % JOIN_CODE_ALPHABET.length);
  let code = '';
  while (code.length < JOIN_CODE_LENGTH) {
    for (const byte of random(new Uint8Array(16))) {
      if (byte < limit && code.length < JOIN_CODE_LENGTH) code += JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length];
    }
  }
  return code;
}
