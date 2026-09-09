import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { assertIsolatedDatabase, colorMetadataFromStream, encodeRecording, probeStreams, sha256Of, sweepSamples, writePcm } from './helpers/capture-journey.mjs'
import { createLocalizationPgFixture } from './helpers/localization-pg.mjs'

const { resolveFfmpegBinary, resolveFfprobeBinaryPath } = await import('../../src/v2/infrastructure/media/ffmpeg-binary.ts')
const { createLocalizationMediaRun } = await import('../../src/v2/domain/localization-media-run.ts')
const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
const { createColorPipelineCompilationService } = await import('../../src/v2/application/color-pipeline-compilations.ts')
const { PrismaColorPipelineCompilationRepository } = await import('../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts')
const { PrismaLocalizationMediaRunRepository } = await import('../../src/v2/infrastructure/prisma/localization-media-run-repository.ts')
const { createLocalizationMediaRuntime } = await import('../../src/v2/infrastructure/repository-factory.ts')
const { authenticateApiClientService } = await import('../../src/v2/application/authenticate-api-client.ts')
const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

const enabled = process.env.APOLLO_RUN_LOCALIZATION_MEDIA_PROXY_PG_E2E === '1'
const execFileAsync = promisify(execFile)
async function decodedRgb(ffmpegPath, path, at) {
  const { stdout } = await execFileAsync(ffmpegPath, ['-v', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', '-vf', 'scale=960:540', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 960 * 540 * 4 })
  return stdout
}
function whiteInkInSubtitleBand(rgb) {
  let count = 0
  for (let pixel = 960 * Math.floor(540 * .55); pixel < 960 * 540; pixel += 1) {
    const offset = pixel * 3
    if (rgb[offset] > 225 && rgb[offset + 1] > 225 && rgb[offset + 2] > 225) count += 1
  }
  return count
}
async function decodedPcm(ffmpegPath, path) {
  const { stdout } = await execFileAsync(ffmpegPath, ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 })
  return new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2))
}
async function probeOutputVideo(ffprobePath, path) {
  const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate', '-of', 'json', path], { encoding: 'utf8' })
  return JSON.parse(stdout).streams?.[0]
}
function correlation(left, right) {
  const length = Math.min(left.length, right.length); let dot = 0, leftPower = 0, rightPower = 0
  for (let index = 0; index < length; index += 1) { dot += left[index] * right[index]; leftPower += left[index] ** 2; rightPower += right[index] ** 2 }
  return dot / Math.sqrt(leftPower * rightPower)
}
const implementation = (provider, parameters) => ({ provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters) })
const identityStages = (metadata) => [
  { id: 'technical-source', kind: 'technical', version: 'v1', enabled: true, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
  { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, output: metadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
  { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, output: metadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
  { id: 'output-source', kind: 'output', version: 'v1', enabled: true, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
]

test('localization subtitles-only persists a snapshot-bound proxy through PostgreSQL and real FFmpeg', { skip: !enabled, timeout: 120_000 }, async () => {
  assertIsolatedDatabase()
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const work = join(tmpdir(), `apollo-localization-proxy-${randomUUID()}`)
  const artifactRoot = join(work, 'artifacts'), artifactKey = 'fixtures/localization-source.mp4'
  const sourcePath = join(artifactRoot, artifactKey)
  let fixture, runtime, failure
  try {
    const ffmpegPath = resolveFfmpegBinary(), ffprobePath = resolveFfprobeBinaryPath()
    const pcmPath = join(work, 'source-audio.pcm')
    await writePcm(pcmPath, sweepSamples({ seconds: 4 }))
    const encoded = await encodeRecording({ ffmpegPath, outputPath: sourcePath, seconds: 4, fps: 25, videoInput: 'testsrc2=duration=4:size=320x180:rate=25', pcmPath })
    const streams = await probeStreams(ffprobePath, sourcePath), stream = streams.find((item) => item.codec_type === 'video')
    assert.ok(stream)
    assert.ok(streams.some((item) => item.codec_type === 'audio'), 'original-audio localization source must have a measured audio stream')
    const producerBinaryDigest = createHash('sha256').update(await readFile(ffprobePath)).digest('hex')
    const sourceMedia = { artifactKey, sha256: encoded.sha256, byteSize: encoded.byteSize,
      probe: { width: Number(stream.width), height: Number(stream.height), duration: Number(stream.duration), fps: 25 },
      colorMetadata: colorMetadataFromStream(stream), pixelFormat: stream.pix_fmt,
      producerVersion: 'fixture-ffprobe', producerBinaryDigest, originalFileName: 'localization-source.mp4' }
    fixture = await createLocalizationPgFixture(prisma, { stage: 'audio', sourceMedia, explicitNoLut: true })
    const colorRepository = new PrismaColorPipelineCompilationRepository(prisma)
    const probe = await colorRepository.loadTrustedProbe({ workspaceId: fixture.workspaceId, projectId: fixture.projectId, sourceArtifactId: fixture.artifactId, sourceManifestId: `manifest-${fixture.artifactId}` })
    assert.equal(probe?.detection.state, 'ready')
    const actor = await authenticateApiClientService({ repository: new PrismaApiClientRepository(prisma), credentialCrypto: nodeApiCredentialCrypto, clock: () => fixture.now, environment: 'production' })(`Bearer ${fixture.issued.token}`)
    await createColorPipelineCompilationService({ repository: colorRepository, clock: () => fixture.now, createId: () => `color-${fixture.suffix}` })({
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sourceArtifactId: fixture.artifactId,
      sourceManifestId: `manifest-${fixture.artifactId}`, outputMetadata: probe.detection.metadata,
      stages: identityStages(probe.detection.metadata), actor,
      idempotencyKey: `color-${fixture.suffix}`,
    })
    const run = createLocalizationMediaRun({ id: `media-${fixture.suffix}`, workspaceId: fixture.workspaceId,
      projectId: fixture.projectId, variantId: fixture.variant.id, variantRevision: fixture.variant.revision,
      variantHash: fixture.variant.variantHash, canonicalContentHash: fixture.variant.canonicalContentHash,
      source: { kind: 'original-audio', artifactId: fixture.artifactId, artifactSha256: encoded.sha256, rightsSnapshotId: fixture.rights.snapshot.id },
      requestedByClientId: fixture.clientId, at: fixture.now.toISOString() })
    await new PrismaLocalizationMediaRunRepository(prisma).create({ run, requestFingerprint: 'b'.repeat(64), idempotencyKey: `media-${fixture.suffix}`, authenticationAudit: fixture.audit })
    runtime = createLocalizationMediaRuntime({
      ...process.env,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'localization-e2e',
      APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url'),
    })
    const outcome = await runtime.runNext(`localization-proxy-${fixture.suffix}`)
    assert.equal(outcome.status, 'awaiting-human-approval')
    assert.equal(outcome.evidence.renderablePlans.length, 1)
    const proof = outcome.evidence.renderablePlans[0]
    const operation = await prisma.v2ProjectProxyRenderOperation.findUniqueOrThrow({ where: { operationId: proof.proxyOperationId }, include: { operation: true } })
    assert.equal(operation.operation.status, 'succeeded')
    assert.equal(operation.renderablePlanHash, proof.planHash)
    assert.equal(operation.renderableSourceId, run.id)
    assert.equal(operation.renderableVariantId, run.variantId)
    assert.notEqual(proof.proxyArtifactId, fixture.artifactId)
    const output = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: proof.proxyArtifactId }, include: { manifests: true } })
    const outputManifest = output.manifests.find((item) => item.id === operation.outputManifestId)
    assert.ok(outputManifest)
    const outputKey = JSON.parse(outputManifest.manifestJson).artifact.artifactKey
    const outputPath = join(artifactRoot, ...outputKey.split('/'))
    const outputBytes = await readFile(outputPath)
    assert.equal(sha256Of(outputBytes), output.sha256)
    assert.equal(output.sha256, JSON.parse(outputManifest.manifestJson).artifact.sha256)
    const outputStreams = await probeStreams(ffprobePath, outputPath)
    const outputVideo = outputStreams.find((item) => item.codec_type === 'video')
    const outputAudio = outputStreams.find((item) => item.codec_type === 'audio')
    const exactOutputVideo = await probeOutputVideo(ffprobePath, outputPath)
    assert.ok(outputVideo && outputAudio, 'localized proxy must decode both video and audio')
    assert.equal(outputAudio.codec_name, 'aac')
    assert.ok(Math.abs(Number(outputAudio.duration) - 4) <= .1, 'localized AAC duration must remain within 100ms of the 4s source')
    assert.equal(Number(exactOutputVideo.width), 960)
    assert.equal(Number(exactOutputVideo.height), 540)
    assert.equal(Number(exactOutputVideo.nb_read_frames), 100)
    assert.equal(exactOutputVideo.avg_frame_rate, '25/1')
    const [sourceFrame, localizedFrame, sourcePcm, localizedPcm] = await Promise.all([
      decodedRgb(ffmpegPath, sourcePath, 1), decodedRgb(ffmpegPath, outputPath, 1), decodedPcm(ffmpegPath, sourcePath), decodedPcm(ffmpegPath, outputPath),
    ])
    assert.ok(whiteInkInSubtitleBand(localizedFrame) > whiteInkInSubtitleBand(sourceFrame) + 50, 'localized cue must add visible white subtitle ink inside the lower subtitle band')
    assert.ok(correlation(sourcePcm, localizedPcm) > .97, 'subtitles-only proxy must preserve the decoded original-audio waveform')
    const snapshotRow = await prisma.v2RenderablePlanSnapshot.findFirstOrThrow({ where: {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId,
      planId: proof.snapshotId, planHash: proof.planHash,
    } })
    const baseVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: fixture.versionId }, include: { editPlanSnapshot: true } })
    const snapshotPlan = JSON.parse(snapshotRow.planJson), basePlan = JSON.parse(baseVersion.editPlanSnapshot.contentJson)
    assert.deepEqual(snapshotPlan.videoTracks, basePlan.videoTracks, 'localization snapshot must leave the base video clips unchanged')
    const evidenceRoot = process.env.APOLLO_WAVE21_EVIDENCE_DIR?.trim()
    if (evidenceRoot) {
      const evidenceDir = resolve(evidenceRoot, `localization-proxy-${fixture.suffix}`)
      await mkdir(evidenceDir, { recursive: true })
      const evidenceMp4 = join(evidenceDir, basename(outputPath)), cuePng = join(evidenceDir, 'cue-1s.png')
      await copyFile(outputPath, evidenceMp4)
      await execFileAsync(ffmpegPath, ['-v', 'error', '-y', '-ss', '1', '-i', outputPath, '-frames:v', '1', cuePng])
      await writeFile(join(evidenceDir, 'manifest.json'), JSON.stringify({ fixtureEvidence: true, operationId: proof.proxyOperationId, snapshotId: proof.snapshotId, planHash: proof.planHash, artifactId: proof.proxyArtifactId, sha256: output.sha256, mp4: basename(evidenceMp4), cueFrame: basename(cuePng) }, null, 2))
    }
    const { approveLocalizationMediaService } = await import('../../src/v2/application/localization-media.ts')
    const approvalRepository = new PrismaLocalizationMediaRunRepository(prisma), approvalAt = new Date(fixture.now.getTime() + 30_000)
    const approve = approveLocalizationMediaService({ runs: approvalRepository, clock: () => approvalAt })
    const approvalInput = { workspaceId: fixture.workspaceId, projectId: fixture.projectId, variantId: fixture.variant.id, runId: outcome.id, expectedRevision: outcome.revision, expectedRunHash: outcome.runHash, actorClientId: fixture.clientId, authenticationAudit: fixture.audit, idempotencyKey: `approve-${fixture.suffix}`, note: 'Measured proxy reviewed' }
    const review = await prisma.v2ProxyReview.findUniqueOrThrow({ where: { operationId: proof.proxyOperationId } })
    assert.equal(review.status, 'ready-for-final'); assert.equal(review.finalAllowed, true)
    const { calculateProxyReviewHash } = await import('../../src/v2/application/render-workflow.ts')
    const { PrismaProxyReviewRepository } = await import('../../src/v2/infrastructure/prisma/proxy-review-repository.ts')
    const reviewBody = { schemaVersion: 'proxy-review/v1', projectVersionId: review.projectVersionId, proxyArtifactId: review.proxyArtifactId, proxyManifestId: review.proxyManifestId, inputHash: review.inputHash, outputSpecId: review.outputSpecId, rangeCacheKey: review.rangeCacheKey, spec: JSON.parse(review.specJson), status: review.status, technicalIssues: JSON.parse(review.technicalIssuesJson), criticIssues: JSON.parse(review.criticIssuesJson), ...(review.formatQualityJson === null ? {} : { formatQuality: JSON.parse(review.formatQualityJson) }), warningsAcknowledged: review.warningsAcknowledged, finalAllowed: review.finalAllowed, uploadReceivedAt: review.uploadReceivedAt.toISOString(), renderCompletedAt: review.renderCompletedAt.toISOString(), timeToFirstProxyMs: Number(review.timeToFirstProxyMs) }
    const laterCompletedAt = new Date(review.renderCompletedAt.getTime() + 1_000).toISOString()
    const retryBody = { ...reviewBody, renderCompletedAt: laterCompletedAt, timeToFirstProxyMs: reviewBody.timeToFirstProxyMs + 1_000 }
    const retryReview = Object.freeze({ ...retryBody, reviewHash: calculateProxyReviewHash(retryBody) })
    const proxyReviews = new PrismaProxyReviewRepository(prisma)
    const retryPersisted = await proxyReviews.persistGenerated({ id: `retry-${review.id}`, workspaceId: fixture.workspaceId, projectId: fixture.projectId, operationId: proof.proxyOperationId, review: retryReview, createdAt: laterCompletedAt })
    assert.equal(retryPersisted.reviewHash, review.reviewHash, 'retry keeps the first equivalent operation-bound review observation')
    const conflictBody = { ...retryBody, inputHash: 'e'.repeat(64) }
    await assert.rejects(() => proxyReviews.persistGenerated({ id: `conflict-${review.id}`, workspaceId: fixture.workspaceId, projectId: fixture.projectId, operationId: proof.proxyOperationId, review: Object.freeze({ ...conflictBody, reviewHash: calculateProxyReviewHash(conflictBody) }), createdAt: laterCompletedAt }), /identity did not converge/)
    const hardIssues = [{ code: 'VALID_HARD_BLOCK', severity: 'hard', category: 'integrity', message: 'Persisted blocker', correctable: false }]
    const blockedReviewBody = { schemaVersion: 'proxy-review/v1', projectVersionId: review.projectVersionId, proxyArtifactId: review.proxyArtifactId, proxyManifestId: review.proxyManifestId, inputHash: review.inputHash, outputSpecId: review.outputSpecId, rangeCacheKey: review.rangeCacheKey, spec: JSON.parse(review.specJson), status: 'blocked', technicalIssues: JSON.parse(review.technicalIssuesJson), criticIssues: hardIssues, ...(review.formatQualityJson === null ? {} : { formatQuality: JSON.parse(review.formatQualityJson) }), warningsAcknowledged: review.warningsAcknowledged, finalAllowed: false, uploadReceivedAt: review.uploadReceivedAt.toISOString(), renderCompletedAt: review.renderCompletedAt.toISOString(), timeToFirstProxyMs: Number(review.timeToFirstProxyMs) }
    await prisma.v2ProxyReview.update({ where: { id: review.id }, data: { status: 'blocked', finalAllowed: false, criticIssuesJson: JSON.stringify(hardIssues), reviewHash: calculateProxyReviewHash(blockedReviewBody) } })
    await assert.rejects(approve({ ...approvalInput, idempotencyKey: `blocked-${fixture.suffix}` }), (error) => error?.code === 'PRECONDITION_REQUIRED')
    assert.equal((await approvalRepository.read({ workspaceId: fixture.workspaceId, projectId: fixture.projectId, runId: outcome.id })).status, 'awaiting-human-approval')
    await prisma.v2ProxyReview.update({ where: { id: review.id }, data: { status: review.status, finalAllowed: review.finalAllowed, criticIssuesJson: review.criticIssuesJson, reviewHash: '0'.repeat(64) } })
    await assert.rejects(approve({ ...approvalInput, idempotencyKey: `tampered-hash-${fixture.suffix}` }), (error) => error?.code === 'PRECONDITION_REQUIRED')
    await prisma.v2ProxyReview.update({ where: { id: review.id }, data: { reviewHash: review.reviewHash } })

    await prisma.v2LocalizationVariantHead.update({ where: { id: fixture.variant.id }, data: { currentVariantHash: '0'.repeat(64) } })
    await assert.rejects(approve({ ...approvalInput, idempotencyKey: `stale-${fixture.suffix}` }), (error) => error?.code === 'VERSION_CONFLICT')
    await prisma.v2LocalizationVariantHead.update({ where: { id: fixture.variant.id }, data: { currentVariantHash: fixture.variant.variantHash } })

    const approved = await approve(approvalInput), replayed = await approve({ ...approvalInput, note: '  Measured proxy reviewed  ' })
    assert.equal(approved.status, 'approved'); assert.equal(replayed.runHash, approved.runHash)
    const approvedHead = await prisma.v2LocalizationVariantHead.findUniqueOrThrow({ where: { id: fixture.variant.id } })
    const approvedVariant = JSON.parse((await prisma.v2LocalizationVariantRevision.findFirstOrThrow({ where: { variantId: fixture.variant.id, revision: approvedHead.currentRevision } })).variantJson)
    const expectedCaptionIds = snapshotPlan.subtitleTracks.flatMap((track) => track.cues.map((cue) => cue.id)).sort()
    const expectedClipIds = snapshotPlan.videoTracks.filter((track) => track.kind === 'base-video').flatMap((track) => track.clips.map((clip) => clip.id)).sort()
    assert.deepEqual(approvedVariant.dependentPlan.captionIds, expectedCaptionIds); assert.deepEqual(approvedVariant.dependentPlan.clipIds, expectedClipIds)
    assert.ok(!approvedVariant.dependentPlan.captionIds.includes(proof.snapshotId)); assert.ok(!approvedVariant.dependentPlan.clipIds.includes(proof.planHash))
    await assert.rejects(approve({ ...approvalInput, variantId: `wrong-${fixture.variant.id}` }), (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
    await assert.rejects(approve({ ...approvalInput, authenticationAudit: { ...fixture.audit, contextHash: '0'.repeat(64) } }), (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  } catch (error) { failure = error; throw error } finally {
    try {
      if (runtime) await runtime.close()
      if (fixture) {
        await prisma.v2LocalizationMediaRunRevision.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2LocalizationMediaRun.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2ProxyReview.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2RenderElementMap.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2OperationTelemetryAlert.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2OperationTelemetryEvent.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2PublicEventOutbox.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2PublicOperation.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2RenderablePlanSnapshot.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2AutomaticCatalogRecord.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2MediaArtifactLineage.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2ColorPipelineCompilation.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2MediaColorProbe.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2ProjectMediaAsset.deleteMany({ where: { workspaceId: fixture.workspaceId, artifactId: { not: fixture.artifactId } } })
        await prisma.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: fixture.workspaceId, artifactId: { not: fixture.artifactId } } })
        await prisma.v2MediaArtifact.deleteMany({ where: { workspaceId: fixture.workspaceId, id: { not: fixture.artifactId } } })
        await prisma.v2RecipeParameterPayload.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await prisma.v2RenderInputPayload.deleteMany({ where: { workspaceId: fixture.workspaceId } })
        await fixture.cleanup()
      }
    } catch (cleanupError) { if (failure) throw new AggregateError([failure, cleanupError]); throw cleanupError }
    finally { await prisma.$disconnect(); await rm(work, { recursive: true, force: true }) }
  }
})
