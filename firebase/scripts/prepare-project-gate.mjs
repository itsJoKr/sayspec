import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing to edit scopes without FIRESTORE_EMULATOR_HOST.');
const app = initializeApp({ projectId: 'demo-sayspec-local' }, `project-gate-${Date.now()}`);
const db = getFirestore(app);
try {
  const projects = await db.collection('userScopes/user_tester/organizations/org_northstar/projects').get();
  const batch = db.batch();
  projects.docs.forEach((project) => batch.delete(project.ref));
  await batch.commit();
  console.log(JSON.stringify({ removedProjectScopes: projects.size }));
} finally { await deleteApp(app); }
