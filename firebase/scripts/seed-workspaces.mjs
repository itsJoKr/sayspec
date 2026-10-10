import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  acceptInvitation, createInvitation, createOrganization, createProject, setProjectGrant,
} from '../functions/lib/commands.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing to seed without FIRESTORE_EMULATOR_HOST.');
const app = initializeApp({ projectId: 'demo-sayspec-local' }, `workspace-seed-${Date.now()}`);
const db = getFirestore(app);
const tester = { uid: 'user_tester', email: 'tester@sayspec.local' };
const reviewer = { uid: 'user_reviewer', email: 'reviewer@sayspec.local' };
const outsider = { uid: 'user_outsider', email: 'outsider@sayspec.local' };
const reviewerToken = 'b'.repeat(64);
const testerToken = 'c'.repeat(64);

try {
  await createOrganization(db, tester, { organizationId: 'org_northstar', name: 'Northstar QA (synthetic)' });
  await createInvitation(db, tester, { organizationId: 'org_northstar', invitationId: 'invite_reviewer', email: reviewer.email, role: 'reviewer', tokenHash: reviewerToken, expiresAt: new Date(Date.now() + 3_600_000) });
  await acceptInvitation(db, reviewer, { organizationId: 'org_northstar', invitationId: 'invite_reviewer', tokenHash: reviewerToken });
  await createProject(db, tester, { organizationId: 'org_northstar', projectId: 'project_storefront', name: 'Storefront', targetType: 'web', baseUrl: 'https://storefront.example.test/', access: 'restricted' });
  await setProjectGrant(db, tester, { organizationId: 'org_northstar', projectId: 'project_storefront', uid: reviewer.uid, access: 'reviewer' });
  await createProject(db, tester, { organizationId: 'org_northstar', projectId: 'project_docs', name: 'Documentation portal', targetType: 'web', baseUrl: 'https://docs.example.test/', access: 'all-members' });

  await createOrganization(db, outsider, { organizationId: 'org_rival', name: 'Rival Labs (synthetic)' });
  await createInvitation(db, outsider, { organizationId: 'org_rival', invitationId: 'invite_tester', email: tester.email, role: 'viewer', tokenHash: testerToken, expiresAt: new Date(Date.now() + 3_600_000) });
  await acceptInvitation(db, tester, { organizationId: 'org_rival', invitationId: 'invite_tester', tokenHash: testerToken });
  await createProject(db, outsider, { organizationId: 'org_rival', projectId: 'project_rival', name: 'Rival app', targetType: 'flutter', access: 'all-members' });
  console.log(JSON.stringify({ organizations: 2, northstarProjects: 2, testerScopes: ['org_northstar', 'org_rival'] }));
} finally {
  await deleteApp(app);
}
