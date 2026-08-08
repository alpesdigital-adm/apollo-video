import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { runNextMediaIngestOperationService } from '../../src/v2/application/run-media-ingest-worker.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createMediaUpload } from '../../src/v2/domain/media-transfer.ts'
import { LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { inspectUploadedMedia } from '../../src/v2/infrastructure/media/video-probe.ts'
import { SharpImageAnalysisProcessor } from '../../src/v2/infrastructure/media/sharp-image-analysis-processor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const run = promisify(execFile)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function generateFixtures(root) {
  const video = join(root, 'clip.mp4')
  const audio = join(root, 'fala.wav')
  const image = join(root, 'foto.jpg')
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video])
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-c:a', 'pcm_s16le', audio])
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=640x480', '-frames:v', '1', image])
  return { video, audio, image }
}

async function stage(storage, fixture, identity) {
  const bytes = await readFile(fixture)
  const checksum = sha256(bytes)
  const base = createMediaUpload({
    id: identity.id, workspaceId: 'workspace-media-input-1', clientId: 'client-media-input-1',
    projectId: 'project-media-input-1', fileName: identity.fileName, rightsConfirmed: true,
    kind: identity.kind, byteSize: String(bytes.length), mimeType: identity.mimeType,
    expectedSha256: checksum, status: 'uploading', sessionMode: 'single',
    sessionExpiresAt: '2026-08-08T00:30:00.000Z', createdAt: '2026-08-07T23:00:00.000Z',
    expiresAt: '2026-08-08T01:00:00.000Z', inspectionStatus: 'pending',
  })
  await storage.write({ upload: base, mode: 'single', body: new Blob([bytes]).stream(), contentLength: bytes.length })
  return createMediaUpload({
    ...base, status: 'verified', actualSha256: checksum, actualByteSize: String(bytes.length),
    verifiedAt: '2026-08-07T23:10:00.000Z',
  })
}

function createWorkerHarness({ upload: initialUpload, storage, inspection = inspectUploadedMedia, imageProcessor }) {
  let upload = initialUpload
  let claimed = false
  const persisted = []
  const cataloged = []
  const failures = []
  const phases = []
  const imageAnalyses = []
  let cleanupCalls = 0
  let projectFailureCalls = 0
  const authenticationAudit = createApiAccessAuditContext({
    clientId: upload.clientId, credentialId: 'credential-media-input-1',
    workspaceId: upload.workspaceId, environment: 'sandbox', authenticationKind: 'bearer',
  })
  const operation = {
    id: `operation-${upload.id}`, workspaceId: upload.workspaceId, projectId: upload.projectId,
    clientId: upload.clientId, maxAttempts: 1, createdAt: '2026-08-07T23:10:00.000Z',
  }
  const runNext = runNextMediaIngestOperationService({
    operations: {
      async claimNext() {
        if (claimed) return null
        claimed = true
        return {
          operation,
          context: {
            kind: 'media-ingest', uploadId: upload.id, projectId: upload.projectId,
            originalFileName: upload.fileName, sourceArtifactId: `artifact-${upload.id}`,
            sourceManifestId: `manifest-${upload.id}`,
          },
          lease: { attempt: 1 }, authenticationAudit,
        }
      },
      async heartbeat() { return true },
      async advancePhase(input) { phases.push(input.phase); return true },
      async succeed() { return { operation: { ...operation, status: 'succeeded' } } },
      async failOrRetry(input) {
        failures.push(input.error)
        return { operation: { ...operation, status: 'failed' } }
      },
    },
    uploads: {
      async findUpload() { return upload },
      async listUploadParts() { return [] },
      async recordUploadInspection(input) {
        upload = createMediaUpload({
          ...upload, inspectionStatus: input.status, detectedMimeType: input.detectedMimeType,
          detectedExtension: input.detectedExtension, probe: input.probe,
          inspectionError: input.error, inspectedAt: input.inspectedAt,
        })
        return { upload, replayed: false }
      },
    },
    artifacts: {
      async persistOrReplay(input) {
        persisted.push(input)
        return { artifactId: input.artifactId, manifestId: input.manifestId, replayed: false }
      },
    },
    projectMedia: {
      async persistCatalogedInput(input) { cataloged.push(input) },
      async markIngestFailed() { projectFailureCalls += 1 },
      async readProject() { throw new Error('audio/image ingest must not read the video project plan') },
      async persistCompletedIngest() { throw new Error('audio/image ingest must not persist a video ingest') },
    },
    storage,
    inspector: { inspect: inspection },
    prober: { async probe() { throw new Error('audio/image ingest must not invoke the video probe') } },
    processor: {
      async normalize() { throw new Error('audio/image ingest must not normalize video') },
      async cleanup() { cleanupCalls += 1 },
    },
    providers: { resolveTranscription() { throw new Error('audio/image ingest must not transcribe') } },
    rights: {
      async findCurrent() { return { snapshot: { status: 'approved' } } },
      async setCurrent() { throw new Error('approved rights must not be rewritten') },
    },
    ...(imageProcessor ? { imageAnalysis: { processor: imageProcessor, integrity: { sha256: calculateFileSha256 }, repository: { async find() { return null }, async persist(analysis) { imageAnalyses.push(analysis); return { analysis, replayed: false } } } } } : {}),
    clock: () => new Date('2026-08-07T23:15:00.000Z'),
  })
  return {
    runNext, persisted, cataloged, failures, phases, imageAnalyses,
    get cleanupCalls() { return cleanupCalls },
    get projectFailureCalls() { return projectFailureCalls },
    get upload() { return upload },
  }
}

test('F1.011 real MP4, WAV and JPEG stay quarantined until signature and FFprobe approve them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-f1011-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixtures = await generateFixtures(root)
  const storage = new LocalMediaUploadStorage(join(root, 'storage'))
  const cases = [
    { fixture: fixtures.video, id: '123e4567-e89b-42d3-a456-426614175001', fileName: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', codec: 'h264' },
    { fixture: fixtures.audio, id: '123e4567-e89b-42d3-a456-426614175002', fileName: 'fala.wav', kind: 'audio', mimeType: 'audio/wav', codec: 'pcm_s16le' },
    { fixture: fixtures.image, id: '123e4567-e89b-42d3-a456-426614175003', fileName: 'foto.jpg', kind: 'image', mimeType: 'image/jpeg', codec: 'mjpeg' },
  ]
  for (const item of cases) {
    const upload = await stage(storage, item.fixture, item)
    const quarantined = await storage.quarantineSource(upload)
    assert.match(quarantined.path, /\.quarantine$/)
    const decision = await inspectUploadedMedia(quarantined.path, upload)
    assert.equal(decision.status, 'usable')
    assert.equal(decision.media.kind, item.kind)
    assert.equal(decision.probe.codec, item.codec)
    const promoted = await storage.promoteMaster(upload)
    assert.match(promoted.key, /\/masters\/sha256\//)
    assert.equal(promoted.sha256, upload.expectedSha256)
  }
})

test('F1.011 a mismatched extension/MIME is quarantined with an actionable error and never promoted by the journey', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-f1011-mismatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixtures = await generateFixtures(root)
  const storage = new LocalMediaUploadStorage(join(root, 'storage'))
  const upload = await stage(storage, fixtures.video, {
    id: '123e4567-e89b-42d3-a456-426614175004', fileName: 'enganoso.jpg', kind: 'image', mimeType: 'image/jpeg',
  })
  const quarantined = await storage.quarantineSource(upload)
  const decision = await inspectUploadedMedia(quarantined.path, upload)
  assert.equal(decision.status, 'quarantined')
  assert.equal(decision.error.code, 'CORRUPT_OR_MISMATCHED_MEDIA')
  assert.match(decision.error.action, /Reexporte/)
  assert.match(quarantined.path, /\.quarantine$/)
})

test('F1.011 durable worker catalogs real WAV and JPEG without invoking the video pipeline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-f1011-worker-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixtures = await generateFixtures(root)
  const storage = new LocalMediaUploadStorage(join(root, 'storage'))
  const cases = [
    { fixture: fixtures.audio, id: '123e4567-e89b-42d3-a456-426614175011', fileName: 'fala.wav', kind: 'audio', mimeType: 'audio/wav' },
    { fixture: fixtures.image, id: '123e4567-e89b-42d3-a456-426614175012', fileName: 'foto.jpg', kind: 'image', mimeType: 'image/jpeg' },
  ]
  for (const item of cases) {
    const upload = await stage(storage, item.fixture, item)
    const harness = createWorkerHarness({ upload, storage, ...(item.kind === 'image' ? { imageProcessor: new SharpImageAnalysisProcessor(join(root, 'image-work')) } : {}) })
    const result = await harness.runNext(`worker-${item.kind}`)
    assert.deepEqual(result, { operationId: `operation-${upload.id}`, status: 'succeeded' }, JSON.stringify(harness.failures))
    assert.equal(harness.upload.inspectionStatus, 'usable')
    assert.equal(harness.persisted.length, item.kind === 'image' ? 3 : 1)
    assert.equal(harness.persisted[0].manifest.artifact.mediaType, item.kind)
    assert.equal(harness.cataloged.length, 1)
    assert.equal(harness.cataloged[0].mediaType, item.kind)
    assert.equal(harness.imageAnalyses.length, item.kind === 'image' ? 1 : 0)
    if (item.kind === 'image') {
      assert.equal(harness.imageAnalyses[0].dimensions.width, 640)
      assert.equal(harness.imageAnalyses[0].dimensions.height, 480)
      assert.equal(harness.imageAnalyses[0].ocr.state, 'unavailable')
      assert.equal(harness.imageAnalyses[0].derivatives.immutableOriginal, true)
    }
    assert.deepEqual(harness.phases, ['probing', 'verifying', 'persisting'])
    assert.equal(harness.failures.length, 0)
    assert.equal(harness.cleanupCalls, 1)
  }
})

test('F1.011 durable worker exposes actionable quarantine failure and persists no artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-f1011-worker-quarantine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixtures = await generateFixtures(root)
  const storage = new LocalMediaUploadStorage(join(root, 'storage'))
  const upload = await stage(storage, fixtures.video, {
    id: '123e4567-e89b-42d3-a456-426614175013', fileName: 'enganoso.jpg', kind: 'image', mimeType: 'image/jpeg',
  })
  const harness = createWorkerHarness({ upload, storage })
  const result = await harness.runNext('worker-quarantine')
  assert.deepEqual(result, { operationId: `operation-${upload.id}`, status: 'failed' }, JSON.stringify(harness.failures))
  assert.equal(harness.upload.inspectionStatus, 'quarantined')
  assert.equal(harness.persisted.length, 0)
  assert.equal(harness.cataloged.length, 0)
  assert.equal(harness.failures[0].code, 'corrupt_or_mismatched_media')
  assert.match(harness.failures[0].message, /Reexporte/)
  assert.equal(harness.failures[0].retryable, false)
  assert.equal(harness.projectFailureCalls, 0)
})
