import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudTranscriptionManager } from './transcription/cloud-transcription.ts';
import { LocalModelManager } from './transcription/model-manager.ts';
import { RecordingStore } from './recording-store.ts';

const scope = { idToken: 'id-token-fixture', organizationId: 'org_northstar', projectId: 'project_web' };
const functionsUrl = 'https://functions.example.test/region';

/** FFmpeg stand-in: writes a fixed "encoded" file and reports the given peak level to volumedetect. */
async function fixture(peak = '-12.0') {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-cloud-transcription-'));
  const converter = path.join(root, 'ffmpeg');
  await writeFile(converter, `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffmpeg version fixture"; exit 0; fi
for argument in "$@"; do if [ "$argument" = "volumedetect" ]; then echo "max_volume: ${peak} dB" >&2; exit 0; fi; done
last=""
for argument in "$@"; do last="$argument"; done
printf 'OggS-fixture' > "$last"
`);
  await chmod(converter, 0o700);
  // No whisper.cpp runtime and no model: Gemini needs FFmpeg only.
  const models = new LocalModelManager({ rootDirectory: path.join(root, 'models'), runtimeCandidates: [path.join(root, 'missing-whisper-cli')], converterCandidates: [converter], minimumFreeBytes: 0 });
  await models.initialize();
  return { root, models };
}

async function recording(root: string, durationMs = 1_000) {
  let now = 1_000;
  const store = new RecordingStore(path.join(root, 'recordings'), { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
  const prepared = await store.create({ projectId: 'project_web', projectName: 'Gemini', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
  const active = await store.beginSegment(prepared.recording.id);
  await store.appendAudio({ recordingId: prepared.recording.id, segmentId: active.activeSegmentId!, mimeType: 'audio/webm', bytes: new Uint8Array([26, 69, 223, 163]) });
  now += durationMs;
  return { store, review: await store.stop(prepared.recording.id) };
}

function backend(reply: (request: { url: string; init: RequestInit }) => Response) {
  const requests: Array<{ url: string; authorization: string; data: { organizationId: string; projectId: string; mimeType: string; audio: string } }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, authorization: new Headers(init.headers).get('Authorization') ?? '', data: JSON.parse(String(init.body)).data });
    return reply({ url, init });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

test('Gemini transcription needs no Whisper, sends Ogg narration with the person\'s token, and keeps the speech verbatim', async () => {
  const value = await fixture();
  try {
    const { store, review } = await recording(value.root);
    const server = backend(() => Response.json({ result: { model: 'gemini-3.5-flash', language: 'en', durationMs: 1_000, segments: [{ startMs: 0, endMs: 900, text: ' Do not  submit the form. ' }], allowance: { usedMinutes: 1, limitMinutes: 600 } } }));
    const events: unknown[] = [];
    const manager = new CloudTranscriptionManager({ rootDirectory: path.join(value.root, 'work'), store, models: value.models, cloudFunctionsUrl: functionsUrl, fetchImpl: server.fetchImpl, onLifecycle: (event) => events.push(event) });
    await manager.initialize();
    await assert.rejects(manager.start(review.id), /sign in again/i);

    const transcript = await manager.start(review.id, { cloud: scope });
    assert.equal(transcript.status, 'ready');
    assert.deepEqual(transcript.provider, { kind: 'cloud', service: 'gemini', model: 'gemini-3.5-flash', translated: false });
    assert.equal(transcript.language, 'en');
    assert.deepEqual(transcript.segments.map((item) => [item.text, item.startMs, item.endMs, item.timingUncertaintyMs, item.revisions[0].source]), [['Do not submit the form.', 0, 900, 1_000, 'gemini']]);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, `${functionsUrl}/narrationTranscribe`);
    assert.equal(server.requests[0].authorization, 'Bearer id-token-fixture');
    assert.deepEqual({ ...server.requests[0].data, audio: Buffer.from(server.requests[0].data.audio, 'base64').toString() }, { organizationId: 'org_northstar', projectId: 'project_web', mimeType: 'audio/ogg', audio: 'OggS-fixture' });
    assert.deepEqual((await store.get('project_web', review.id)).transcript, transcript);
    assert.match(JSON.stringify(events.at(-1)), /1 of 600 workspace minutes/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('backend refusals keep their message and the original audio; silence and over-long narration are never uploaded', async () => {
  const value = await fixture();
  try {
    const { store, review } = await recording(value.root);
    const refusal = 'This workspace has used 600 of its 600 Gemini transcription minutes this month. Choose local Whisper transcription until the allowance renews.';
    const server = backend(() => Response.json({ error: { status: 'RESOURCE_EXHAUSTED', message: refusal } }, { status: 429 }));
    const manager = new CloudTranscriptionManager({ rootDirectory: path.join(value.root, 'work'), store, models: value.models, cloudFunctionsUrl: functionsUrl, fetchImpl: server.fetchImpl });
    await manager.initialize();
    const failed = await manager.start(review.id, { cloud: scope });
    assert.equal(failed.status, 'failed'); assert.ok(failed.error?.includes(refusal)); assert.match(failed.error ?? '', /original audio is unchanged/i);
    assert.deepEqual((await store.readAsset(review.id, review.manifest.segments[0].audioArtifactId!)).bytes, new Uint8Array([26, 69, 223, 163]));

    const long = await recording(path.join(value.root, 'long'), 26 * 60_000);
    const tooLong = await new CloudTranscriptionManager({ rootDirectory: path.join(value.root, 'work'), store: long.store, models: value.models, cloudFunctionsUrl: functionsUrl, fetchImpl: server.fetchImpl }).start(long.review.id, { cloud: scope });
    assert.equal(tooLong.status, 'failed'); assert.match(tooLong.error ?? '', /longer than 25 minutes/);
    assert.equal(server.requests.length, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }

  const silent = await fixture('-inf');
  try {
    const { store, review } = await recording(silent.root);
    const server = backend(() => { throw new Error('Silent narration must not be uploaded.'); });
    const manager = new CloudTranscriptionManager({ rootDirectory: path.join(silent.root, 'work'), store, models: silent.models, cloudFunctionsUrl: functionsUrl, fetchImpl: server.fetchImpl });
    await manager.initialize();
    const transcript = await manager.start(review.id, { cloud: scope });
    assert.equal(transcript.status, 'ready'); assert.equal(transcript.segments.length, 0); assert.equal(server.requests.length, 0);
    assert.match(transcript.warnings.join(' '), /not uploaded/);
  } finally { await rm(silent.root, { recursive: true, force: true }); }
});

test('Flutter narration from Gemini links speech to host-aligned evidence', async () => {
  const value = await fixture();
  try {
    const audioPath = path.join(value.root, 'narration.webm'); await writeFile(audioPath, 'webm');
    const { store } = await recording(value.root);
    const server = backend(() => Response.json({ result: { model: 'gemini-3.5-flash', language: 'en', durationMs: 8_000, segments: [{ startMs: 4_000, endMs: 6_000, text: 'The counter should increase by one.' }], allowance: { usedMinutes: 1, limitMinutes: 600 } } }));
    const persisted: unknown[] = [];
    const manager = new CloudTranscriptionManager({ rootDirectory: path.join(value.root, 'work'), store, models: value.models, cloudFunctionsUrl: functionsUrl, fetchImpl: server.fetchImpl });
    await manager.initialize();
    const transcript = await manager.startFlutter({ captureId: 'capture_1', audioPath, durationMs: 8_000, timingUncertaintyMs: 1_500, events: [{ id: 'tap_plus', elapsedMs: 4_200 }, { id: 'tap_reset', elapsedMs: 7_500 }], persist: async (item) => { persisted.push(item); } }, { cloud: scope });
    assert.equal(transcript.status, 'ready');
    assert.deepEqual(transcript.segments.map((item) => [item.text, item.evidenceEventIds, item.timingUncertaintyMs]), [['The counter should increase by one.', ['tap_plus'], 1_500]]);
    assert.deepEqual(persisted.at(-1), transcript);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
