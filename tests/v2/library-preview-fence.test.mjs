import assert from 'node:assert/strict'
import test from 'node:test'
const tool = { id: 'ffmpeg', version: 'controlled-unit-fixture', digest: 'c'.repeat(64) }

import { createMediaLibraryPreviewsService } from '../../src/v2/application/create-media-library-previews.ts'

for (const mode of ['abort', 'lease-loss']) for (const stage of ['first-hash', 'second-hash', 'promote', 'persist']) {
  test(`preview ${mode} during ${stage} prevents library publication`, async () => {
    const abort = new AbortController()
    let active = true, hashes = 0, published = 0, promoted = 0, persisted = 0, cleaned = 0
    const lose = () => { if (mode === 'abort') abort.abort(); else active = false }
    const service = createMediaLibraryPreviewsService({
      repository: { async find() { return null }, async publish() { published += 1 } },
      integrity: { async sha256() { hashes += 1; if (stage === (hashes === 1 ? 'first-hash' : 'second-hash')) lose(); return 'a'.repeat(64) } },
      processor: { async generate() { return [{ kind: 'thumbnail', path: '/preview.png', sha256: 'b'.repeat(64), byteSize: 12, width: 16, height: 16, tool }] }, async cleanup() { cleaned += 1 } },
      storage: { async promoteDerived() { promoted += 1; if (stage === 'promote') lose(); return { key: 'previews/preview.png', sha256: 'b'.repeat(64), byteSize: 12 } } },
      artifacts: { async persistOrReplay() { persisted += 1; if (stage === 'persist') lose(); return { artifactId: 'preview-artifact', manifestId: 'preview-manifest' } } },
    })
    await assert.rejects(() => service({ operationId: 'preview-operation', leaseOwner: 'preview-worker', attempt: 1, workspaceId: 'preview-workspace', artifactId: 'source-artifact', artifactKey: 'masters/source.mp4', sourcePath: '/source.mp4', sourceSha256: 'a'.repeat(64), mediaType: 'video', label: 'Source', signal: abort.signal, assertActive: async () => { if (!active) throw new Error('Ingest lease lost') } }), /cancelled|lease lost/i)
    assert.equal(published, 0)
    assert.equal(cleaned, 1)
    if (stage.endsWith('hash')) assert.equal(promoted, 0)
    if (stage !== 'persist') assert.equal(persisted, 0)
  })
}

test('preview publishes exact ingest lease only after every guarded phase remains active', async () => {
  let lease, manifest, checks = 0
  const service = createMediaLibraryPreviewsService({
    repository: { async find() { return null }, async publish(input) { lease = input } }, integrity: { async sha256() { return 'a'.repeat(64) } },
    processor: { async generate() { return [{ kind: 'waveform', path: '/preview.png', sha256: 'b'.repeat(64), width: 16, height: 16, tool }] }, async cleanup() {} },
    storage: { async promoteDerived() { return { key: 'previews/wave.png', sha256: 'b'.repeat(64), byteSize: 12 } } }, artifacts: { async persistOrReplay(input) { manifest = input.manifest; return { artifactId: 'wave-artifact' } } },
  })
  await service({ operationId: 'ingest-operation', leaseOwner: 'ingest-worker', attempt: 2, workspaceId: 'preview-workspace', artifactId: 'source-artifact', artifactKey: 'masters/source.wav', sourcePath: '/source.wav', sourceSha256: 'a'.repeat(64), mediaType: 'audio', label: 'Source', assertActive: async () => { checks += 1 } })
  assert.equal(lease.operationId, 'ingest-operation'); assert.equal(lease.leaseOwner, 'ingest-worker'); assert.equal(lease.attempt, 2)
  assert.deepEqual(manifest.sources[0].execution.tool, tool)
  assert.equal(lease.waveformArtifactId, 'wave-artifact'); assert.ok(checks >= 8)
})
