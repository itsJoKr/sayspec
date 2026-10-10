import { useEffect, useState } from 'react';
import type { SavedWebTestVersion } from '@sayspec/contracts';
import { useRequiredCloud } from './cloud/context';
import { Button, Field } from './ui';

type VersionChoice = { id: string; hash: string; label: string; local: boolean };

export function ReviewPanel({ organizationId, projectId, testId, title, reviewerUid, reviewerRevision, canManage, onClose }: { organizationId: string; projectId: string; testId: string; title: string; reviewerUid?: string | null; reviewerRevision: number; canManage: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionChoice[]>([]); const [versionId, setVersionId] = useState('');
  const [body, setBody] = useState(''); const [comments, setComments] = useState<Array<{ id: string; body: string; authorUid: string }>>([]);
  const [members, setMembers] = useState<Array<{ uid: string; role: string }>>([]); const [reviewer, setReviewer] = useState(reviewerUid ?? '');
  const [activity, setActivity] = useState<Array<{ id: string; kind: string; actorUid: string }>>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const cloud = useRequiredCloud();
  const scope = { organizationId, projectId };
  useEffect(() => {
    let active = true;
    void window.sayspec!.listProjectWebTestVersions({ organizationId, projectId }).then((items) => {
      if (!active) return;
      const local = items.filter((item: SavedWebTestVersion) => item.testId === testId).map((item) => ({ id: item.id, hash: item.contentHash, label: `Saved version ${item.version} · ${item.contentHash.slice(0, 12)}… (client-reported)`, local: true }));
      setVersions((old) => [...local, ...old.filter((item) => !item.local)]);
    }).catch((reason) => { if (active) setError(String(reason)); });
    const stop = cloud.reviews.subscribeVersions({ ...scope, testId }, (published) => {
      setVersions((old) => [...old.filter((item) => item.local), ...published.map((item) => ({ id: item.id, hash: item.contentHash, label: `Published version ${item.version} · ${item.contentHash.slice(0, 12)}…`, local: false }))]);
    }, () => setError('Version access changed. Reopen the project after checking your grant.'));
    return () => { active = false; stop(); };
  }, [cloud, organizationId, projectId, testId]);
  useEffect(() => { setVersionId((value) => versions.some((item) => item.id === value) ? value : versions[0]?.id ?? ''); }, [versions]);
  const selected = versions.find((item) => item.id === versionId);
  useEffect(() => {
    setComments([]); if (!selected) return;
    return cloud.reviews.subscribeComments({ ...scope, testId, versionId: selected.id, local: selected.local }, setComments, () => setError('Comments unavailable; access may have changed.'));
  }, [cloud, organizationId, projectId, testId, selected?.id, selected?.local]);
  useEffect(() => cloud.reviews.subscribeReviewers(organizationId, setMembers), [cloud, organizationId]);
  useEffect(() => cloud.reviews.subscribeActivity({ organizationId, projectId }, setActivity), [cloud, organizationId, projectId]);
  async function submitComment() {
    if (!selected || !body.trim()) return;
    setBusy(true); setError('');
    try { await cloud.reviews.comment({ organizationId, projectId, testId, versionId: selected.id, versionHash: selected.hash, commentId: `comment_${crypto.randomUUID()}`, body }); setBody(''); }
    catch (reason) { setError(`Comment was not saved. Check access and version: ${String(reason)}`); }
    finally { setBusy(false); }
  }
  async function submitAssignment() {
    setBusy(true); setError('');
    try { await cloud.reviews.assignReviewer({ organizationId, projectId, testId, reviewerUid: reviewer || null, expectedRevision: reviewerRevision }); }
    catch (reason) { setError(`Assignment was not saved. Reload if it changed: ${String(reason)}`); }
    finally { setBusy(false); }
  }
  return <section className="review-panel" aria-label={`Review ${title}`}><div className="review-panel-heading"><h2>Review {title}</h2><Button onClick={onClose}>Close</Button></div>
    <label>Version context<select value={versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.map((item) => <option key={`${item.local}:${item.id}`} value={item.id}>{item.label}</option>)}</select></label>
    {!versions.length ? <p>No saved version in this project is available for comment yet.</p> : <><div className="review-comments">{comments.map((item) => <p key={item.id}><strong>{item.authorUid}</strong>: {item.body}</p>)}{!comments.length && <p>No comments on this version.</p>}</div><Field label="Comment on this version" value={body} onChange={(event) => setBody(event.target.value.slice(0, 4000))} /><Button disabled={!body.trim() || busy} onClick={() => void submitComment()}>Add comment</Button></>}
    <div className="review-assignment"><label>Reviewer<select value={reviewer} onChange={(event) => setReviewer(event.target.value)} disabled={!canManage}><option value="">Unassigned</option>{members.map((item) => <option key={item.uid} value={item.uid}>{item.uid} · {item.role}</option>)}</select></label>{canManage && <Button onClick={() => void submitAssignment()} disabled={busy}>Assign reviewer</Button>}</div>
    <details><summary>Recent activity</summary>{activity.map((item) => <p key={item.id}>{item.kind} · {item.actorUid}</p>)}</details>{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}
