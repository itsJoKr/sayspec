import { initializeApp, deleteApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing to seed without FIRESTORE_EMULATOR_HOST.');
const app = initializeApp({ projectId: 'demo-sayspec-local' }, `library-seed-${Date.now()}`);
const db = getFirestore(app);
const root = 'organizations/org_northstar/projects/project_storefront/tests/test_recorded_checkout';
try {
  await db.doc(root).set({ id: 'test_recorded_checkout', organizationId: 'org_northstar', projectId: 'project_storefront', title: 'Checkout with saved address', normalizedTitle: 'checkout with saved address', folder: 'Checkout', tags: ['smoke', 'recorded'], ownerUid: 'user_tester', status: 'published', currentVersionId: 'version_1', versionCount: 1, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await db.doc(`${root}/versions/version_1`).set({ id: 'version_1', organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_recorded_checkout', version: 1, source: 'recording', runtime: { framework: 'playwright', entrypoint: 'tests/checkout.spec.ts' }, contentHash: 'a'.repeat(64), publishedByUid: 'user_tester', publishedAt: FieldValue.serverTimestamp() });
  await db.doc(`${root}/versions/version_1/files/file_main`).set({ id: 'file_main', organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_recorded_checkout', versionId: 'version_1', relativePath: 'tests/checkout.spec.ts', text: "test('checkout with saved address', async ({ page }) => { /* generated from recording */ });", sha256: 'b'.repeat(64), mimeType: 'text/typescript', byteLength: 94, storage: 'firestore' });
  console.log(JSON.stringify({ seededTest: 'test_recorded_checkout' }));
} finally { await deleteApp(app); }
