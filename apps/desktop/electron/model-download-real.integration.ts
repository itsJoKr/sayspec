import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalModelManager } from './transcription/model-manager.ts';
import { DEFAULT_WHISPER_MODEL } from './transcription/model-manifest.ts';

const enabled = process.env.SAYSPEC_REAL_MODEL_DOWNLOAD === '1';

test('downloads the pinned Whisper model into an empty store, cancels cleanly, then verifies a fresh retry', { skip: !enabled, timeout: 10 * 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-real-model-download-'));
  let manager: LocalModelManager;
  let cancellationRequested = false;
  try {
    manager = new LocalModelManager({
      rootDirectory: root,
      minimumFreeBytes: 0,
      onLifecycle(event) {
        if (!cancellationRequested && event.kind === 'model' && event.state === 'downloading' && event.progress > 0) {
          cancellationRequested = true;
          setImmediate(() => void manager.cancelInstall());
        }
      },
    });
    await manager.initialize();
    const discovered = await manager.snapshot();
    assert.equal(discovered.runtime.state, 'ready');
    assert.equal(discovered.runtime.detectedVersion, '1.9.4');
    assert.equal(discovered.model.state, 'not-installed');

    const canceled = await manager.install(DEFAULT_WHISPER_MODEL.id);
    assert.equal(cancellationRequested, true);
    assert.equal(canceled.model.state, 'not-installed');
    await assert.rejects(access(manager.modelPath));
    await assert.rejects(access(`${manager.modelPath}.partial`));

    manager = new LocalModelManager({ rootDirectory: root, minimumFreeBytes: 0 });
    await manager.initialize();
    const installed = await manager.install(DEFAULT_WHISPER_MODEL.id);
    assert.equal(installed.model.state, 'installed');
    assert.equal((await stat(manager.modelPath)).size, DEFAULT_WHISPER_MODEL.byteLength);
    const bytes = await readFile(manager.modelPath);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Buffer.from(digest).toString('hex');
    assert.equal(sha256, DEFAULT_WHISPER_MODEL.sha256);

    const reopened = new LocalModelManager({ rootDirectory: root, minimumFreeBytes: 0 });
    await reopened.initialize();
    const restored = await reopened.snapshot();
    assert.equal(restored.runtime.state, 'ready');
    assert.equal(restored.model.state, 'installed');
    assert.equal(restored.model.downloadedBytes, DEFAULT_WHISPER_MODEL.byteLength);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
