export type TestAuthor = { ownerUid?: string; authorLabel?: string };
export type CurrentAuthor = { uid: string; displayName: string | null; email: string | null };

export function testAuthorLabel(test: TestAuthor, currentUser: CurrentAuthor) {
  if (test.authorLabel?.trim()) return test.authorLabel.trim();
  if (test.ownerUid === currentUser.uid) return currentUser.displayName?.trim() || currentUser.email?.trim() || 'You';
  return test.ownerUid || 'Unknown author';
}
