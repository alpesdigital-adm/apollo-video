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
import { FINAL_CAPTION_CERTIFICATION_POLICY_SHA256 } from '../../src/v2/domain/final-caption-certification.ts'
import { artifactOutputStoragePrefix } from '../../src/v2/domain/artifact-storage-identity.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createQualityReport, resolveStrategicRubric } from '../../src/v2/domain/strategic-rubric.ts'
import { parseFinalExportQuality, PrismaProjectFinalExportRepository } from '../../src/v2/infrastructure/prisma/project-final-export-repository.ts'
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
      subtitleTracks: Object.freeze([{ presetId: 'clean-color', cues: Object.freeze([
        Object.freeze({ id: 'cue-final-1', startFrame: 0, endFrame: 60, text: 'Legenda final segura', anchor: 'bottom' }),
      ]) }]),
      transitions: Object.freeze([]),
      videoTracks: Object.freeze([{ kind: 'base-video', clips: Object.freeze([
        Object.freeze({ id: 'clip-final-1', sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 }),
      ]) }]),
    }),
    format: '9:16',
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

function finalInputHash(includePolicy = true, captionPolicySha256 = FINAL_CAPTION_CERTIFICATION_POLICY_SHA256) {
  const source = approvedSource()
  return calculateVersionHash({
    kind: 'project-final-export/v1',
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
  // W65b: the C1 pixel critic. By default it measures and finds every caption where the plan put it; a test overrides `verdict`.
  const critic = {
    requests: [],
    verdict: () => ({ issues: [], samples: [], measurement: 'completed' }),
    async verify(request) { critic.requests.push(request); return critic.verdict(request) },
  }
  return {
    calls,
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
          assert.equal(input.renderKind, 'final')
          assert.equal(input.fps, 30)
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
  assert.equal(seen.persisted.manifest.recipe.version, '1.13.0')
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
  for (const [label, hash] of [['another policy', finalInputHash(true, 'f'.repeat(64))], ['no policy', finalInputHash(true, null)]]) {
    const operations = createOperations(hash)
    const { calls, dependencies } = workerDependencies(operations)
    const outcome = await runNextProjectFinalExportOperationService(dependencies)(`worker-final-export-policy-${label.length}`)
    assert.equal(outcome.status, 'failed', label)
    assert.equal(operations.operation.error.code, 'invalid_render_input', label)
    assert.equal(calls.rendered, 0, label); assert.equal(calls.persisted, 0, label)
  }
  assert.notEqual(finalInputHash(true), finalInputHash(true, null))
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
  const repository = new PrismaProjectFinalExportRepository({
    v2Project: { async findFirst() { return {
      locale: 'pt-BR', versions: [{ id: 'result-version' }],
      directorRuns: [{ id: 'director-run', baseVersionId: 'input-version', qualitySnapshotId: 'quality-snapshot', objective: 'discovery',
        rubricRef: `${rubric.id}/v${rubric.version}`,
        qualitySnapshot: { schemaVersion: 3, contentJson: JSON.stringify(report), contentHash: calculateVersionHash(report) } }],
      proxyReviews: [{ id: 'proxy-review', reviewHash: 'a'.repeat(64), proxyArtifactId: 'proxy-artifact' }],
    } } },
  })
  repository.perceptionEvidence = { async read(input) { observed.push(input); return null } }
  return { repository, observed, request: { workspaceId, projectId: 'project-controlled', projectVersionId: 'result-version',
    projectVersionHash: 'b'.repeat(64), outputSpecId: 'output-spec-controlled', requireCurrent: true } }
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
  const stale = new PrismaProjectFinalExportRepository({ v2Project: { async findFirst() { return { locale: 'pt-BR', versions: [], directorRuns: [], proxyReviews: [] } } } })
  assert.equal(await stale.readApproval(wrongRun.request), null, 'no matching version, run or ready-for-final proxy review')
})
