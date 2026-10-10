// Operator backfill for workspaces created before Milestone 12: recounts active
// members, writes the server plan fields (free Beta seat limit) and copies
// member names/emails from Firebase Auth. It never removes, demotes or
// reactivates anyone; over-limit workspaces are reported and keep every member.
//
// Dry run by default. Emulator:   FIRESTORE_EMULATOR_HOST=… FIREBASE_AUTH_EMULATOR_HOST=… node firebase/scripts/backfill-membership.mjs --apply
// A live project requires an explicit, separately approved release step:
//   SAYSPEC_BACKFILL_PROJECT=<id> node firebase/scripts/backfill-membership.mjs --apply
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { reconcileOrganization } from '../functions/lib/membership.js';

const apply = process.argv.includes('--apply');
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = emulator ? 'demo-sayspec-local' : process.env.SAYSPEC_BACKFILL_PROJECT;
if (!projectId) throw new Error('Refusing to run without the Firestore emulator or an explicit SAYSPEC_BACKFILL_PROJECT.');
if (emulator && !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Set FIREBASE_AUTH_EMULATOR_HOST as well, so Auth reads never reach a live project.');
const app = initializeApp({ projectId }, `membership-backfill-${Date.now()}`);
const db = getFirestore(app); const auth = getAuth(app);
const lookup = async (uids) => {
  const profiles = new Map();
  for (let index = 0; index < uids.length; index += 100) {
    const result = await auth.getUsers(uids.slice(index, index + 100).map((uid) => ({ uid })));
    result.users.forEach((user) => profiles.set(user.uid, { email: user.email, displayName: user.displayName }));
  }
  return profiles;
};
try {
  const organizations = await db.collection('organizations').get();
  const report = [];
  for (const organization of organizations.docs) {
    if (!apply) {
      const active = (await organization.ref.collection('members').where('status', '==', 'active').get()).size;
      report.push({ organizationId: organization.id, activeMemberCount: active, hasPlan: Boolean(organization.data().plan) });
      continue;
    }
    report.push(await reconcileOrganization(db, organization.id, lookup));
  }
  console.log(JSON.stringify({ projectId, apply, organizations: report.length, overLimit: report.filter((item) => item.overLimit).map((item) => item.organizationId), report }));
} finally { await deleteApp(app); }
