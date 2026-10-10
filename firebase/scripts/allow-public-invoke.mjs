// Operator tool: lets clients reach the deployed callables.
//
// Needed when the project sits under a Google Cloud organization that enforces
// domain-restricted sharing (constraints/iam.allowedPolicyMemberDomains), so `firebase deploy`
// cannot grant allUsers the Cloud Run invoker role. Instead this turns off the
// Cloud Run invoker IAM check on each callable's service, which is Google's
// documented alternative for public services under that constraint. Callables
// still require Firebase Auth in code (actor() in functions/src/index.ts).
//
// Dry run by default; lists each service and whether its invoker check is on.
//   SAYSPEC_INVOKER_PROJECT=<project-id> node firebase/scripts/allow-public-invoke.mjs [--apply]
// Credentials: Application Default Credentials, or an OAuth access token in
// SAYSPEC_ACCESS_TOKEN (never logged).
import { GoogleAuth } from 'google-auth-library';

const projectId = process.env.SAYSPEC_INVOKER_PROJECT;
if (!projectId) throw new Error('Refusing to run without an explicit SAYSPEC_INVOKER_PROJECT.');
const region = 'europe-west1';
const apply = process.argv.includes('--apply');
const token = process.env.SAYSPEC_ACCESS_TOKEN || await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getAccessToken();
const api = async (url, init = {}) => {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message ?? url}`);
  return body;
};

const base = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`;
const services = [];
for (let pageToken = ''; ;) {
  const page = await api(`${base}?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
  services.push(...(page.services ?? []));
  if (!page.nextPageToken) break;
  pageToken = page.nextPageToken;
}
// Only services Cloud Functions manages for this project's callables.
const callables = services.filter((service) => service.labels?.['goog-managed-by'] === 'cloudfunctions');
const results = [];
for (const service of callables) {
  const name = service.name.split('/').at(-1);
  if (service.invokerIamDisabled) { results.push({ name, invokerIamDisabled: true, changed: false }); continue; }
  if (!apply) { results.push({ name, invokerIamDisabled: false, changed: false }); continue; }
  // The update rolls out a new revision. Cloud Functions pins the template's
  // revision name, so clear it and let Cloud Run name the new one.
  try {
    await api(`https://run.googleapis.com/v2/${service.name}?updateMask=invokerIamDisabled,template.revision`, { method: 'PATCH', body: JSON.stringify({ invokerIamDisabled: true, template: { revision: '' } }) });
    results.push({ name, invokerIamDisabled: true, changed: true });
  } catch (error) {
    results.push({ name, invokerIamDisabled: false, changed: false, error: error.message });
  }
}
console.log(JSON.stringify({ projectId, region, apply, services: callables.length, changed: results.filter((item) => item.changed).length, pending: results.filter((item) => !item.invokerIamDisabled).map((item) => item.name), errors: results.filter((item) => item.error).map(({ name, error }) => ({ name, error })) }));
if (results.some((item) => item.error)) process.exitCode = 1;
