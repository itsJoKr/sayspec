/**
 * Server-side authorization for fix decisions in cloud projects.
 *
 * The renderer only supplies the signed-in person's bearer token; the main
 * process sends each decision to the cloud backend itself and accepts it only
 * when the backend answers with the acting account. Guest and local-only
 * projects never reach this (they are authorized locally as "guest").
 *
 * The endpoint speaks the Firebase callable protocol (`POST {base}/{name}`
 * with `{"data": …}`, answered with `{"result": …}`). Its base URL is fixed at
 * build time (scripts/build-env.mjs), so local-only builds have none.
 */
export type FixDecision = 'managedFixDecide' | 'managedFixApplyAuthorize' | 'managedFixReadAuthorize' | 'managedFixAppliedRecord' | 'applicationFixReadAuthorize' | 'applicationFixDecide' | 'applicationFixApplyAuthorize' | 'applicationFixAppliedRecord';

export async function authorizeFixDecision(baseUrl: string, name: FixDecision, idToken: unknown, data: unknown): Promise<string> {
  if (!baseUrl) throw new Error('This build has no cloud backend to authorize the fix.');
  if (typeof idToken !== 'string' || !idToken || idToken.length > 16_384) throw new Error('Sign in again before deciding on a Pro fix.');
  const response = await fetch(`${baseUrl}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as { result?: { actorUid?: string }; error?: { message?: string } };
  if (!response.ok || !body.result?.actorUid) throw new Error(body.error?.message ?? 'The Pro fix decision could not be authorized.');
  return body.result.actorUid;
}
