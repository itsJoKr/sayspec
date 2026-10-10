/** Build-time settings for the Electron main process, derived from the same env file as the renderer. */

/** The Firebase callable base URL for fix authorization, or '' when the build has no Firebase backend. */
export function firebaseFunctionsBaseUrl(env) {
  if (env.VITE_SAYSPEC_CLOUD !== 'firebase') return '';
  const projectId = env.VITE_FIREBASE_PROJECT_ID?.trim() ?? '';
  const region = env.VITE_FIREBASE_FUNCTIONS_REGION?.trim() || 'europe-west1';
  if (!/^[a-z0-9-]+$/.test(projectId) || !/^[a-z]+-[a-z]+\d$/.test(region)) throw new Error('The Firebase project ID or Functions region in the build environment is invalid.');
  return env.VITE_FIREBASE_USE_EMULATORS === 'true' ? `http://127.0.0.1:5001/${projectId}/${region}` : `https://${region}-${projectId}.cloudfunctions.net`;
}

/** The account portal origin, or '' when the build has no cloud backend or no portal. */
export function accountPortalOrigin(env) {
  return env.VITE_SAYSPEC_CLOUD ? env.VITE_SAYSPEC_ACCOUNT_PORTAL_ORIGIN?.trim() ?? '' : '';
}
