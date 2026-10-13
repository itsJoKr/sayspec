/**
 * Desktop download configuration.
 *
 * /get-app offers the Mac download only when the build sets
 * `VITE_DESKTOP_DOWNLOAD_URL` to a signed, notarized release (the live build
 * points at the "latest" asset of the itsJoKr/sayspec GitHub releases). Only HTTPS
 * URLs and root-relative paths are accepted; anything else, or no value, keeps
 * the honest "Download coming soon" state.
 */
export type DesktopDownload = { available: true; url: string } | { available: false; url: null };

export function resolveDesktopDownload(value: string | undefined): DesktopDownload {
  const url = value?.trim() ?? '';
  if (url.startsWith('/') && !url.startsWith('//')) return { available: true, url };
  try {
    if (new URL(url).protocol === 'https:') return { available: true, url };
  } catch {
    // Not a URL: fall through to unavailable.
  }
  return { available: false, url: null };
}
