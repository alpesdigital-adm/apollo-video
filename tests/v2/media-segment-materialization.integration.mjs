import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { materializeMediaSegmentDerivativeService } from '../../src/v2/application/materialize-media-segment.ts'
import { createMediaSegment } from '../../src/v2/domain/media-segment.ts'
import { FfmpegMediaSegmentExtractor } from '../../src/v2/infrastructure/media/ffmpeg-media-segment-extractor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

test('T-FR-042 materializes exact real MP4 only for a physical consumer and preserves immutable source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-segment-materialization-'))
  const storageRoot = join(root, 'artifacts'); const workRoot = join(root, 'work')
  const sourceKey = 'masters/ws-segment/source.mp4'; const sourcePath = join(storageRoot, ...sourceKey.split('/'))
  await mkdir(join(sourcePath, '..'), { recursive: true })
  await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath])
  const sourceSha256 = await calculateFileSha256(sourcePath); const sourceBytes = (await stat(sourcePath)).size
  const segment = createMediaSegment({ id: 'segment-real', workspaceId: 'ws-segment', parentAssetId: 'artifact-source', parentDurationMs: 6000, label: 'Trecho real', startMs: 1500, endMs: 4250, createdAt: '2026-08-08T14:00:00.000Z' })
  let materialization; let persistedManifest
  const repository = {
    async find(workspaceId, segmentId) { return workspaceId === segment.workspaceId && segmentId === segment.id ? segment : null },
    async readSource() { return { artifactId: 'artifact-source', artifactKey: sourceKey, sha256: sourceSha256, byteSize: sourceBytes, mediaType: 'video', container: 'mp4', durationMs: 6000 } },
    async findMaterialization(_workspaceId, _segmentId, consumerKey) { return materialization?.consumerKey === consumerKey ? { ...materialization, replayed: true } : null },
    async recordMaterialization(input) { materialization = { segmentId: input.segmentId, consumerKey: input.consumerKey, outputArtifactId: input.outputArtifactId, outputManifestId: input.outputManifestId }; return { ...materialization, replayed: false } },
  }
  const service = materializeMediaSegmentDerivativeService({ repository, artifacts: { async persistOrReplay(bundle) { persistedManifest = bundle.manifest; return { artifactId: bundle.artifactId, manifestId: bundle.manifestId, replayed: false } } }, sources: new LocalArtifactSourceMaterializer(storageRoot), storage: new LocalMediaUploadStorage(storageRoot), extractor: new FfmpegMediaSegmentExtractor(workRoot), integrity: { sha256: calculateFileSha256 }, clock: () => new Date('2026-08-08T14:01:00.000Z') })
  try {
    const virtual = await service({ workspaceId: segment.workspaceId, segmentId: segment.id, consumerKey: 'director', requiresPhysicalDerivative: false })
    assert.equal(virtual.physicalDerivative, null)
    assert.equal(materialization, undefined)
    const created = await service({ workspaceId: segment.workspaceId, segmentId: segment.id, consumerKey: 'export', requiresPhysicalDerivative: true })
    const replay = await service({ workspaceId: segment.workspaceId, segmentId: segment.id, consumerKey: 'export', requiresPhysicalDerivative: true })
    assert.equal(replay.replayed, true)
    assert.equal(created.outputArtifactId, replay.outputArtifactId)
    assert.equal(await calculateFileSha256(sourcePath), sourceSha256)
    assert.equal((await stat(sourcePath)).size, sourceBytes)
    assert.equal(persistedManifest.recipe.id, 'extract-range')
    assert.deepEqual(persistedManifest.sources.map((source) => source.sha256), [sourceSha256])
    const outputPath = join(storageRoot, ...persistedManifest.artifact.artifactKey.split('/'))
    const probe = await probeVideo(outputPath, { requireAudio: true })
    assert.ok(Math.abs(probe.duration - 2.75) <= 0.12, `duration ${probe.duration}`)
    assert.equal(probe.width, 320); assert.equal(probe.height, 180); assert.equal(Math.round(probe.fps), 30)
  } finally { await rm(root, { recursive: true, force: true }) }
})
