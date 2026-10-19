import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { enqueueProjectFinalExportService } from '../../src/v2/application/enqueue-project-final-export.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { projectRenderSourcesFingerprint } from '../../src/v2/application/project-render-sources.ts'
import { planCaptionPlacement } from '../../src/v2/application/plan-caption-placement.ts'
import { runNextProjectFinalExportOperationService } from '../../src/v2/application/run-project-final-export-worker.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { ASS_EMISSION_POLICY } from '../../src/v2/domain/ass-emission-policy.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { FINAL_CAPTION_CERTIFICATION_POLICY_SHA256 } from '../../src/v2/domain/final-caption-certification.ts'
import { artifactOutputStoragePrefix } from '../../src/v2/domain/artifact-storage-identity.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createRenderPlacementPlan, validateRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { createQualityReport, resolveStrategicRubric } from '../../src/v2/domain/strategic-rubric.ts'
import { SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } from '../../src/v2/domain/subtitle-system.ts'
import { parseFinalExportQuality, PrismaProjectFinalExportRepository } from '../../src/v2/infrastructure/prisma/project-final-export-repository.ts'
import { requirePersistedOutputConsumptionV3 } from '../../src/v2/infrastructure/prisma/output-state-consumption.ts'
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
  // The approving proxy review is the one rendered for the exported output: the repository attributes a review through the sealed State.
  const approvalWorld = fakeOutputWorld({ workspaceId, projectId: 'project-controlled', versionId: 'result-version', entries: [{ variantId: 'variant-controlled', aspectRatio: '9:16' }] })
  const repository = new PrismaProjectFinalExportRepository({
    $queryRawUnsafe: (...args) => approvalWorld.queryRawUnsafe(...args),
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
    projectVersionHash: 'b'.repeat(64), outputSpecId: 'output-spec-controlled', outputVariantId: 'variant-controlled', requireCurrent: true }
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
      durationFrames: 300,
      movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
      // A Director plan always carries its captions with their persisted preset, which is what
      // makes the renderer demand the caption review plan for them.
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
      // Observed dimensions: with them the caption planner can project the picture onto the 9:16 canvas, where the bottom band
      // lies over the blurred copy and is certified by geometry (W65). Without them the cue would be review-required.
      probe: Object.freeze({ width: 1280, height: 720 }),
    })]),
    originalFileName: 'gravacao-bruta.mp4',
  })
}

function finalInputHash(includePolicy = true, source = approvedSource(), captionPolicySha256 = FINAL_CAPTION_CERTIFICATION_POLICY_SHA256) {
  return calculateVersionHash({
    kind: 'project-final-export/v2',
    ...(includePolicy ? { assEmissionPolicy: ASS_EMISSION_POLICY } : {}),
    ...(captionPolicySha256 ? { captionCertificationPolicySha256: captionPolicySha256 } : {}),
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
  // W65b: the C1 pixel critic. By default it measures and finds every caption where the plan put it; a test overrides `verdict`.
  const critic = {
    requests: [],
    verdict: () => ({ issues: [], samples: [], measurement: 'completed' }),
    async verify(request) { critic.requests.push(request); return critic.verdict(request) },
  }
  return {
    calls,
    renderInputs,
    renderErrors,
    critic,
    dependencies: {
      captionPixelCritic: critic,
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

  assert.deepEqual(calls, { rights: 2, rendered: 1, persisted: 1, mapped: 1, converged: 0, attached: 1, attempts: 1, failed: 0, cleaned: 2, lutCleaned: 1, cataloged: 1 })
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
  assert.deepEqual(calls, { rights: 2, rendered: 1, persisted: 0, mapped: 0, converged: 0, attached: 0, attempts: 1, failed: 1, cleaned: 2, lutCleaned: 1, cataloged: 0 })
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

/**
 * The placement the worker must have derived, computed here straight from the caption planner (domain + application, not through the
 * worker): the plan is content-addressed, so an identical hash means the worker derived exactly what the proxy path derives.
 */
async function plannedFinalPlacement({ placementElements = [] } = {}) {
  const source = approvedSource()
  const { placementPlan } = await planCaptionPlacement({ clock: () => new Date('2026-07-19T01:06:00.000Z') }, {
    workspaceId, projectId, format: '9:16', canvas: { width: 1080, height: 1920 },
    editPlan: { fps: source.editPlan.fps, durationFrames: source.editPlan.durationFrames },
    clips: source.editPlan.videoTracks[0].clips,
    renderSources: source.renderSources.map((asset) => ({ artifactId: asset.artifactId, sha256: asset.sha256, mediaType: asset.mediaType, probe: asset.probe })),
    subtitleCues: [{ id: 'cue-final-1', startFrame: 0, endFrame: 60 }], subtitlePresetId: 'kinetic', placementElements,
    primarySourceArtifactId: source.sourceArtifactId, uncertifiedCues: 'omit-and-list',
  })
  return placementPlan
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
  assert.equal(input.placementPlan.schemaVersion, 'render-placement-plan/v3')
  assert.equal(input.placementPlan.format, input.format)
  assert.deepEqual(input.placementPlan.canvas, { width: input.outputSpec.width, height: input.outputSpec.height })
  assert.equal(input.placementPlan.durationFrames, 300)
  assert.equal(input.placementPlan.subtitleAnchorPlan.schemaVersion, 'subtitle-anchor-plan/v3')
  assert.equal(input.placementPlan.placementPlanHash, (await plannedFinalPlacement()).placementPlanHash)
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
  assert.equal(input.placementPlan.placementPlanHash, (await plannedFinalPlacement({
    placementElements: [{
      id: 'cta-0-cta-final-1', kind: 'cta', anchor: 'auto', priority: 80, readingOrder: 0,
      minWidth: 0.1, maxWidth: 0.9, minHeight: 0.05, maxHeight: 0.5, timeRange: { startFrame: 120, endFrame: 240 },
    }],
  })).placementPlanHash)
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

  // The worker reads through the variant its operation persisted (`outputVariantId`); a legacy context names none.
  for (const [contextOverride, expected] of [[{}, undefined], [{ outputVariantId: 'variant-main' }, 'variant-main']]) {
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

// ---------------------------------------------------------------------------
// Slice S3 multi-output - the final export resolves ONE output explicitly and persists which output it was made for.
// ---------------------------------------------------------------------------

const moOutputs = [{ variantId: 'variant-wide', aspectRatio: '16:9' }, { variantId: 'variant-tall', aspectRatio: '9:16' }]
const moWorld = (entries = moOutputs) => fakeOutputWorld({ workspaceId, projectId, versionId: projectVersionId, baseHash: '1'.repeat(64), entries })
// The verdict publishes its purpose with every refusal except an unknown variant (which is a fact about the request, not the purpose).
const moRefusal = (reason) => (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' &&
  error.details.reason === reason && (reason === 'output-variant-unknown' || error.details.purpose === 'final')

/** The source a repository answers for one output: the verdict is the REAL persisted `final` one, read from the sealed rows of the world. */
async function moFinalSource(world, variantId) {
  const consumption = await requirePersistedOutputConsumptionV3({ $queryRawUnsafe: world.queryRawUnsafe },
    { workspaceId, projectId, versionId: projectVersionId, purpose: 'final', ...(variantId === undefined ? {} : { variantId }) })
  return Object.freeze({ ...approvedSource(), format: consumption.aspectRatio,
    outputConsumption: Object.freeze({ seal: consumption.seal, sealHash: consumption.sealHash }) })
}

test('S3-MO final export resolves ONE output explicitly: none named, a stranger, a format that is not the output and two outputs of one ratio are refused; each output persists its own variant and spec', async () => {
  const persisted = []
  const enqueueOn = (world) => (variantId, format, key) => enqueueProjectFinalExportService({
    projects: { readApprovedCurrentSource: (input) => moFinalSource(world, input.variantId) },
    rights: { async findCurrent() { return { snapshot: rightsSnapshot(), revision: 'revision-1' } } },
    operations: { async findReplay() { return null }, async createOrReplay(input) { persisted.push(input); return { ...input, replayed: false } } },
    colorPipelines,
    clock: () => new Date('2026-07-19T01:05:00.000Z'),
    createId: (kind) => `${kind}-final-mo-${persisted.length}`,
  })({ workspaceId, projectId, projectVersionId, projectVersionHash: '1'.repeat(64), format, approval: { approved: true },
    actor: exportActor(), idempotencyKey: key, ...(variantId === undefined ? {} : { variantId }) })
  const enqueue = enqueueOn(moWorld())
  await assert.rejects(enqueue(undefined, '9:16', 'final-mo-none'), moRefusal('output-variant-required'),
    'a format alone never selects the output of a project with several')
  await assert.rejects(enqueue('variant-stranger', '9:16', 'final-mo-stranger'), moRefusal('output-variant-unknown'))
  await assert.rejects(enqueue('variant-wide', '9:16', 'final-mo-format'), (error) => error instanceof DomainError && error.code === 'INVALID_OUTPUT_SPEC',
    'the format must be the aspect ratio of the output named')
  assert.equal(persisted.length, 0, 'a refused enqueue admits nothing')

  await enqueue('variant-wide', '16:9', 'final-mo-wide')
  await enqueue('variant-tall', '9:16', 'final-mo-tall')
  const [wide, tall] = persisted
  assert.equal(wide.context.outputVariantId, 'variant-wide')
  assert.equal(tall.context.outputVariantId, 'variant-tall')
  assert.equal(wide.context.outputSpec.aspectRatio, '16:9')
  assert.equal(tall.context.outputSpec.aspectRatio, '9:16')
  assert.notEqual(wide.context.inputHash, tall.context.inputHash, 'each output is its own input')
  assert.equal(tall.context.inputHash, finalInputHash(true, await moFinalSource(moWorld(), 'variant-tall')), 'the 9:16 hash is the one over its own sealed entry')
  assert.equal(wide.context.outputSpec.width, 1920)
  assert.equal(tall.context.outputSpec.width, 1080)

  persisted.length = 0
  const clash = enqueueOn(moWorld([{ variantId: 'variant-a', aspectRatio: '9:16' }, { variantId: 'variant-b', aspectRatio: '9:16' }]))
  await assert.rejects(clash('variant-a', '9:16', 'final-mo-clash'), moRefusal('output-variant-ambiguous'))
  assert.equal(persisted.length, 0)

  await enqueueOn(moWorld([{ variantId: 'variant-solo', aspectRatio: '9:16' }]))(undefined, '9:16', 'final-mo-solo')
  assert.equal(persisted[0].context.outputVariantId, 'variant-solo', 'one output: the variant is optional and the same row is persisted')
})

test('S3-MO the approval of a final export is the proxy review of THAT output: the lookup is filtered by the render the review belongs to', async () => {
  const lookups = []
  const repositoryOn = (world) => new PrismaProjectFinalExportRepository({
    $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
    v2Project: { async findFirst(query) {
      lookups.push(query.select.proxyReviews.where)
      return { locale: 'pt-BR', versions: [{ id: projectVersionId }], directorRuns: [], proxyReviews: [] }
    } },
  })
  const request = { workspaceId, projectId, projectVersionId, projectVersionHash: '1'.repeat(64), outputSpecId: 'output-spec-mo', requireCurrent: true }
  assert.equal(await repositoryOn(moWorld()).readApproval({ ...request, outputVariantId: 'variant-tall' }), null)
  assert.equal(await repositoryOn(moWorld()).readApproval({ ...request, outputVariantId: 'variant-wide' }), null)
  assert.deepEqual(lookups.map((where) => where.operation), [{ outputVariantId: 'variant-tall' }, { outputVariantId: 'variant-wide' }],
    'with several outputs only a review rendered for this very output approves it')
  lookups.length = 0
  await repositoryOn(moWorld([{ variantId: 'variant-solo', aspectRatio: '9:16' }])).readApproval({ ...request, outputVariantId: 'variant-solo' })
  assert.deepEqual(lookups[0].operation, { OR: [{ outputVariantId: 'variant-solo' }, { outputVariantId: null }] },
    'one output: a review rendered before the output was recorded is still its own')
  lookups.length = 0
  await repositoryOn(moWorld([{ variantId: 'variant-solo', aspectRatio: '9:16' }])).readApproval({ ...request, outputVariantId: 'variant-stranger' })
  assert.deepEqual(lookups[0].operation, { outputVariantId: 'variant-stranger' }, 'a legacy review is never attributed to an output the Version does not have alone')
})

test('S3-MO the final repository names the output of a format (an export matrix cell) without a guess, and refuses two outputs of one ratio', async () => {
  const repositoryOn = (world) => new PrismaProjectFinalExportRepository({ $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args) })
  const at = { workspaceId, projectId, projectVersionId }
  const repository = repositoryOn(moWorld())
  assert.equal(await repository.resolveOutputVariantByFormat({ ...at, format: '16:9' }), 'variant-wide')
  assert.equal(await repository.resolveOutputVariantByFormat({ ...at, format: '9:16' }), 'variant-tall')
  assert.equal(await repository.resolveOutputVariantByFormat({ ...at, format: '1:1' }), null, 'no output of that format: nothing to export')
  await assert.rejects(repositoryOn(moWorld([{ variantId: 'variant-a', aspectRatio: '9:16' }, { variantId: 'variant-b', aspectRatio: '9:16' }]))
    .resolveOutputVariantByFormat({ ...at, format: '9:16' }), (error) => error.details?.reason === 'output-variant-ambiguous')
  assert.equal(await repository.resolveOutputVariantByFormat({ ...at, projectVersionId: 'project-version-unknown', format: '9:16' }), null)
})

test('S3-MO a completed final export resolves the invalidations of its own output, and a failed one never fails a project another output of the Version still owns', async () => {
  const operationRow = (patch = {}) => ({ operationId: 'operation-final-export-test', workspaceId, projectId, projectVersionId, outputArtifactId: 'artifact-final-output',
    outputManifestId: 'manifest-final-output', outputAspectRatio: '16:9', outputVariantId: 'variant-wide', ...patch })
  const run = async ({ row, world = moWorld() }) => {
    const seen = { invalidations: [], resolutions: 0, projectUpdates: 0 }
    const repository = new PrismaProjectFinalExportRepository({
      $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
      async $transaction(callback) {
        return callback({
          $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
          v2ProjectFinalExportOperation: { async findFirst() { return row } },
          v2MediaArtifact: { async findFirst() { return { id: 'artifact-final-output' } } },
          v2MediaArtifactManifest: { async findFirst() { return { id: 'manifest-final-output' } } },
          v2ProjectMediaAsset: { async upsert() {} },
          v2CommandArtifactInvalidation: { async findMany(query) { seen.invalidations.push(query.where.variantId); return [{ id: 'invalidation-1' }] } },
          v2CommandArtifactInvalidationResolution: { async upsert() { seen.resolutions += 1 } },
          v2Project: { async updateMany() { seen.projectUpdates += 1; return { count: 1 } } },
        })
      },
    })
    await repository.attachCompletedOutput({ workspaceId, operationId: 'operation-final-export-test', projectId, projectVersionId,
      outputArtifactId: 'artifact-final-output', outputManifestId: 'manifest-final-output', originalFileName: 'out.mp4', createdAt: '2026-07-19T01:06:00.000Z' })
    return seen
  }
  const stable = await run({ row: operationRow() })
  assert.deepEqual(stable.invalidations, ['variant-wide'], 'the invalidations are looked up by the STABLE variant, not by the aspect ratio')
  assert.equal(stable.resolutions, 1)
  const legacy = await run({ row: operationRow({ outputVariantId: null, outputAspectRatio: '9:16' }) })
  assert.deepEqual(legacy.invalidations, ['variant-tall'], 'a legacy row is attributed through the State by its ratio, when exactly one output has it')
  await assert.rejects(run({ row: operationRow({ outputVariantId: null, outputAspectRatio: '1:1' }) }), (error) => error.code === 'PERSISTENCE_CONFLICT',
    'a legacy row that no single output claims is not attributed to a guess')

  const failureOn = (siblings) => {
    const seen = { updates: 0 }
    const repository = new PrismaProjectFinalExportRepository({
      v2ProjectFinalExportOperation: { async findFirst() { return { projectVersionId } }, async count(query) {
        assert.deepEqual(query.where.operation, { status: { notIn: ['failed', 'canceled'] } })
        assert.deepEqual(query.where.operationId, { not: 'operation-final-export-test' })
        return siblings
      } },
      v2Project: { async updateMany() { seen.updates += 1; return { count: 1 } } },
    })
    return { seen, run: () => repository.markExportFailed({ workspaceId, operationId: 'operation-final-export-test', projectId }) }
  }
  const owned = failureOn(1)
  await owned.run()
  assert.equal(owned.seen.updates, 0, 'a sibling export of the Version is queued, running or done: the project keeps its status')
  const alone = failureOn(0)
  await alone.run()
  assert.equal(alone.seen.updates, 1, 'the only export of the Version failing fails the project, as it always did')
})

test('S3-MO a final worker refuses a source that is not the output its operation was approved for, before it renders or attaches anything', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  const original = operations.repository.claimNext
  operations.repository.claimNext = async (input) => { const claimed = await original(input); return { ...claimed, context: { ...claimed.context, outputVariantId: 'variant-tall' } } }
  // approvedSource() is sealed to the world's only output, 'variant-main'.
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-wrong-output')
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
  assert.equal(operations.operation.error.code, 'persistence_conflict')
  assert.deepEqual([calls.rendered, calls.persisted, calls.attached], [0, 0, 0])
})

test('W65 final worker decides its captions on the FINAL canvas and persists the placement its encode was decided with', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  let rendered = null, persisted = null
  const render = dependencies.renderer.render
  dependencies.renderer.render = async (input) => { rendered = input; return render(input) }
  const persist = dependencies.artifacts.persistOrReplay
  dependencies.artifacts.persistOrReplay = async (input) => { persisted = input; return persist(input) }
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-captions')
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'succeeded' })
  assert.equal(calls.rendered, 1)
  const plan = rendered.placementPlan
  assert.equal(plan.schemaVersion, 'render-placement-plan/v3')
  assert.deepEqual({ ...plan.canvas }, { width: 1080, height: 1920 })
  assert.equal(plan.subtitleAnchorPlan.schemaVersion, 'subtitle-anchor-plan/v3')
  const decision = plan.subtitleAnchorPlan.decisions[0]
  assert.equal(decision.cueId, 'cue-final-1'); assert.equal(decision.disposition, 'placed'); assert.equal(decision.anchor, 'bottom')
  assert.equal(plan.subtitleAnchorPlan.faceClearance.faceSafety, 'unknown')
  // the encode's placement is part of the RenderInput the final can be reconstructed from, and of its recipe identity
  const props = JSON.parse(persisted.renderInput.canonicalJson).props
  assert.equal(props.placementPlan.placementPlanHash, plan.placementPlanHash)
  const parameters = JSON.parse(persisted.recipeParameters.canonicalJson)
  assert.equal(parameters.placementPlanHash, plan.placementPlanHash)
  assert.equal(parameters.subtitleAnchorPlanHash, plan.subtitleAnchorPlan.anchorPlanHash)
})

// ---- W65b: the final-caption certification rule ----
const portraitMaster = (base = approvedSource()) => Object.freeze({
  ...base, renderSources: Object.freeze(base.renderSources.map((asset) => Object.freeze({ ...asset, probe: Object.freeze({ width: 720, height: 1280 }) }))),
})
function capture(dependencies) {
  const seen = { rendered: [], persisted: null, attempt: null }
  const render = dependencies.renderer.render
  dependencies.renderer.render = async (input) => { seen.rendered.push(input); return render(input) }
  const persist = dependencies.artifacts.persistOrReplay
  dependencies.artifacts.persistOrReplay = async (input) => { seen.persisted = input; return persist(input) }
  const record = dependencies.projects.recordAttempt
  dependencies.projects.recordAttempt = async (input) => { seen.attempt = input; return record(input) }
  return seen
}
const certificationValidator = (attempt) => attempt.validators.find((validator) => validator.code === 'FINAL_CAPTION_CERTIFICATION')
const hardPixelIssue = { code: 'CAPTION_PLACEMENT_MISMATCH', severity: 'hard', cueId: 'cue-final-1', evidenceRange: { startFrame: 10, endFrame: 11 },
  elementIds: ['subtitle:cue-final-1'], evidenceIds: [], message: 'The caption is outside the band the plan decided.' }

test('W65b a final burns a certified cue, confirms it in the delivered pixels and records the receipt it was admitted under', async () => {
  const operations = createOperations()
  const { calls, critic, dependencies } = workerDependencies(operations)
  const seen = capture(dependencies)
  let controlPath = null
  critic.verdict = async (request) => {
    controlPath = (await request.renderControl()).path
    return { issues: [], samples: [], measurement: 'completed' }
  }
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-certified')
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'succeeded' })
  // the pixel critic looked at THIS plan and THIS delivered file, with a caption-free control of the same encode
  assert.equal(critic.requests.length, 1)
  const [final, control] = seen.rendered
  assert.equal(critic.requests[0].plan.placementPlanHash, final.placementPlan.placementPlanHash)
  assert.equal(critic.requests[0].deliveredPath, join(tmpdir(), 'apollo-final-export-output.mp4'))
  assert.equal(seen.rendered.length, 2); assert.equal(calls.rendered, 2)
  assert.equal(control.operationId, 'operation-final-export-test-caption-control')
  assert.deepEqual(control.subtitleCues, []); assert.equal(control.renderKind, 'final')
  assert.equal(controlPath, join(tmpdir(), 'apollo-final-export-output.mp4'))
  // the receipt: what was burned and how its band was certified
  const parameters = JSON.parse(seen.persisted.recipeParameters.canonicalJson)
  assert.equal(seen.persisted.manifest.recipe.version, '1.14.0')
  assert.equal(parameters.captionCertificationPolicySha256, FINAL_CAPTION_CERTIFICATION_POLICY_SHA256)
  const receipt = parameters.captionCertification
  assert.equal(receipt.faceSafety, 'unknown')
  assert.equal(receipt.placementPlanHash, final.placementPlan.placementPlanHash)
  assert.deepEqual(receipt.burned.map((entry) => [entry.cueId, entry.anchor, entry.certification]), [['cue-final-1', 'bottom', 'geometry-outside-foreground']])
  assert.deepEqual(receipt.omitted, [])
  assert.equal(receipt.pixelCritic, 'ran')
  // and it is in the attempt record, where the caller reads it
  const validator = certificationValidator(seen.attempt)
  assert.equal(seen.attempt.status, 'promoted'); assert.equal(validator.passed, true)
  assert.match(validator.message, /1 caption\(s\) burned in certified bands/)
  assert.ok(validator.message.length <= 500)
})

test('W65b a cue that cannot be certified is omitted and listed: the final is delivered without it and nothing else is lost', async () => {
  const operations = createOperations()
  const { calls, critic, dependencies } = workerDependencies(operations)
  const seen = capture(dependencies)
  // a portrait master on the portrait canvas: every band is over the picture and no face window exists for it
  dependencies.projects.readImmutableApprovedSource = async () => portraitMaster()
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-omitted')
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'succeeded' })
  const plan = seen.rendered[0].placementPlan
  const decision = plan.subtitleAnchorPlan.decisions[0]
  assert.equal(decision.cueId, 'cue-final-1'); assert.equal(decision.anchor, null); assert.equal(decision.disposition, 'review-required')
  assert.deepEqual(plan.subtitleAnchorPlan.issues.map((issue) => [issue.code, issue.severity]), [['FACE_PERCEPTION_UNAVAILABLE', 'warning']])
  assert.equal(plan.subtitleAnchorPlan.policy.onNoSafeRegion, 'omit-and-list')
  // nothing was burned, so there is nothing to confirm: no control render, no critic
  assert.equal(critic.requests.length, 0); assert.equal(calls.rendered, 1)
  const receipt = JSON.parse(seen.persisted.recipeParameters.canonicalJson).captionCertification
  assert.deepEqual(receipt.burned, [])
  assert.deepEqual(receipt.omitted.map((entry) => [entry.cueId, entry.code, entry.disposition]), [['cue-final-1', 'FACE_PERCEPTION_UNAVAILABLE', 'review-required']])
  assert.equal(receipt.pixelCritic, 'not-needed'); assert.equal(receipt.faceSafety, 'unknown')
  const validator = certificationValidator(seen.attempt)
  assert.equal(validator.passed, true)
  assert.match(validator.message, /0 caption\(s\) burned.*1 omitted and listed for review: cue-final-1 \(FACE_PERCEPTION_UNAVAILABLE\)/)
  assert.equal(calls.persisted, 1); assert.equal(calls.attached, 1)
})

test('W65b a hard disagreement of the delivered pixels with the plan stops the final: it is not published', async () => {
  const operations = createOperations()
  const { calls, critic, dependencies } = workerDependencies(operations)
  const seen = capture(dependencies)
  critic.verdict = () => ({ issues: [hardPixelIssue], samples: [], measurement: 'completed' })
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-pixel-mismatch')
  assert.equal(outcome.status, 'failed')
  assert.equal(seen.attempt.status, 'failed')
  assert.equal(seen.attempt.error.code, 'render_output_invalid'); assert.equal(seen.attempt.error.stage, 'output-verification')
  const validator = certificationValidator(seen.attempt)
  assert.equal(validator.passed, false)
  assert.match(validator.message, /cue-final-1.*CAPTION_PLACEMENT_MISMATCH/)
  assert.equal(calls.persisted, 0); assert.equal(calls.attached, 0); assert.equal(calls.cataloged, 0)
})

test('W65b a pixel critic that could not measure, or that broke, never lets a caption through unconfirmed', async () => {
  for (const [label, verdict] of [
    ['measurement failed', () => ({ issues: [], samples: [], measurement: 'failed' })],
    ['no measurement field (an unknown critic)', () => ({ issues: [], samples: [] })],
    ['threw', () => { throw new Error('ffmpeg exploded') }],
  ]) {
    const operations = createOperations()
    const { calls, critic, dependencies } = workerDependencies(operations)
    const seen = capture(dependencies)
    critic.verdict = verdict
    const outcome = await runNextProjectFinalExportOperationService(dependencies)(`worker-final-export-critic-${label.length}`)
    assert.equal(outcome.status, 'failed', label)
    assert.match(certificationValidator(seen.attempt).message, /could not measure/, label)
    assert.equal(calls.persisted, 0, label); assert.equal(calls.attached, 0, label)
  }
})

test('W65b a final that would burn a caption is refused BEFORE the encode when no pixel critic is wired', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  const seen = capture(dependencies)
  delete dependencies.captionPixelCritic
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-no-critic')
  assert.equal(outcome.status, 'failed')
  assert.equal(seen.attempt.error.code, 'invalid_render_input'); assert.equal(seen.attempt.error.stage, 'input-validation')
  assert.equal(calls.rendered, 0); assert.equal(calls.persisted, 0); assert.equal(calls.attached, 0)
  // ... but a final that burns nothing does not need one
  const { dependencies: omitting } = workerDependencies(createOperations())
  delete omitting.captionPixelCritic
  omitting.projects.readImmutableApprovedSource = async () => portraitMaster()
  assert.equal((await runNextProjectFinalExportOperationService(omitting)('worker-final-export-no-critic-omitting')).status, 'succeeded')
})

test('W65b the certification policy is part of the pre-render identity: an operation queued under another policy is rejected before any render', async () => {
  for (const [label, hash] of [['another policy', finalInputHash(true, undefined, 'f'.repeat(64))], ['no policy', finalInputHash(true, undefined, null)]]) {
    const operations = createOperations(hash)
    const { calls, dependencies } = workerDependencies(operations)
    const outcome = await runNextProjectFinalExportOperationService(dependencies)(`worker-final-export-policy-${label.length}`)
    assert.equal(outcome.status, 'failed', label)
    assert.equal(operations.operation.error.code, 'invalid_render_input', label)
    assert.equal(calls.rendered, 0, label); assert.equal(calls.persisted, 0, label)
  }
  assert.notEqual(finalInputHash(true), finalInputHash(true, undefined, null))
})

// ---- the admission of the Director report (the gate nothing could pass) ----
function directorReport({ rights = true, ...overrides } = {}) {
  const rubric = resolveStrategicRubric('discovery')
  const evaluatedAt = '2026-10-08T00:00:00.000Z'
  const strategic = createQualityReport({ objective: 'discovery',
    evidence: rubric.criteria.map((criterion) => ({ criterionId: criterion.id, score: 100, evidence: [`controlled:${criterion.id}`] })),
    gates: { narrativeIntegrity: true, legibility: true, rights }, evaluatedAt })
  return { rubric, report: {
    schemaVersion: 'director-quality-report/v3', id: 'quality-controlled', desiredActionRef: { id: 'action-controlled' },
    status: rights ? 'review-required' : 'blocked', score: strategic.score / 100, strategic, issues: [], criticVersion: 'project-director-critic/v2', evaluatedAt,
    faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
    hardChecks: { openingMotionProtected: true, automaticZoomDisabled: true, subtitlesFaceSafe: false, subtitlesBounded: true,
      forbiddenSpeechAbsent: true, timelineContinuous: true },
    ...overrides,
  } }
}
function approvalRepository(report, rubric) {
  const observed = []
  // The merged repository attributes a legacy proxy review to the Version's only output through its sealed State.
  const world = fakeOutputWorld({ workspaceId, projectId: 'project-controlled', versionId: 'result-version', baseHash: 'b'.repeat(64) })
  const repository = new PrismaProjectFinalExportRepository({
    $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
    v2Project: { async findFirst() { return {
      locale: 'pt-BR', versions: [{ id: 'result-version' }],
      directorRuns: [{ id: 'director-run', baseVersionId: 'input-version', qualitySnapshotId: 'quality-snapshot', objective: 'discovery',
        rubricRef: `${rubric.id}/v${rubric.version}`,
        qualitySnapshot: { schemaVersion: 3, contentJson: JSON.stringify(report), contentHash: calculateVersionHash(report) } }],
      proxyReviews: [{ id: 'proxy-review', reviewHash: 'a'.repeat(64), proxyArtifactId: 'proxy-artifact' }],
    } } },
  })
  repository.perceptionEvidence = { async read(input) { observed.push(input); return null } }
  return { repository, observed, world, request: { workspaceId, projectId: 'project-controlled', projectVersionId: 'result-version',
    projectVersionHash: 'b'.repeat(64), outputSpecId: 'output-spec-controlled', outputVariantId: 'variant-main', requireCurrent: true } }
}

test('W65b the gate admits the Director report as the Director really produces it: review-required with an unknown face claim', async () => {
  const { rubric, report } = directorReport()
  const { repository, observed, request } = approvalRepository(report, rubric)
  const approval = await repository.readApproval(request)
  assert.ok(approval, 'the report that was unreachable before is admitted')
  assert.equal(approval.qualityStatus, 'review-required')
  assert.equal(approval.admissionBasis, 'per-cue-caption-certification')
  assert.equal(approval.proxyReviewId, 'proxy-review')
  assert.deepEqual(observed, [], 'no perception evidence is consulted: no face safety is being claimed')
})

test('W65b the gate still refuses everything the Director report does not honestly hold', async () => {
  const { rubric, report } = directorReport()
  const refuse = async (overrides, label) => {
    const { repository, request } = approvalRepository({ ...report, ...overrides }, rubric)
    assert.equal(await repository.readApproval(request), null, label)
  }
  await refuse({ hardChecks: { ...report.hardChecks, timelineContinuous: false } }, 'a hard check that failed')
  await refuse({ hardChecks: { ...report.hardChecks, subtitlesBounded: false } }, 'subtitles not bounded')
  await refuse({ issues: [{ code: 'STRATEGIC_RIGHTS_FAILED', severity: 'hard', category: 'policy', message: 'Rights failed.', correctable: true }] }, 'a hard issue')
  // a report whose strategic gate failed is `blocked` (the parser holds that invariant), and blocked is never admitted
  const failed = directorReport({ rights: false })
  assert.equal(failed.report.status, 'blocked')
  const { repository: blockedRepository, request: blockedRequest } = approvalRepository(failed.report, failed.rubric)
  assert.equal(await blockedRepository.readApproval(blockedRequest), null, 'blocked')
  // ... and a review-required report whose strategic gate did NOT pass is not even a readable report
  const forged = approvalRepository({ ...failed.report, status: 'review-required' }, failed.rubric)
  await assert.rejects(forged.repository.readApproval(forged.request), (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  const wrongRun = approvalRepository(report, rubric)
  const stale = new PrismaProjectFinalExportRepository({ $queryRawUnsafe: (...args) => wrongRun.world.queryRawUnsafe(...args), v2Project: { async findFirst() { return { locale: 'pt-BR', versions: [], directorRuns: [], proxyReviews: [] } } } })
  assert.equal(await stale.readApproval(wrongRun.request), null, 'no matching version, run or ready-for-final proxy review')
})
