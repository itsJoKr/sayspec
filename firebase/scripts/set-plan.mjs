// Operator tool: puts a workspace on the Free, Beta or Pro plan. Beta is unpaid
// and includes Pro features (SaySpec Cloud test storage). Pro is the paid plan;
// it is not offered yet and there is no billing, so setting it grants Pro
// features without payment. Only the plan kind
// changes; the seat limit and member counts are left as they are.
//
// The workspace is named by ID, or by its owner's email with --owner (the
// owner must own exactly one workspace; otherwise pass the ID).
//
// Dry run by default. Emulator:   FIRESTORE_EMULATOR_HOST=… node firebase/scripts/set-plan.mjs <organizationId> beta --apply
// A live project requires an explicit, separately approved release step:
//   SAYSPEC_PLAN_PROJECT=<id> node firebase/scripts/set-plan.mjs <organizationId> beta --apply
//   SAYSPEC_PLAN_PROJECT=<id> node firebase/scripts/set-plan.mjs --owner you@example.com beta --apply
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const ownerIndex = args.indexOf('--owner');
const ownerEmail = ownerIndex >= 0 ? args[ownerIndex + 1] : undefined;
const positional = args.filter((item, index) => !item.startsWith('--') && (ownerIndex < 0 || index !== ownerIndex + 1));
const [kind, idArgument] = ownerEmail ? [positional[0]] : [positional[1], positional[0]];
if ((!ownerEmail && !idArgument) || !['free', 'beta', 'pro'].includes(kind)) throw new Error('Usage: set-plan.mjs <organizationId | --owner <email>> <free|beta|pro> [--apply]');
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = emulator ? 'demo-sayspec-local' : process.env.SAYSPEC_PLAN_PROJECT;
if (!projectId) throw new Error('Refusing to run without the Firestore emulator or an explicit SAYSPEC_PLAN_PROJECT.');
const app = initializeApp({ projectId }, `set-plan-${Date.now()}`);
const db = getFirestore(app);
try {
  let organizationId = idArgument;
  if (ownerEmail) {
    const { uid } = await getAuth(app).getUserByEmail(ownerEmail);
    const owned = await db.collection('organizations').where('ownerUids', 'array-contains', uid).get();
    if (owned.size !== 1) throw new Error(`${ownerEmail} owns ${owned.size} workspaces${owned.size ? ` (${owned.docs.map((doc) => `${doc.id} "${doc.data().name}"`).join(', ')})` : ''}; pass the workspace ID instead.`);
    organizationId = owned.docs[0].id;
  }
  const organization = db.doc(`organizations/${organizationId}`);
  const snapshot = await organization.get();
  if (!snapshot.exists) throw new Error(`Workspace ${organizationId} does not exist.`);
  const from = snapshot.data().plan?.kind ?? null;
  if (apply) {
    await organization.update({ 'plan.kind': kind, planChangedAt: FieldValue.serverTimestamp() });
    await db.collection(`organizations/${organizationId}/audit`).add({ type: 'organization.plan-changed', actorUid: 'operator', from, to: kind, at: FieldValue.serverTimestamp() });
  }
  console.log(JSON.stringify({ organizationId, from, to: kind, applied: apply }));
} finally { await deleteApp(app); }
