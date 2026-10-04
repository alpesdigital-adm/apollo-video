import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createMediaSegmentService } from '../../src/v2/application/media-segments.ts'
import { requestMediaSegmentDerivativeService, readMediaSegmentDerivativeJobService, cancelMediaSegmentDerivativeJobService, retryMediaSegmentDerivativeJobService } from '../../src/v2/application/request-media-segment-derivative.ts'
import { runNextMediaSegmentDerivativeJobService } from '../../src/v2/application/run-media-segment-derivative-worker.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { PrismaMediaArtifactRepository } from '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
import { PrismaMediaSegmentRepository } from '../../src/v2/infrastructure/prisma/media-segment-repository.ts'
import { PrismaMediaLibraryRepository } from '../../src/v2/infrastructure/prisma/media-library-repository.ts'
import { PrismaMediaSegmentDerivativeJobRepository } from '../../src/v2/infrastructure/prisma/media-segment-derivative-job-repository.ts'

import { materializeMediaSegmentDerivativeService } from '../../src/v2/application/materialize-media-segment.ts'
import { createMediaSegment } from '../../src/v2/domain/media-segment.ts'
import { FfmpegMediaSegmentExtractor } from '../../src/v2/infrastructure/media/ffmpeg-media-segment-extractor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

test('W47 durable PostgreSQL jobs extract real MP4, replay, cancel, retry and block revoked rights', { skip: !process.env.V2_DATABASE_URL }, async () => {
  const prisma = new PrismaClient()
  const root = await mkdtemp(join(tmpdir(), 'apollo-segment-jobs-'))
  const workspaceId = `jobs-${randomUUID().slice(0, 8)}`
  const sourceKey = `${workspaceId}/source.mp4`
  const storageRoot = join(root, 'artifacts'), sourcePath = join(storageRoot, ...sourceKey.split('/'))
  const segments = new PrismaMediaSegmentRepository(prisma), library = new PrismaMediaLibraryRepository(prisma), jobs = new PrismaMediaSegmentDerivativeJobRepository(prisma)
  const artifacts = new PrismaMediaArtifactRepository(prisma)
  const activeRuns = [], releases = []
  const actor = { clientId: 'jobs-client', credentialId: 'jobs-credential', workspaceId, environment: 'production', authenticationKind: 'bearer', scopes: new Set(['artifacts:write']), auditContext: createExternalAuditContext({ clientId: 'jobs-client', credentialId: 'jobs-credential', workspaceId, environment: 'production' }) }
  try {
    await mkdir(join(sourcePath, '..'), { recursive: true })
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath])
    const sha = await calculateFileSha256(sourcePath), bytes = (await stat(sourcePath)).size, sourceProbe = await probeVideo(sourcePath, { requireAudio: true })
    await prisma.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Durable derivatives' } })
    const artifactId = `${workspaceId}-source`
    const manifest = createMediaArtifactManifestV2({ artifactKey: sourceKey, artifactSha256: sha, byteSize: bytes, mediaType: 'video', container: 'mp4', recipe: { id: 'upload', version: '1.0.0', parameters: {} }, sources: [], probe: { width: sourceProbe.width, height: sourceProbe.height, duration: sourceProbe.duration, fps: sourceProbe.fps } })
    await artifacts.persistOrReplay({ workspaceId, artifactId, manifestId: `${workspaceId}-manifest`, lineageIds: [], manifest, createdAt: new Date().toISOString() })
    const rights = createAssetRightsSnapshot({ id: `${workspaceId}-rights`, workspaceId, artifactId, sequence: 1, draft: { status: 'approved', allowedUses: ['editorial-reuse'], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] } }, createdBy: { type: 'user', id: 'test-owner' }, createdAt: new Date().toISOString() })
    await prisma.v2AssetRightsSnapshot.create({ data: { id: rights.id, workspaceId, artifactId, sequence: 1, schemaVersion: rights.schemaVersion, snapshotHash: rights.snapshotHash, status: rights.status, allowedUsesJson: stableSerialize(rights.allowedUses), prohibitedUsesJson: '[]', allowedWorkspaceIdsJson: stableSerialize(rights.allowedWorkspaceIds), consentStatus: rights.consent.status, consentAllowedUsesJson: '[]', createdByType: 'user', createdById: 'test-owner', createdAt: new Date(rights.createdAt) } })
    await prisma.v2MediaArtifact.update({ where: { id: artifactId }, data: { currentRightsSnapshotId: rights.id, rightsRevision: 1 } })
    await prisma.v2MediaLibraryEntry.create({ data: { artifactId, workspaceId, label: 'Measured source', originType: 'upload' } })
    const { segment } = await createMediaSegmentService({ repository: segments })({ workspaceId, artifactId, label: 'Measured range', startMs: 1500, endMs: 4250 })
    const audioPath = join(root, 'source.wav')
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', audioPath])
    const audioSha = await calculateFileSha256(audioPath), audioBytes = (await stat(audioPath)).size
    const { probeAudioDurationSeconds } = await import('../../src/v2/infrastructure/media/video-probe.ts')
    const audioProbe = { duration: await probeAudioDurationSeconds(audioPath) }
    const audioId = `${workspaceId}-audio`, projectId = `${workspaceId}-project`, clientId = `${workspaceId}-client`, uploadId = randomUUID()
    await prisma.v2ApiClient.create({ data: { id: clientId, workspaceId, name: 'Measured upload', allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '[]', createdBy: 'test-owner' } })
    await prisma.v2Project.create({ data: { id: projectId, workspaceId, name: 'Measured upload', locale: 'pt-BR', createdByType: 'user', createdById: 'test-owner' } })
    const audioManifest = createMediaArtifactManifestV2({ artifactKey: `${workspaceId}/source.wav`, artifactSha256: audioSha, byteSize: audioBytes, mediaType: 'audio', container: 'wav', recipe: { id: 'upload', version: '1.0.0', parameters: {} }, sources: [] })
    await artifacts.persistOrReplay({ workspaceId, artifactId: audioId, manifestId: `${audioId}-manifest`, lineageIds: [], manifest: audioManifest, createdAt: new Date().toISOString() })
    await assert.rejects(() => segments.readSource(workspaceId, audioId), /measured duration/i)
    await prisma.v2MediaUpload.create({ data: { id: uploadId, workspaceId, clientId, projectId, kind: 'audio', byteSize: BigInt(audioBytes), mimeType: 'audio/wav', expectedSha256: audioSha, actualSha256: audioSha, status: 'verified', inspectionStatus: 'usable', detectedMimeType: 'audio/wav', detectedExtension: 'wav', inspectedAt: new Date(), actualByteSize: BigInt(audioBytes), verifiedAt: new Date(), probeJson: JSON.stringify(audioProbe), idempotencyKey: `${audioId}-upload`, requestFingerprint: audioSha, expiresAt: new Date(Date.now() + 60000) } })
    await prisma.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId: audioId, uploadId, role: 'source-audio', originalFileName: 'source.wav' } })
    const audioSource = await segments.readSource(workspaceId, audioId)
    assert.equal(audioSource.durationMs, Math.round(audioProbe.duration * 1000))
    assert.ok(audioSource.durationMs >= 2900 && audioSource.durationMs <= 3100)
    const request = requestMediaSegmentDerivativeService({ segments, library, jobs })
    const readJob = readMediaSegmentDerivativeJobService({ jobs }), cancelJob = cancelMediaSegmentDerivativeJobService({ jobs }), retryJob = retryMediaSegmentDerivativeJobService({ jobs })
    const reader = { ...actor, scopes: new Set(['artifacts:read']) }
    const input = { workspaceId, segmentId: segment.id, consumerKey: 'export', requiresPhysicalDerivative: true, idempotencyKey: `${workspaceId}-export`, actor }
    assert.equal((await request({ ...input, requiresPhysicalDerivative: false })).kind, 'virtual')
    assert.equal(await prisma.v2MediaSegmentDerivativeJob.count({ where: { workspaceId } }), 0)
    const queued = await request(input), replay = await request(input)
    assert.equal(queued.job.status, 'queued'); assert.equal(replay.job.id, queued.job.id); assert.equal(replay.replayed, true)
    const materialize = materializeMediaSegmentDerivativeService({ repository: segments, artifacts, sources: new LocalArtifactSourceMaterializer(storageRoot), storage: new LocalMediaUploadStorage(storageRoot), extractor: new FfmpegMediaSegmentExtractor(join(root, 'work')), integrity: { sha256: calculateFileSha256 } })
    const run = runNextMediaSegmentDerivativeJobService({ jobs, segments, library, materialize })
    const result = await run('test-worker')
    assert.equal(result.status, 'succeeded', JSON.stringify(result))
    assert.equal((await jobs.read(workspaceId, queued.job.id)).status, 'succeeded')
    assert.equal((await readJob({ jobId: queued.job.id, actor: reader })).status, 'succeeded')
    await assert.rejects(() => readJob({ jobId: queued.job.id, actor }), /scope/i)
    await assert.rejects(() => cancelJob({ jobId: '/', actor }), /identity/i)
    const output = await prisma.v2MediaArtifact.findUnique({ where: { id: result.outputArtifactId } })
    const probe = await probeVideo(join(storageRoot, ...output.artifactKey.split('/')), { requireAudio: true })
    assert.ok(Math.abs(probe.duration - 2.75) <= 0.12)
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', join(storageRoot, ...output.artifactKey.split('/')), '-f', 'null', '-'])
    assert.equal(await calculateFileSha256(sourcePath), sha)
    assert.equal((await request(input)).kind, 'ready')
    const canceled = await request({ ...input, consumerKey: 'cancel', idempotencyKey: `${workspaceId}-cancel` })
    assert.equal((await cancelJob({ jobId: canceled.job.id, actor })).status, 'canceled')
    assert.equal(await run('test-worker'), null)
    const retry = await request({ ...input, consumerKey: 'retry', idempotencyKey: `${workspaceId}-retry` })
    const claimed = await jobs.claim('retry-worker', new Date(), new Date(Date.now() + 15000))
    assert.equal(claimed.id, retry.job.id)
    await jobs.failOrRetry(claimed.id, 'retry-worker', claimed.attempt, 'RENDER_EXECUTION_FAILED', false, new Date())
    assert.equal((await retryJob({ jobId: claimed.id, actor })).status, 'retrying')
    const retriedResult = await run('test-worker')
    assert.equal(retriedResult.status, 'succeeded', JSON.stringify(retriedResult))
    assert.equal(retriedResult.outputArtifactId, result.outputArtifactId)
    // Hold a real completed FFmpeg extraction before publication, then exercise
    // cancellation/deadline/reclaim while the durable worker is still active.
    let promotions = 0
    const countedStorage = new LocalMediaUploadStorage(storageRoot)
    const originalPromote = countedStorage.promoteDerived.bind(countedStorage)
    countedStorage.promoteDerived = async (value) => { promotions += 1; return originalPromote(value) }
    async function heldWorker(consumerKey) {
      let extractedResolve, releaseResolve
      const extracted = new Promise((resolve) => { extractedResolve = resolve })
      const release = new Promise((resolve) => { releaseResolve = resolve })
      releases.push(() => releaseResolve())
      const actual = new FfmpegMediaSegmentExtractor(join(root, 'held-work'))
      const heldMaterialize = materializeMediaSegmentDerivativeService({ repository: segments, artifacts, sources: new LocalArtifactSourceMaterializer(storageRoot), storage: countedStorage, extractor: {
        async extract(value) {
          const result = await actual.extract(value)
          extractedResolve(value.operationId)
          await Promise.race([release, new Promise((resolve) => { if (value.signal.aborted) resolve(); else value.signal.addEventListener('abort', resolve, { once: true }) })])
          return result
        }, cleanup: (id) => actual.cleanup(id),
      }, integrity: { sha256: calculateFileSha256 } })
      const queued = await request({ ...input, consumerKey, idempotencyKey: `${workspaceId}-${consumerKey}` })
      const worker = runNextMediaSegmentDerivativeJobService({ jobs, segments, library, materialize: heldMaterialize, heartbeatIntervalMs: 100, leaseDurationMs: 5000 })
      return { queued, extracted, release: releaseResolve, worker: (owner) => { const task = worker(owner); activeRuns.push(task); return task } }
    }
    const activeCancel = await heldWorker('active-cancel')
    const activeCancelRun = activeCancel.worker('cancel-worker')
    await activeCancel.extracted
    assert.equal((await jobs.cancel(workspaceId, activeCancel.queued.job.id, actor.auditContext.contextHash, new Date())).status, 'canceled')
    assert.equal((await activeCancelRun).status, 'stopped')
    assert.equal(promotions, 0)
    await assert.rejects(() => jobs.publish(activeCancel.queued.job.id, 'cancel-worker', 1, async () => { promotions += 1; throw new Error('Canceled lease published') }), /current unexpired lease/i)
    assert.equal(promotions, 0)
    const processEvents = [], processAbort = new AbortController()
    const processExtractor = new FfmpegMediaSegmentExtractor(join(root, 'process-work'), (event) => { processEvents.push(event); if (event.state === 'started') processAbort.abort() })
    await assert.rejects(() => processExtractor.extract({ operationId: 'owned-cancel', sourcePath, startMs: 0, endMs: 6000, signal: processAbort.signal }), /cancelled/i)
    assert.deepEqual(processEvents.map((event) => event.state), ['started', 'exited'])
    assert.equal(processEvents[0].pid, processEvents[1].pid)
    assert.ok(processEvents[0].pid > 0)
    await processExtractor.cleanup('owned-cancel')
    assert.equal(await stat(join(root, 'process-work', 'owned-cancel')).catch(() => null), null)
    assert.equal(await segments.findMaterialization(workspaceId, segment.id, 'active-cancel'), null)
    const timed = await heldWorker('deadline')
    await prisma.v2MediaSegmentDerivativeJob.update({ where: { id: timed.queued.job.id }, data: { deadlineAt: new Date(Date.now() + 3000) } })
    const timedRun = timed.worker('deadline-worker')
    await Promise.race([timed.extracted, timedRun])
    assert.equal((await timedRun).status, 'stopped')
    assert.equal((await jobs.read(workspaceId, timed.queued.job.id)).errorCode, 'RENDER_DEADLINE_EXCEEDED')
    assert.equal(promotions, 0)
    const revokedDuring = await heldWorker('revoked-during')
    const revokedDuringRun = revokedDuring.worker('rights-worker')
    await revokedDuring.extracted
    await prisma.v2MediaArtifact.update({ where: { id: artifactId }, data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
    revokedDuring.release()
    assert.equal((await revokedDuringRun).errorCode, 'ASSET_RIGHTS_BLOCKED')
    assert.equal(await segments.findMaterialization(workspaceId, segment.id, 'revoked-during'), null)
    assert.equal(promotions, 0)
    await prisma.v2MediaArtifact.update({ where: { id: artifactId }, data: { currentRightsSnapshotId: rights.id, rightsRevision: 3 } })
    assert.equal(await segments.findMaterialization(workspaceId, segment.id, 'deadline'), null)
    const reclaimed = await heldWorker('reclaimed')
    const oldRun = reclaimed.worker('old-worker')
    const oldOperationId = await reclaimed.extracted
    await prisma.v2MediaSegmentDerivativeJob.update({ where: { id: reclaimed.queued.job.id }, data: { leaseExpiresAt: new Date(0) } })
    const replacements = await Promise.all([jobs.claim('new-worker', new Date(), new Date(Date.now() + 15000)), jobs.claim('other-worker', new Date(), new Date(Date.now() + 15000))])
    assert.equal(replacements.filter(Boolean).length, 1)
    const replacement = replacements.find(Boolean)
    const replacementOwner = replacements[0] ? 'new-worker' : 'other-worker'
    const outputReplacement = await materialize({ workspaceId, segmentId: segment.id, consumerKey: 'reclaimed', requiresPhysicalDerivative: true, publish: (prepare) => jobs.publish(replacement.id, replacementOwner, replacement.attempt, prepare) })
    assert.equal(outputReplacement.outputArtifactId, result.outputArtifactId)
    reclaimed.release()
    assert.equal((await oldRun).status, 'stopped')
    assert.equal((await jobs.read(workspaceId, replacement.id)).status, 'succeeded')
    assert.equal((await stat(join(root, 'held-work', oldOperationId)).catch(() => null)), null)
    assert.equal(promotions, 0)
    const blocked = await request({ ...input, consumerKey: 'blocked', idempotencyKey: `${workspaceId}-blocked` })
    await prisma.v2MediaArtifact.update({ where: { id: artifactId }, data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
    assert.equal((await run('test-worker')).errorCode, 'ASSET_RIGHTS_BLOCKED')
    assert.equal((await jobs.read(workspaceId, blocked.job.id)).status, 'failed')
    assert.equal(await segments.findMaterialization(workspaceId, segment.id, 'blocked'), null)
    await assert.rejects(() => request({ ...input, consumerKey: 'revoked', idempotencyKey: `${workspaceId}-revoked` }), /eligible|rights/i)
    assert.equal(await jobs.read('other-workspace', queued.job.id), null)
  } finally {
    for (const release of releases) release()
    await Promise.allSettled(activeRuns)
    await prisma.v2MediaSegmentMaterialization.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaSegmentDerivativeJob.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaSegment.deleteMany({ where: { workspaceId } })
    await prisma.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaUpload.deleteMany({ where: { workspaceId } })
    await prisma.v2Project.deleteMany({ where: { workspaceId } })
    await prisma.v2ApiClient.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaLibraryEntry.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaArtifact.updateMany({ where: { workspaceId }, data: { currentRightsSnapshotId: null } })
    await prisma.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaArtifactLineage.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
    await prisma.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-042 materializes exact real MP4 only for a physical consumer and preserves immutable source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-segment-materialization-'))
  const storageRoot = join(root, 'artifacts'); const workRoot = join(root, 'work')
  const sourceKey = 'masters/ws-segment/source.mp4'; const sourcePath = join(storageRoot, ...sourceKey.split('/'))
  await mkdir(join(sourcePath, '..'), { recursive: true })
  await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath])
  const sourceSha256 = await calculateFileSha256(sourcePath); const sourceBytes = (await stat(sourcePath)).size
  const failedProcessEvents = []
  const failedExtractor = new FfmpegMediaSegmentExtractor(workRoot, (event) => failedProcessEvents.push(event))
  await assert.rejects(() => failedExtractor.extract({ operationId: 'ffmpeg-error', sourcePath: join(root, 'missing-source.mp4'), startMs: 0, endMs: 1000 }), /extraction failed/i)
  assert.deepEqual(failedProcessEvents.map((event) => event.state), ['started', 'exited'])
  assert.equal(failedProcessEvents[0].pid, failedProcessEvents[1].pid)
  await failedExtractor.cleanup('ffmpeg-error')
  assert.equal(await stat(join(workRoot, 'ffmpeg-error')).catch(() => null), null)
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
