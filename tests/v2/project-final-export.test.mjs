import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { enqueueProjectFinalExportService } from '../../src/v2/application/enqueue-project-final-export.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { projectRenderSourcesFingerprint } from '../../src/v2/application/project-render-sources.ts'
import { runNextProjectFinalExportOperationService } from '../../src/v2/application/run-project-final-export-worker.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { ASS_EMISSION_POLICY } from '../../src/v2/domain/ass-emission-policy.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { artifactOutputStoragePrefix } from '../../src/v2/domain/artifact-storage-identity.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createRenderPlacementPlan, validateRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { createQualityReport, resolveStrategicRubric } from '../../src/v2/domain/strategic-rubric.ts'
import { SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } from '../../src/v2/domain/subtitle-system.ts'
import { parseFinalExportQuality, PrismaProjectFinalExportRepository } from '../../src/v2/infrastructure/prisma/project-final-export-repository.ts'
import { alteredConsumption, fakeOutputWorld, withConsumption } from './helpers/output-consumption-fakes.mjs'
import { assertRenderedSubtitleCuesAreReviewed } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'

const workspaceId = 'workspace-final-export-test'

test('final export rejects unknown, legacy and hash-altered face-safety claims', async () => {
  const rubric = resolveStrategicRubric('discovery')
  const evaluatedAt = '2026-10-08T00:00:00.000Z'
  const strategic = createQualityReport({ objective: 'discovery',
    evidence: rubric.criteria.map((criterion) => ({ criterionId: criterion.id, score: 100,
      evidence: [`controlled:${criterion.id}`] })),
    gates: { narrativeIntegrity: true, legibility: true, rights: true }, evaluatedAt })
  const quality = {
    schemaVersion: 'director-quality-report/v3', id: 'quality-controlled',
    desiredActionRef: { id: 'action-controlled' }, status: 'review-required', score: 1,
    strategic, issues: [], criticVersion: 'project-director-critic/v2', evaluatedAt,
    faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
    hardChecks: { openingMotionProtected: true, automaticZoomDisabled: true,
      subtitlesFaceSafe: false, subtitlesBounded: true, forbiddenSpeechAbsent: true,
      timelineContinuous: true },
  }
  const encoded = JSON.stringify(quality)
  const parse = (report, hash = calculateVersionHash(report)) => parseFinalExportQuality({
    contentJson: JSON.stringify(report), contentHash: hash, contentSchemaVersion: 3,
    objective: 'discovery', rubricRef: `${rubric.id}/v${rubric.version}`,
  })
  assert.equal(parse(quality).status, 'review-required')
  for (const candidate of [
    { ...quality, status: 'approved' },
    { ...quality, status: 'approved-with-warnings' },
    { ...quality, status: 'approved', faceSafety: undefined },
    { ...quality, schemaVersion: 'director-quality-report/v2', status: 'approved' },
    { ...quality, status: 'approved', faceSafety: { status: 'verified', reasonCode: 'DETECTOR_PASS', evidenceRefs: [] }, hardChecks: { ...quality.hardChecks, subtitlesFaceSafe: true } },
    { ...quality, status: 'approved', faceSafety: { status: 'verified', reasonCode: 'DETECTOR_PASS', evidenceRefs: [null] }, hardChecks: { ...quality.hardChecks, subtitlesFaceSafe: true } },
    { ...quality, status: 'approved', faceSafety: { status: 'verified', reasonCode: '', evidenceRefs: ['evidence-1'] }, hardChecks: { ...quality.hardChecks, subtitlesFaceSafe: true } },
    { ...quality, hardChecks: { subtitlesFaceSafe: false } },
  ]) {
    assert.throws(() => parse(candidate),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  }
  assert.throws(() => parse(quality, 'f'.repeat(64)),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  const verified = { ...quality, status: 'approved',
    faceSafety: { status: 'verified', reasonCode: 'DETECTOR_PASS', evidenceRefs: ['evidence-1'] },
    hardChecks: { ...quality.hardChecks, subtitlesFaceSafe: true } }
  assert.equal(parse(verified).status, 'approved', 'syntax-only parser does not grant evidence authority')
  const observed = []
  const repository = new PrismaProjectFinalExportRepository({
    v2Project: { async findFirst() { return {
      locale: 'pt-BR', versions: [{ id: 'result-version' }],
      directorRuns: [{ id: 'director-run', baseVersionId: 'input-version',
        qualitySnapshotId: 'quality-snapshot', objective: 'discovery',
        rubricRef: `${rubric.id}/v${rubric.version}`,
        qualitySnapshot: { schemaVersion: 3, contentJson: JSON.stringify(verified),
          contentHash: calculateVersionHash(verified) } }],
      proxyReviews: [{ id: 'proxy-review', reviewHash: 'a'.repeat(64), proxyArtifactId: 'proxy-artifact' }],
    } } },
  })
  repository.perceptionEvidence = { async read(input) { observed.push(input); return { modality: 'ocr' } } }
  const request = { workspaceId, projectId: 'project-controlled', projectVersionId: 'result-version',
    projectVersionHash: 'b'.repeat(64), outputSpecId: 'output-spec-controlled', requireCurrent: true }
  assert.equal(await repository.readApproval(request), null,
    'an immutable OCR envelope cannot authorize facial safety')
  assert.equal(observed[0].inputVersionId, 'input-version')
  repository.perceptionEvidence = { async read() { return null } }
  assert.equal(await repository.readApproval(request), null, 'missing evidence cannot authorize export')
})
const projectId = 'project-final-export-test'
const projectVersionId = 'project-version-final-export-test'
const sourceArtifactId = 'artifact-final-export-source'
const sourceManifestId = 'manifest-final-export-source'
// The sealed State of the Version the final export consumes: the persisted `final` verdict of this world is what every source carries.
const finalWorld = fakeOutputWorld({ workspaceId, projectId, versionId: projectVersionId, baseHash: '1'.repeat(64) })
const colorCompilation = Object.freeze({
  id: 'color-pipeline-final-export', sourceArtifactId, sourceManifestId,
  compilationHash: '8'.repeat(64), pipeline: Object.freeze({ pipelineHash: '9'.repeat(64) }),
})
const colorPipelineBindings = Object.freeze([Object.freeze({
  sourceArtifactId, sourceManifestId, compilationId: colorCompilation.id,
  compilationHash: colorCompilation.compilationHash, pipelineHash: colorCompilation.pipeline.pipelineHash,
})])
const colorPipelines = {
  async listForSource() { return [{ compilation: colorCompilation }] },
  async read() { return { compilation: colorCompilation } },
}

function exportActor(credentialId = 'credential-final-export-test') {
  const auditContext = createExternalAuditContext({
    clientId: 'client-final-export-test', credentialId, workspaceId,
    environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function rightsSnapshot(allowedUses = ['editorial-reuse', 'rendering']) {
  return createAssetRightsSnapshot({
    id: 'rights-final-export-test',
    workspaceId,
    artifactId: sourceArtifactId,
    sequence: 1,
    draft: {
      status: 'approved',
      allowedUses,
      prohibitedUses: [],
      allowedLocales: ['pt-BR'],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'api-client', id: 'client-final-export-test' },
    createdAt: '2026-07-19T01:00:00.000Z',
  })
}

function approvedSource() {
  return Object.freeze({
    projectId,
    projectVersionId,
    projectVersionHash: '1'.repeat(64),
    editPlanSnapshotId: 'snapshot-edit-plan-final-test',
    editPlanHash: '2'.repeat(64),
    editPlan: Object.freeze({
      schemaVersion: 2,
      state: 'compiled',
      id: 'edit-plan-final-export-test',
      projectVersionId,
      fps: 30.000000097244733,
      movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
      durationFrames: 300,
      // A Director plan always carries its captions with their persisted preset, which is what
      // makes the renderer demand the unknown-face review plan for them.
      subtitleTracks: Object.freeze([{ presetId: 'kinetic', cues: Object.freeze([
        Object.freeze({ id: 'cue-final-1', startFrame: 0, endFrame: 60, text: 'Legenda final segura', anchor: 'bottom' }),
      ]) }]),
      transitions: Object.freeze([]),
      videoTracks: Object.freeze([{ kind: 'base-video', clips: Object.freeze([
        Object.freeze({ id: 'clip-final-1', sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 }),
      ]) }]),
    }),
    format: '9:16',
    outputConsumption: finalWorld.consumption('final'),
    locale: 'pt-BR',
    directorRunId: 'director-run-final-export-test',
    qualitySnapshotId: 'quality-snapshot-final-export-test',
    qualitySnapshotHash: '3'.repeat(64),
    qualityStatus: 'approved',
    qualityScore: 0.97,
    proxyReviewId: 'proxy-review-final-export-test',
    proxyReviewHash: '7'.repeat(64),
    proxyArtifactId: 'artifact-proxy-final-export-test',
    sourceArtifactId,
    sourceManifestId,
    sourceArtifactKey: 'workspaces/final-export/masters/source.mp4',
    sourceSha256: '4'.repeat(64),
    renderSources: Object.freeze([Object.freeze({
      artifactId: sourceArtifactId,
      manifestId: sourceManifestId,
      artifactKey: 'workspaces/final-export/masters/source.mp4',
      sha256: '4'.repeat(64),
      byteSize: 4096,
      mediaType: 'video',
      container: 'mp4',
      role: 'source-master',
    })]),
    originalFileName: 'gravacao-bruta.mp4',
  })
}

function finalInputHash(includePolicy = true, source = approvedSource()) {
  return calculateVersionHash({
    kind: 'project-final-export/v2',
    ...(includePolicy ? { assEmissionPolicy: ASS_EMISSION_POLICY } : {}),
    projectId,
    projectVersionId,
    projectVersionHash: source.projectVersionHash,
    editPlanSnapshotId: source.editPlanSnapshotId,
    editPlanHash: source.editPlanHash,
    directorRunId: source.directorRunId,
    qualitySnapshotId: source.qualitySnapshotId,
    qualitySnapshotHash: source.qualitySnapshotHash,
    proxyReviewId: source.proxyReviewId,
    proxyReviewHash: source.proxyReviewHash,
    proxyArtifactId: source.proxyArtifactId,
    sourceArtifactId: source.sourceArtifactId,
    sourceManifestId: source.sourceManifestId,
    sourceSha256: source.sourceSha256,
    renderSourcesFingerprint: projectRenderSourcesFingerprint(source.renderSources),
    colorPipelineBindings,
    outputSpec: {
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      codec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      quality: 'final',
    },
    outputConsumptionSealHash: source.outputConsumption.sealHash,
  })
}

test('final export enqueue binds approval, exact Director evidence and 1080x1920 output idempotently', async () => {
  let created
  const replays = new Map()
  const operations = {
    async findReplay(input) { return replays.get(`${input.clientId}:${input.idempotencyKey}`) ?? null },
    async createOrReplay(input) {
      created = input
      const result = { operation: input.operation, context: input.context, authenticationAudit: input.authenticationAudit, replayed: false }
      replays.set(`${input.operation.clientId}:${input.idempotencyKey}`, result)
      return result
    },
  }
  const ids = { operation: 0, artifact: 0, manifest: 0 }
  const enqueue = enqueueProjectFinalExportService({
    projects: { async readApprovedCurrentSource() { return approvedSource() } },
    rights: { async findCurrent() { return { snapshot: rightsSnapshot(), revision: 'revision-1' } } },
    operations,
    colorPipelines,
    clock: () => new Date('2026-07-19T01:05:00.000Z'),
    createId(kind) { ids[kind] += 1; return `${kind}-final-export-${ids[kind]}` },
  })
  const request = {
    workspaceId,
    projectId,
    projectVersionId,
    projectVersionHash: '1'.repeat(64),
    format: '9:16',
    approval: { approved: true, note: 'Aprovado para publicação.' },
    actor: exportActor(),
    idempotencyKey: 'final-export-request-1',
  }

  const first = await enqueue(request)
  const replay = await enqueue(request)

  assert.equal(first.operation.type, 'project-final-export')
  assert.equal(first.context.directorRunId, 'director-run-final-export-test')
  assert.equal(first.context.qualitySnapshotHash, '3'.repeat(64))
  assert.deepEqual(first.context.outputSpec, {
    aspectRatio: '9:16', width: 1080, height: 1920, fps: 30,
    codec: 'h264', audioCodec: 'aac', container: 'mp4', quality: 'final',
  })
  assert.equal(first.context.proxyReviewId, 'proxy-review-final-export-test')
  assert.equal(first.context.proxyReviewHash, '7'.repeat(64))
  assert.deepEqual(first.context.approval, {
    actorType: 'api-client', actorId: 'client-final-export-test',
    approvedAt: '2026-07-19T01:05:00.000Z', note: 'Aprovado para publicação.',
  })
  assert.match(first.context.inputHash, /^[a-f0-9]{64}$/)
  assert.equal(replay.operation.id, first.operation.id)
  assert.equal(first.context.inputHash, finalInputHash(), 'enqueue binds the independently computed policy identity')
  assert.equal(created.requestFingerprint.length, 64)
  assert.equal(created.authenticationAudit.contextHash, first.authenticationAudit.contextHash)
  assert.deepEqual(ids, { operation: 1, artifact: 1, manifest: 1 })
})

test('final export enqueue fails closed without current rendering rights', async () => {
  const enqueue = enqueueProjectFinalExportService({
    projects: { async readApprovedCurrentSource() { return approvedSource() } },
    rights: { async findCurrent() { return null } },
    operations: {},
    clock: () => new Date('2026-07-19T01:05:00.000Z'),
    createId() { throw new Error('must not allocate') },
  })
  await assert.rejects(() => enqueue({
    workspaceId,
    projectId,
    projectVersionId,
    projectVersionHash: '1'.repeat(64),
    format: '9:16',
    approval: { approved: true },
    actor: exportActor(),
    idempotencyKey: 'final-export-blocked',
  }), (error) => error instanceof DomainError && error.code === 'ASSET_RIGHTS_BLOCKED')
})

test('final export enqueue fails before allocation when catalog promotion rights are missing', async () => {
  const enqueue = enqueueProjectFinalExportService({
    projects: { async readApprovedCurrentSource() { return approvedSource() } },
    rights: { async findCurrent() { return { snapshot: rightsSnapshot(['rendering']), revision: 'revision-render-only' } } },
    operations: {},
    clock: () => new Date('2026-07-19T01:05:00.000Z'),
    createId() { throw new Error('must not allocate') },
  })
  await assert.rejects(() => enqueue({
    workspaceId,
    projectId,
    projectVersionId,
    projectVersionHash: '1'.repeat(64),
    format: '9:16',
    approval: { approved: true },
    actor: exportActor(),
    idempotencyKey: 'final-export-catalog-rights-blocked',
  }), (error) => error instanceof DomainError
    && error.code === 'ASSET_RIGHTS_BLOCKED'
    && error.details.requiredUse === 'editorial-reuse')
})

function createOperations(inputHash = finalInputHash()) {
  let operation = createQueuedPublicOperation({
    id: 'operation-final-export-test',
    workspaceId,
    projectId,
    clientId: 'client-final-export-test',
    type: 'project-final-export',
    target: { type: 'media-artifact', id: 'artifact-final-output', manifestId: 'manifest-final-output' },
    maxAttempts: 2,
    createdAt: '2026-07-19T01:00:00.000Z',
  })
  const context = Object.freeze({
    kind: 'project-final-export',
    projectId,
    projectVersionId,
    projectVersionHash: '1'.repeat(64),
    editPlanSnapshotId: 'snapshot-edit-plan-final-test',
    directorRunId: 'director-run-final-export-test',
    qualitySnapshotId: 'quality-snapshot-final-export-test',
    qualitySnapshotHash: '3'.repeat(64),
    proxyReviewId: 'proxy-review-final-export-test',
    proxyReviewHash: '7'.repeat(64),
    proxyArtifactId: 'artifact-proxy-final-export-test',
    sourceArtifactId,
    sourceManifestId,
    colorPipelineBindings,
    inputHash,
    outputArtifactId: 'artifact-final-output',
    outputManifestId: 'manifest-final-output',
    outputSpec: {
      aspectRatio: '9:16', width: 1080, height: 1920, fps: 30,
      codec: 'h264', audioCodec: 'aac', container: 'mp4', quality: 'final',
    },
    approval: { actorType: 'api-client', actorId: 'client-final-export-test', approvedAt: '2026-07-19T01:00:00.000Z' },
    originalFileName: 'gravacao-bruta-final-1080x1920.mp4',
  })
  let lease
  const matches = (input) => lease && lease.owner === input.leaseOwner && lease.attempt === input.attempt && Date.parse(lease.expiresAt) > Date.parse(input.now)
  const record = () => ({ operation, context })
  return {
    get operation() { return operation },
    repository: {
      async claimNext(input) {
        assert.equal(input.type, 'project-final-export')
        operation = startPublicOperationAttempt(operation, input.now)
        lease = { owner: input.leaseOwner, attempt: operation.attempt, heartbeatAt: input.now, expiresAt: input.leaseUntil }
        return { ...record(), lease: Object.freeze({ ...lease }) }
      },
      async heartbeat(input) {
        if (!matches(input)) return false
        lease = { ...lease, heartbeatAt: input.now, expiresAt: input.leaseUntil }
        return true
      },
      async advancePhase(input) {
        if (!matches(input)) return false
        operation = advancePublicOperationPhase(operation, input.phase, input.now)
        return true
      },
      async succeed(input) {
        if (!matches(input)) return null
        operation = succeedPublicOperation(operation, input.now)
        lease = undefined
        return record()
      },
      async failOrRetry(input) {
        if (!matches(input)) return null
        operation = retryOrFailPublicOperation(operation, input.error, input.now, input.nextAttemptAt)
        lease = undefined
        return record()
      },
    },
  }
}

function workerDependencies(
  operations,
  rightsProvider = () => rightsSnapshot(),
  persistedIdentity = { artifactId: 'artifact-final-output', manifestId: 'manifest-final-output' },
) {
  let now = Date.parse('2026-07-19T01:00:00.000Z')
  const calls = { rights: 0, rendered: 0, persisted: 0, mapped: 0, converged: 0, attached: 0, attempts: 0, failed: 0, cleaned: 0, lutCleaned: 0, cataloged: 0 }
  const renderInputs = []
  const renderErrors = []
  return {
    calls,
    renderInputs,
    renderErrors,
    dependencies: {
      async catalogOutput(input) { calls.cataloged += 1; assert.equal(input.artifactId, persistedIdentity.artifactId) },
      operations: operations.repository,
      colorPipelines,
      colorPlans: { async readEffectiveForVersion() { return null } },
      luts: {
        async materialize() { return { selectionId: 'selection-final-export', selectionHash: '8'.repeat(64), lutPaths: {} } },
        async cleanup() { calls.lutCleaned += 1 },
      },
      projects: {
        async readImmutableApprovedSource() { return approvedSource() },
        async convergeOutputIdentity(input) {
          calls.converged += 1
          assert.equal(input.reservedArtifactId, 'artifact-final-output')
          assert.equal(input.reservedManifestId, 'manifest-final-output')
          assert.equal(input.persistedArtifactId, persistedIdentity.artifactId)
          assert.equal(input.persistedManifestId, persistedIdentity.manifestId)
          assert.equal(input.leaseOwner, 'worker-final-export-deduplicated')
          assert.equal(input.attempt, 1)
        },
        async attachCompletedOutput(input) {
          calls.attached += 1
          assert.equal(input.outputArtifactId, persistedIdentity.artifactId)
          assert.equal(input.outputManifestId, persistedIdentity.manifestId)
        },
        async recordAttempt(input) {
          calls.attempts += 1
          assert.equal(input.operationId, 'operation-final-export-test')
          assert.equal(input.attempt, 1)
          assert.equal(input.validators.length >= 1, true)
          if (input.status === 'promoted') {
            assert.equal(input.output.artifactId, persistedIdentity.artifactId)
            assert.equal(input.output.manifestId, persistedIdentity.manifestId)
            assert.equal(input.output.sha256, '6'.repeat(64))
          } else {
            assert.equal(input.error.code.length > 0, true)
          }
        },
        async markExportFailed() { calls.failed += 1 },
      },
      rights: {
        async findCurrent() {
          calls.rights += 1
          const snapshot = rightsProvider(calls.rights)
          return snapshot ? { snapshot, revision: `revision-${calls.rights}` } : null
        },
      },
      artifacts: {
        async persistOrReplay(input) {
          calls.persisted += 1
          assert.equal(input.manifest.recipe.id, 'editorial-final')
          assert.deepEqual(input.lineageIds, [
            `lineage-${createHash('sha256').update(`${workspaceId}:${finalInputHash()}:manifest-final-output:final:${sourceArtifactId}:0`).digest('hex')}`,
          ])
          assert.equal(input.manifest.schemaVersion, 'media-artifact-manifest/v4')
          assert.equal(input.manifest.recipe.parametersRef, input.recipeParameters.ref)
          assert.equal(input.manifest.renderInput.ref, input.renderInput.ref)
          assert.equal(input.manifest.renderInput.inputHash, input.renderInput.inputHash)
          const renderInput = JSON.parse(input.renderInput.canonicalJson)
          assert.equal(renderInput.plan.versionId, projectVersionId)
          assert.equal(renderInput.output.aspectRatio, '9:16')
          assert.deepEqual(
            renderInput.assets.map((asset) => asset.artifactId),
            [sourceArtifactId],
          )
          const parameters = JSON.parse(input.recipeParameters.canonicalJson)
          assert.match(parameters.audioTimelineHash, /^[a-f0-9]{64}$/)
          // The geometry that drew the bytes is part of the recipe, as it is for the proxy.
          const drawn = renderInputs.at(-1)
          assert.match(drawn.placementPlan.placementPlanHash, /^[a-f0-9]{64}$/)
          assert.equal(parameters.placementPlanHash, drawn.placementPlan.placementPlanHash)
          assert.equal(parameters.subtitleAnchorPlanHash, drawn.placementPlan.subtitleAnchorPlan?.anchorPlanHash ?? null)
          assert.equal(parameters.perceptionTimelineHash, drawn.placementPlan.subtitleAnchorPlan?.perceptionTimelineHash ?? null)
          assert.equal(parameters.reframePlanHash, drawn.reframePlan?.reframePlanHash ?? null)
          assert.equal(parameters.directorRunId, 'director-run-final-export-test')
          assert.equal(parameters.qualitySnapshotId, 'quality-snapshot-final-export-test')
          assert.deepEqual(parameters.outputSpec, {
            aspectRatio: '9:16', width: 1080, height: 1920, fps: 30,
            codec: 'h264', audioCodec: 'aac', container: 'mp4', quality: 'final',
          })
          assert.equal(parameters.proxyReviewId, 'proxy-review-final-export-test')
          assert.deepEqual(input.manifest.probe, { width: 1080, height: 1920, duration: 10, fps: 30 })
          return { ...persistedIdentity, replayed: false }
        },
      },
      storage: {
        async promoteDerived(input) {
          assert.equal(input.prefix, artifactOutputStoragePrefix('final-export', 'artifact-final-output'))
          return { key: `workspaces/final-export/${input.prefix}/output.mp4`, sha256: '6'.repeat(64), byteSize: 8192 }
        },
      },
      renderer: {
        async render(input) {
          calls.rendered += 1
          renderInputs.push(input)
          assert.equal(input.renderKind, 'final')
          assert.equal(input.fps, 30)
          // The controlled port applies the real renderer's admission gate for burned-in captions
          // (the very function FfmpegEditorialProxyRenderer.render runs before any I/O), so a worker
          // that hands over cues without their review plan cannot be admitted here either.
          try {
            assertRenderedSubtitleCuesAreReviewed(
              input,
              input.clips.reduce((total, clip) => total + clip.timelineOutFrame - clip.timelineInFrame, 0),
            )
          } catch (error) {
            renderErrors.push(error.message)
            throw error
          }
          assert.match(input.audioTimelineHash, /^[a-f0-9]{64}$/)
          assert.deepEqual(input.lutPaths, {})
          assert.deepEqual(input.sources, [{
            artifactId: sourceArtifactId,
            path: join(
              tmpdir(),
              'apollo-final-export-artifacts',
              'workspaces',
              'final-export',
              'masters',
              'source.mp4',
            ),
            mediaType: 'video',
            colorPipelineCompilation: colorCompilation,
          }])
          assert.deepEqual(input.outputSpec, {
            aspectRatio: '9:16', width: 1080, height: 1920, fps: 30,
            codec: 'h264', audioCodec: 'aac', container: 'mp4', quality: 'final',
          })
          return {
            outputPath: join(tmpdir(), 'apollo-final-export-output.mp4'),
            sha256: '6'.repeat(64), byteSize: 8192,
            probe: { width: 1080, height: 1920, duration: 10, fps: 30, codec: 'h264', audioCodec: 'aac', container: 'mp4' },
            renderElementMap: { schemaVersion: 'render-element-map/v1', proxyHash: '6'.repeat(64), fps: 30, durationFrames: 300, canvas: { width: 1080, height: 1920 }, elements: [] },
          }
        },
        async cleanup() { calls.cleaned += 1 },
      },
      renderElementMaps: {
        async persistOrReplay(input) {
          calls.mapped += 1
          assert.equal(input.proxyArtifactId, persistedIdentity.artifactId)
          assert.equal(input.map.proxyHash, '6'.repeat(64))
          return { record: {}, replayed: false }
        },
      },
      sources: {
        async materialize(input) {
          return {
            path: join(tmpdir(), 'apollo-final-export-artifacts', ...input.artifactKey.split('/')),
            sha256: input.sha256,
            byteSize: input.byteSize,
          }
        },
        async cleanup() {},
      },
      clock: () => new Date((now += 100)),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 1_000,
    },
  }
}

test('final export records a sanitized LUT materialization stage for a real missing file', async () => {
  const operations = createOperations()
  const { dependencies } = workerDependencies(operations)
  const missingPath = join(tmpdir(), `apollo-final-export-missing-lut-${process.pid}.cube`)
  let recorded
  const originalRecord = dependencies.projects.recordAttempt
  dependencies.projects.recordAttempt = async (input) => {
    recorded = input
    await originalRecord(input)
  }
  dependencies.luts.materialize = async () => {
    await readFile(missingPath)
  }
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-missing-lut')
  assert.equal(outcome.status, 'retrying')
  assert.equal(recorded.status, 'failed')
  assert.equal(recorded.error.stage, 'lut-materialization')
  assert.equal(recorded.error.code, 'required_file_missing')
  assert.equal(recorded.error.message, 'Project final export could not be completed')
  assert.equal(JSON.stringify(recorded).includes(missingPath), false)
})

test('final export worker revalidates rights, persists lineage and completes the project', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-success')

  assert.deepEqual(calls, { rights: 2, rendered: 1, persisted: 1, mapped: 1, converged: 0, attached: 1, attempts: 1, failed: 0, cleaned: 1, lutCleaned: 1, cataloged: 1 })
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'succeeded' })
  assert.equal(operations.operation.status, 'succeeded')
})

test('W69 final worker rejects pre-policy queued identity before any render or publication', async () => {
  const operations = createOperations(finalInputHash(false))
  const { calls, dependencies } = workerDependencies(operations)
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-old-clock')
  assert.equal(outcome.status, 'failed')
  assert.equal(operations.operation.error.code, 'invalid_render_input')
  assert.equal(calls.rendered, 0)
  assert.equal(calls.persisted, 0)
  assert.equal(calls.attached, 0)
})

test('final export worker serializes heartbeats with fenced phase transitions', async () => {
  const operations = createOperations()
  const { dependencies } = workerDependencies(operations)
  const originalHeartbeat = operations.repository.heartbeat.bind(
    operations.repository,
  )
  const originalAdvancePhase = operations.repository.advancePhase.bind(
    operations.repository,
  )
  let phaseTransitionActive = false
  let heartbeatRacedPhase = false
  operations.repository.advancePhase = async (input) => {
    phaseTransitionActive = true
    await new Promise((resolve) => setTimeout(resolve, 15))
    phaseTransitionActive = false
    if (heartbeatRacedPhase) return false
    return originalAdvancePhase(input)
  }
  operations.repository.heartbeat = async (input) => {
    if (phaseTransitionActive) heartbeatRacedPhase = true
    return originalHeartbeat(input)
  }
  dependencies.heartbeatIntervalMs = 1

  const outcome = await runNextProjectFinalExportOperationService(dependencies)(
    'worker-final-export-heartbeat-fence',
  )

  assert.equal(heartbeatRacedPhase, false)
  assert.deepEqual(outcome, {
    operationId: 'operation-final-export-test',
    status: 'succeeded',
  })
  assert.equal(operations.operation.status, 'succeeded')
})

test('final export worker fails closed if rights are revoked before persistence', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations, (call) => call === 1 ? rightsSnapshot() : null)
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-revoked')

  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
  assert.equal(operations.operation.status, 'failed')
  assert.deepEqual(calls, { rights: 2, rendered: 1, persisted: 0, mapped: 0, converged: 0, attached: 0, attempts: 1, failed: 1, cleaned: 1, lutCleaned: 1, cataloged: 0 })
})

test('final export worker does not complete the project before catalog convergence', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  dependencies.catalogOutput = async () => {
    calls.cataloged += 1
    throw new DomainError('PERSISTENCE_CONFLICT', 'Catalog convergence failed')
  }

  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-catalog-failure')

  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
  assert.equal(operations.operation.status, 'failed')
  assert.equal(calls.cataloged, 1)
  assert.equal(calls.attached, 0)
  assert.equal(calls.failed, 1)
})

test('final export worker converges content deduplication under the active lease', async () => {
  const operations = createOperations()
  const persistedIdentity = {
    artifactId: 'artifact-final-output-existing',
    manifestId: 'manifest-final-output-existing',
  }
  const { calls, dependencies } = workerDependencies(
    operations,
    () => rightsSnapshot(),
    persistedIdentity,
  )
  const outcome = await runNextProjectFinalExportOperationService(dependencies)(
    'worker-final-export-deduplicated',
  )

  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'succeeded' })
  assert.equal(calls.converged, 1)
  assert.equal(calls.attached, 1)
})

// ---------------------------------------------------------------------------
// Captions in the final render: the worker must hand the renderer the same geometry the
// approved proxy was drawn from (derive-editorial-render-geometry.ts), on the final canvas.
// ---------------------------------------------------------------------------

const PLAN_FPS = 30.000000097244733

function expectedPlacementPlan(overrides = {}) {
  return createRenderPlacementPlan({
    format: '9:16',
    canvas: { width: 1080, height: 1920 },
    durationFrames: 300,
    subtitlePresetId: 'kinetic',
    elements: [],
    subtitleAnchor: {
      fps: PLAN_FPS,
      cues: [{ id: 'cue-final-1', startFrame: 0, endFrame: 60 }],
      faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' },
    },
    ...overrides,
  })
}

function serveSource(dependencies, change) {
  const source = approvedSource()
  const changed = Object.freeze({ ...source, ...change(source) })
  dependencies.projects.readImmutableApprovedSource = async () => changed
  return changed
}

function captureAttempts(dependencies) {
  const recorded = []
  const original = dependencies.projects.recordAttempt
  dependencies.projects.recordAttempt = async (input) => {
    recorded.push(input)
    await original(input)
  }
  return recorded
}

test('final export worker hands the renderer the placement plan its captions require, on the OutputSpec canvas', async () => {
  const operations = createOperations()
  const { calls, renderInputs, renderErrors, dependencies } = workerDependencies(operations)
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-captions')

  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'succeeded' }, JSON.stringify({ renderErrors, error: operations.operation.error ?? null }))
  assert.equal(calls.rendered, 1)
  const [input] = renderInputs
  assert.deepEqual(input.subtitleCues.map((cue) => cue.id), ['cue-final-1'])
  assert.doesNotThrow(() => validateRenderPlacementPlan(input.placementPlan))
  assert.equal(input.placementPlan.schemaVersion, 'render-placement-plan/v2')
  assert.equal(input.placementPlan.format, input.format)
  assert.deepEqual(input.placementPlan.canvas, { width: input.outputSpec.width, height: input.outputSpec.height })
  assert.equal(input.placementPlan.durationFrames, 300)
  assert.equal(input.placementPlan.subtitleAnchorPlan.schemaVersion, 'subtitle-anchor-plan/v2')
  // Built here straight from the domain, not through the worker: the plan is content-addressed, so
  // an identical hash means the worker derived exactly the plan the proxy path derives.
  assert.equal(input.placementPlan.placementPlanHash, expectedPlacementPlan().placementPlanHash)
  assert.equal(input.reframePlan, undefined)
  assert.equal(input.ctaOverlays, undefined)
})

test('final export worker draws the CTA overlays the approved proxy drew and plans them into the placement', async () => {
  const operations = createOperations()
  const { renderInputs, dependencies } = workerDependencies(operations)
  const cta = Object.freeze({ id: 'cta-final-1', kind: 'cta', startFrame: 120, endFrame: 240, text: 'Quero saber mais' })
  serveSource(dependencies, (source) => ({ editPlan: Object.freeze({ ...source.editPlan, overlayTracks: Object.freeze([cta]) }) }))
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-cta')

  assert.equal(outcome.status, 'succeeded', JSON.stringify(operations.operation.error ?? null))
  const [input] = renderInputs
  assert.deepEqual(input.ctaOverlays, [cta])
  assert.deepEqual(input.placementPlan.placements.filter((placement) => placement.kind === 'cta')
    .map((placement) => ({ elementId: placement.elementId, timeRange: placement.timeRange })),
  [{ elementId: 'cta-0-cta-final-1', timeRange: { startFrame: 120, endFrame: 240 } }])
  assert.equal(input.placementPlan.placementPlanHash, expectedPlacementPlan({
    elements: [{
      id: 'cta-0-cta-final-1', kind: 'cta', anchor: 'auto', priority: 80, readingOrder: 0,
      minWidth: 0.1, maxWidth: 0.9, minHeight: 0.05, maxHeight: 0.5, timeRange: { startFrame: 120, endFrame: 240 },
    }],
  }).placementPlanHash)
})

test('final export worker keeps a disabled subtitle style disabled, exactly as the proxy does', async () => {
  const operations = createOperations()
  const { calls, renderInputs, dependencies } = workerDependencies(operations)
  serveSource(dependencies, () => ({
    subtitleResolution: Object.freeze({
      presetId: 'kinetic', presetHash: subtitlePresetHash('kinetic'),
      registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: false,
    }),
  }))
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-style-disabled')

  assert.equal(outcome.status, 'succeeded', JSON.stringify(operations.operation.error ?? null))
  assert.equal(calls.rendered, 1)
  assert.deepEqual(renderInputs[0].subtitleCues, [])
  assert.equal(renderInputs[0].placementPlan.subtitleAnchorPlan, null)
})

test('final export worker forwards the persisted reframe plan of the exported Version', async () => {
  const reframeFor = (durationFrames) => createRenderReframePlan({
    format: '9:16', variantId: '9:16', fps: 30, durationFrames, source: { width: 1920, height: 1080 },
    ranges: [{
      clipId: 'clip-final-1', startFrame: 0, endFrame: durationFrames, interpolation: 'hold',
      keyframes: [{ frame: 0, crop: { x: 0.3, y: 0, width: 0.31640625, height: 1 } }],
    }],
  })
  const operations = createOperations()
  const { renderInputs, dependencies } = workerDependencies(operations)
  const reframePlan = reframeFor(300)
  serveSource(dependencies, () => ({ reframePlan }))
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-reframe')

  assert.equal(outcome.status, 'succeeded', JSON.stringify(operations.operation.error ?? null))
  assert.equal(renderInputs[0].reframePlan.reframePlanHash, reframePlan.reframePlanHash)

  const mismatched = createOperations()
  const refused = workerDependencies(mismatched)
  serveSource(refused.dependencies, () => ({ reframePlan: reframeFor(299) }))
  const refusedOutcome = await runNextProjectFinalExportOperationService(refused.dependencies)('worker-final-export-reframe-mismatch')
  assert.equal(refusedOutcome.status, 'failed')
  assert.equal(refused.calls.rendered, 0)
  assert.equal(mismatched.operation.error.code, 'invalid_render_input')
})

test('final export worker fails closed, without rendering, when the caption review plan cannot be derived', async (t) => {
  const cue = (id, startFrame) => Object.freeze({ id, startFrame, endFrame: startFrame + 60, text: 'Legenda final segura', anchor: 'bottom' })
  const cases = [
    ['captions persisted under two different presets', (source) => ({ editPlan: Object.freeze({
      ...source.editPlan,
      subtitleTracks: Object.freeze([
        { presetId: 'kinetic', cues: Object.freeze([cue('cue-final-1', 0)]) },
        { presetId: 'caps-stroke', cues: Object.freeze([cue('cue-final-2', 60)]) },
      ]),
    }) })],
    ['a plan that no longer states its duration', (source) => ({ editPlan: Object.freeze({ ...source.editPlan, durationFrames: undefined }) })],
  ]
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const operations = createOperations()
      const { calls, renderInputs, dependencies } = workerDependencies(operations)
      const attempts = captureAttempts(dependencies)
      serveSource(dependencies, change)
      const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-underivable')

      // Not retryable, never rendered, and never rendered "without its captions" either.
      assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
      assert.equal(calls.rendered, 0)
      assert.equal(renderInputs.length, 0)
      assert.equal(calls.persisted, 0)
      assert.equal(calls.attached, 0)
      assert.equal(calls.failed, 1)
      assert.equal(operations.operation.status, 'failed')
      assert.equal(operations.operation.error.code, 'invalid_render_input')
      assert.equal(attempts.length, 1)
      assert.equal(attempts[0].status, 'failed')
      assert.equal(attempts[0].error.stage, 'input-validation')
      assert.equal(attempts[0].error.code, 'invalid_render_input')
    })
  }
})

test('the renderer admission gate still refuses captions that arrive without their review plan', () => {
  const subtitleCues = [{ id: 'cue-final-1', startFrame: 0, endFrame: 60, text: 'Legenda final segura', anchor: 'bottom' }]
  assert.throws(
    () => assertRenderedSubtitleCuesAreReviewed({ subtitleCues, format: '9:16', fps: 30 }, 300),
    (error) => error instanceof DomainError && error.code === 'INVALID_RENDER_INPUT' &&
      error.message === 'Rendered subtitle cues require a complete unknown-face review plan',
  )
  assert.throws(
    () => assertRenderedSubtitleCuesAreReviewed({ subtitleCues, format: '9:16', fps: 30, placementPlan: expectedPlacementPlan({ durationFrames: 301 }) }, 300),
    (error) => error instanceof DomainError && error.code === 'INVALID_RENDER_INPUT',
  )
  assert.doesNotThrow(() => assertRenderedSubtitleCuesAreReviewed({ subtitleCues, format: '9:16', fps: 30, placementPlan: expectedPlacementPlan() }, 300))
  assert.doesNotThrow(() => assertRenderedSubtitleCuesAreReviewed({ format: '9:16', fps: 30 }, 300))
})

// ---------------------------------------------------------------------------
// Slice S3 - the final export consumes ONE persisted verdict (`final`) and seals it into its input hash.
// ---------------------------------------------------------------------------

const sealedOtherwise = [
  ['a newer State (the head moved to a newer Version)', { projectVersionId: 'project-version-newer', projectVersionHash: '5'.repeat(64),
    outputStateId: 'state-of-newer-version', outputStateHash: '6'.repeat(64) }],
  ['another variant revision (the output was revised)', { outputSpecRevisionId: 'revision-variant-main-revised', specHash: '7'.repeat(64) }],
  ['another materialization of the same revision', { materializationId: 'materialization-variant-main-other', materializationHash: '8'.repeat(64) }],
]

test('S3 final export enqueue seals the persisted final verdict into the input hash: another State, revision or materialization is another input', async () => {
  const hashes = new Set()
  for (const [label, patch] of [['the sealed State itself', {}], ...sealedOtherwise]) {
    const source = withConsumption(approvedSource(), alteredConsumption(approvedSource().outputConsumption, patch))
    let created
    const enqueue = enqueueProjectFinalExportService({
      projects: { async readApprovedCurrentSource() { return source } },
      rights: { async findCurrent() { return { snapshot: rightsSnapshot(), revision: 'revision-1' } } },
      operations: { async findReplay() { return null }, async createOrReplay(input) { created = input; return { ...input, replayed: false } } },
      colorPipelines,
      clock: () => new Date('2026-07-19T01:05:00.000Z'),
      createId: (kind) => `${kind}-final-export-seal`,
    })
    await enqueue({ workspaceId, projectId, projectVersionId, projectVersionHash: '1'.repeat(64), format: '9:16',
      approval: { approved: true }, actor: exportActor(), idempotencyKey: `final-export-seal-${hashes.size}` })
    assert.equal(created.context.inputHash, finalInputHash(true, source), `${label}: the input hash is the independently computed one`)
    assert.equal(source.outputConsumption.seal.purpose, 'final')
    hashes.add(created.context.inputHash)
  }
  assert.equal(hashes.size, 4, 'each sealed State/revision/materialization addresses a distinct final input')
})

test('S3 final export enqueue publishes the refusal of the final verdict and allocates nothing', async () => {
  for (const reason of ['derived-source-perception-authority-required', 'copy-requires-editorial-cut']) {
    const enqueue = enqueueProjectFinalExportService({
      projects: { async readApprovedCurrentSource() {
        throw new DomainError('PRECONDITION_REQUIRED', 'Output is not consumable for this purpose', { reason, purpose: 'final' })
      } },
      rights: { async findCurrent() { throw new Error('rights must not be read for a refused verdict') } },
      operations: { async findReplay() { throw new Error('must not look for a replay') } },
      colorPipelines,
      clock: () => new Date('2026-07-19T01:05:00.000Z'),
      createId() { throw new Error('must not allocate') },
    })
    await assert.rejects(() => enqueue({ workspaceId, projectId, projectVersionId, projectVersionHash: '1'.repeat(64), format: '9:16',
      approval: { approved: true }, actor: exportActor(), idempotencyKey: `final-export-refused-${reason}` }),
    (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.reason === reason)
  }
})

test('S3 final export worker refuses an operation sealed to another State, variant revision or materialization before it renders anything', async () => {
  for (const [label, patch] of sealedOtherwise) {
    const operations = createOperations()
    const { calls, renderInputs, dependencies } = workerDependencies(operations)
    serveSource(dependencies, (source) => ({ outputConsumption: alteredConsumption(source.outputConsumption, patch) }))
    const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-sealed-otherwise')
    assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' }, label)
    assert.equal(operations.operation.error.code, 'invalid_render_input', label)
    assert.deepEqual([calls.rendered, renderInputs.length, calls.persisted, calls.attached, calls.cataloged], [0, 0, 0, 0, 0], `${label}: nothing rendered, nothing published`)
    assert.equal(calls.failed, 1, label)
  }
})

test('S3 final export worker refuses tampered source bytes (another sha256 than the one the operation sealed) before it renders anything', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  serveSource(dependencies, (source) => ({
    sourceSha256: 'e'.repeat(64),
    renderSources: Object.freeze([Object.freeze({ ...source.renderSources[0], sha256: 'e'.repeat(64) })]),
  }))
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-tampered-bytes')
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
  assert.equal(operations.operation.error.code, 'invalid_render_input')
  assert.deepEqual([calls.rendered, calls.persisted, calls.attached], [0, 0, 0])
})

test('S3 final export worker refuses rights revoked after enqueue before it renders anything', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations, () => null)
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-rights-revoked-at-start')
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
  assert.equal(operations.operation.error.code, 'asset_rights_blocked')
  assert.deepEqual([calls.rendered, calls.persisted, calls.attached], [0, 0, 0])
})

test('S3 the final repository reads the source through the final verdict BEFORE any approval: a cut copy and a copy never cut are refused with their published reasons', async () => {
  const version = { id: projectVersionId, baseHash: '1'.repeat(64) }
  for (const [label, entries, sourceDependencies, reason] of [
    ['a cut copy (editorial-derived, fork lineage)', [{ variantId: 'variant-copy', aspectRatio: '9:16', derived: true }],
      { forkDerivationId: 'derivation-1' }, 'derived-source-perception-authority-required'],
    ['a copy never cut (the fork target materialization is still required)', [{ variantId: 'variant-copy', aspectRatio: '9:16',
      blockedReasons: ['fork-target-materialization-required'] }], { forkDerivationId: 'derivation-1' }, 'copy-requires-editorial-cut'],
  ]) {
    const world = fakeOutputWorld({ workspaceId, projectId, versionId: projectVersionId, baseHash: version.baseHash, entries, sourceDependencies })
    const reads = []
    const repository = new PrismaProjectFinalExportRepository({
      $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
      v2Project: { async findFirst(query) {
        reads.push(Object.keys(query.select ?? query.include ?? {}))
        return { id: projectId, workspaceId, locale: 'pt-BR', currentVersionId: projectVersionId, versions: [version], mediaAssets: [] }
      } },
    })
    const refusal = (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' &&
      error.details.reason === reason && error.details.purpose === 'final'
    await assert.rejects(repository.readApprovedCurrentSource({ workspaceId, projectId, projectVersionId, projectVersionHash: version.baseHash }), refusal, label)
    await assert.rejects(repository.readImmutableApprovedSource({ workspaceId, projectId, projectVersionId, projectVersionHash: version.baseHash,
      editPlanSnapshotId: 'snapshot-edit-plan-final-test', directorRunId: 'director-run-final-export-test',
      qualitySnapshotId: 'quality-snapshot-final-export-test', qualitySnapshotHash: '3'.repeat(64),
      proxyReviewId: 'proxy-review-final-export-test', proxyReviewHash: '7'.repeat(64), proxyArtifactId: 'artifact-proxy-final-export-test',
      sourceArtifactId, sourceManifestId }), refusal, label)
    assert.equal(reads.length, 2, `${label}: only the source project was read (once per call), never the approval (DirectorRun, QualityReport, proxy review)`)
    assert.ok(reads.every((keys) => !keys.includes('directorRuns') && !keys.includes('proxyReviews')), label)
    assert.ok(world.sql.every((text) => text.includes('FROM project_versions v LEFT JOIN project_output_states s')), `${label}: the light reader only, never the audit rebuild`)
  }
})

test('S3 final export worker reads the exact Version with the head fence on, so a head that moved is refused before anything renders', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  const asked = []
  dependencies.projects.readImmutableApprovedSource = async (input) => {
    asked.push(input)
    throw new DomainError('PERSISTENCE_CONFLICT', 'The sealed Version is no longer the current Version of the project')
  }
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-head-moved')
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].requireCurrent, true)
  assert.equal(operations.operation.error.code, 'persistence_conflict')
  assert.deepEqual([calls.rendered, calls.persisted, calls.attached], [0, 0, 0])
})

test('S3 the final repository forwards the head fence: a Version that is no longer the head is a persistence conflict, never a source', async () => {
  const version = { id: projectVersionId, baseHash: '1'.repeat(64) }
  const world = fakeOutputWorld({ workspaceId, projectId, versionId: projectVersionId, baseHash: version.baseHash })
  const repository = new PrismaProjectFinalExportRepository({
    $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
    v2Project: { async findFirst() {
      return { id: projectId, workspaceId, locale: 'pt-BR', currentVersionId: 'project-version-newer-head', versions: [version], mediaAssets: [] }
    } },
  })
  await assert.rejects(repository.readImmutableApprovedSource({ workspaceId, projectId, projectVersionId, projectVersionHash: version.baseHash,
    editPlanSnapshotId: 'snapshot-edit-plan-final-test', directorRunId: 'director-run-final-export-test',
    qualitySnapshotId: 'quality-snapshot-final-export-test', qualitySnapshotHash: '3'.repeat(64),
    proxyReviewId: 'proxy-review-final-export-test', proxyReviewHash: '7'.repeat(64), proxyArtifactId: 'artifact-proxy-final-export-test',
    sourceArtifactId, sourceManifestId, requireCurrent: true }),
  (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT' && /no longer the current Version/.test(error.message))
})

test('S3 final export threads an optional State variant to the final verdict (enqueue, repository, worker) and says nothing when it is absent', async () => {
  const asked = []
  const enqueue = (variantId, key) => enqueueProjectFinalExportService({
    projects: { async readApprovedCurrentSource(input) { asked.push(input); return approvedSource() } },
    rights: { async findCurrent() { return { snapshot: rightsSnapshot(), revision: 'revision-1' } } },
    operations: { async findReplay() { return null }, async createOrReplay(input) { return { ...input, replayed: false } } },
    colorPipelines,
    clock: () => new Date('2026-07-19T01:05:00.000Z'),
    createId: (kind) => `${kind}-final-export-variant`,
  })({ workspaceId, projectId, projectVersionId, projectVersionHash: '1'.repeat(64), format: '9:16', approval: { approved: true },
    actor: exportActor(), idempotencyKey: key, ...(variantId === undefined ? {} : { variantId }) })
  await enqueue(undefined, 'final-variant-absent')
  await enqueue('variant-tall', 'final-variant-present')
  assert.deepEqual(asked, [
    { workspaceId, projectId, projectVersionId, projectVersionHash: '1'.repeat(64) },
    { workspaceId, projectId, projectVersionId, projectVersionHash: '1'.repeat(64), variantId: 'variant-tall' },
  ])
  await assert.rejects(enqueue('x', 'final-variant-invalid'), (error) => error.code === 'INVALID_ARGUMENT')

  // The repository: a State with two outputs is refused without a variant, and consumed with one (before any approval is read).
  const version = { id: projectVersionId, baseHash: '1'.repeat(64) }
  const world = fakeOutputWorld({ workspaceId, projectId, versionId: projectVersionId, baseHash: version.baseHash, entries: [
    { variantId: 'variant-wide', aspectRatio: '16:9' }, { variantId: 'variant-tall', aspectRatio: '9:16', derived: true }],
  sourceDependencies: { forkDerivationId: 'derivation-1' } })
  const repository = new PrismaProjectFinalExportRepository({
    $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
    v2Project: { async findFirst() { return { id: projectId, workspaceId, locale: 'pt-BR', currentVersionId: projectVersionId, versions: [version], mediaAssets: [] } } },
  })
  const at = { workspaceId, projectId, projectVersionId, projectVersionHash: version.baseHash }
  await assert.rejects(repository.readApprovedCurrentSource(at), (error) => error.details?.reason === 'output-variant-required' && error.details?.purpose === 'final')
  // variant-tall is a cut copy (editorial-derived with fork lineage): its final is blocked by the same verdict; variant-wide passes the verdict
  // and goes on to the approval lookup (no media in this fake, so it is not a source).
  await assert.rejects(repository.readApprovedCurrentSource({ ...at, variantId: 'variant-tall' }),
    (error) => error.details?.reason === 'derived-source-perception-authority-required')

  // The worker reads through the variant a later step persists in the context (none today).
  for (const [contextOverride, expected] of [[{}, undefined], [{ variantId: 'variant-tall' }, 'variant-tall']]) {
    const operations = createOperations()
    const { dependencies } = workerDependencies(operations)
    const workerAsked = []
    const original = operations.repository.claimNext
    operations.repository.claimNext = async (input) => { const claimed = await original(input); return { ...claimed, context: { ...claimed.context, ...contextOverride } } }
    dependencies.projects.readImmutableApprovedSource = async (input) => { workerAsked.push(input); return approvedSource() }
    await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-variant')
    assert.equal(workerAsked[0].variantId, expected)
    assert.equal('variantId' in workerAsked[0], expected !== undefined)
  }
})
