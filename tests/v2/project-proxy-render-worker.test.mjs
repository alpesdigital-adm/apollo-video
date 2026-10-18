import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { enqueueProjectProxyRenderService, enqueueRenderableSnapshotProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { createExternalAuditContext, materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createManualCommandImpact } from '../../src/v2/domain/command-impact.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaRenderablePlanSnapshotRepository } from '../../src/v2/infrastructure/prisma/renderable-plan-snapshot-repository.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { PrismaRenderElementMapRepository } from '../../src/v2/infrastructure/prisma/render-element-map-repository.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { buildRenderElementMap, renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { SUBTITLE_ANCHOR_PERCEPTION_FIXTURES, subtitleAnchorDecisionFor } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { materializeSubtitlePresetSnapshot, SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } from '../../src/v2/domain/subtitle-system.ts'
import { evaluateColorCriticService } from '../../src/v2/application/color-critic.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { artifactOutputStoragePrefix } from '../../src/v2/domain/artifact-storage-identity.ts'
import { contentAddressedArtifactKey } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { buildMeasurement } from './wave20-fixtures.mjs'
import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'

const colorCompilation = Object.freeze({
  id: 'color-pipeline-proxy-test', sourceArtifactId: 'artifact-project-proxy-source',
  sourceManifestId: 'manifest-project-proxy-source', compilationHash: '8'.repeat(64),
  pipeline: Object.freeze({ pipelineHash: '9'.repeat(64) }),
})

test('byte-identical outputs from two projects retain distinct storage and replay identities', () => {
  const sha256 = 'd'.repeat(64)
  const firstId = 'artifact-project-one-output'
  const secondId = 'artifact-project-two-output'
  const firstPrefix = artifactOutputStoragePrefix('editorial-proxy', firstId)
  const secondPrefix = artifactOutputStoragePrefix('editorial-proxy', secondId)
  const key = (prefix) => contentAddressedArtifactKey({ workspaceId: 'workspace-shared', prefix, sha256, extension: 'mp4' })

  assert.match(firstPrefix, /^[a-f0-9]{32}$/)
  assert.notEqual(firstPrefix, secondPrefix)
  assert.notEqual(firstPrefix, artifactOutputStoragePrefix('final-export', firstId), 'artifact kind participates in the canonical identity')
  assert.notEqual(key(firstPrefix), key(secondPrefix), 'same bytes must not merge output identities across projects')
  assert.equal(key(firstPrefix), key(artifactOutputStoragePrefix('editorial-proxy', firstId)), 'replay must resolve the same reserved identity')
  assert.ok(key(firstPrefix).endsWith(`${sha256}.mp4`), 'the physical key still carries the verified content digest')
})

test('output storage identity rejects non-canonical or unsupported identities', () => {
  for (const [kind, outputArtifactId] of [
    ['unsupported-output', 'artifact-output'],
    ['editorial-proxy', ''],
    ['editorial-proxy', ' artifact-output'],
    ['editorial-proxy', 'artifact-output '],
    ['editorial-proxy', 'artifact\noutput'],
  ]) {
    assert.throws(
      () => artifactOutputStoragePrefix(kind, outputArtifactId),
      (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
    )
  }
})
const colorPipelineBindings = Object.freeze([Object.freeze({
  sourceArtifactId: colorCompilation.sourceArtifactId, sourceManifestId: colorCompilation.sourceManifestId,
  compilationId: colorCompilation.id, compilationHash: colorCompilation.compilationHash,
  pipelineHash: colorCompilation.pipeline.pipelineHash,
})])

test('duplicate immutable proxy input returns a scoped conflict after a concurrent uniqueness race', async () => {
  const operations = createOperations()
  const record = { operation: operations.operation, context: { kind: 'project-proxy-render', projectId: 'project-proxy-test',
    projectVersionId: 'project-version-proxy-test', editPlanSnapshotId: 'snapshot-edit-plan-proxy-test',
    sourceArtifactId: 'artifact-project-proxy-source', sourceManifestId: 'manifest-project-proxy-source', colorPipelineBindings,
    inputHash: projectProxyRenderInputHash({ source: source(), colorPipelineBindings }),
    outputArtifactId: 'artifact-project-proxy-output', outputManifestId: 'manifest-project-proxy-output', originalFileName: 'source-editorial.mp4' } }
  let scopedLookup
  const repository = new PrismaPublicOperationRepository({
    async $transaction() { throw Object.assign(new Error('concurrent immutable input admission'), { code: 'P2002' }) },
    v2PublicOperation: { async findUnique() { return null } },
    v2ProjectProxyRenderOperation: { async findFirst(query) { scopedLookup = query; return { operationId: 'private-existing-operation' } } },
  })
  await assert.rejects(repository.createOrReplay({ operation: record.operation, context: record.context,
    authenticationAudit: materializeActorAuditContext(proxyActor()), idempotencyKey: 'different-admission-key', requestFingerprint: 'a'.repeat(64) }),
  (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT' && !error.message.includes('private-existing-operation'))
  assert.deepEqual(scopedLookup.where, { workspaceId: record.operation.workspaceId, projectId: record.context.projectId,
    projectVersionId: record.context.projectVersionId, inputHash: record.context.inputHash })
})

function controlledProxyRightsRow(artifactId, overrides = {}) {
  const { workspace = 'workspace-project-proxy-test', ...draft } = overrides
  const rights = createAssetRightsSnapshot({ id: `rights-${artifactId}`, workspaceId: workspace,
    artifactId, sequence: 1, draft: { status: 'approved', allowedUses: ['rendering'],
      prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] }, ...draft },
    createdBy: { type: 'user', id: 'owner-proxy-rights' }, createdAt: '2026-07-31T22:44:00.000Z' })
  return { ...rights, allowedUsesJson: JSON.stringify(rights.allowedUses),
    prohibitedUsesJson: JSON.stringify(rights.prohibitedUses),
    allowedWorkspaceIdsJson: JSON.stringify(rights.allowedWorkspaceIds),
    allowedLocalesJson: rights.allowedLocales ? JSON.stringify(rights.allowedLocales) : null,
    allowedMarketsJson: null, allowedSyntheticOperationsJson: null,
    consentStatus: rights.consent.status, consentAllowedUsesJson: JSON.stringify(rights.consent.allowedUses),
    consentAllowedLocalesJson: null, consentAllowedMarketsJson: null,
    consentSyntheticOperationsJson: null, consentExpiresAt: rights.consent.expiresAt ? new Date(rights.consent.expiresAt) : null,
    consentDocumentArtifactId: null, owner: null, license: null, sourceNote: null,
    expiresAt: rights.expiresAt ? new Date(rights.expiresAt) : null,
    createdByType: 'user', createdById: 'owner-proxy-rights', createdAt: new Date('2026-07-31T22:44:00.000Z') }
}

function proxyActor(credentialId = 'credential-project-proxy-test') {
  const auditContext = createExternalAuditContext({
    clientId: 'client-project-proxy-test', credentialId,
    workspaceId: 'workspace-project-proxy-test', environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function createClock() {
  let current = Date.parse('2026-07-18T22:00:00.000Z')
  return () => new Date((current += 100))
}

function createOperations(immutableSource = source(), contextOverride = {}) {
  let operation = createQueuedPublicOperation({
    id: 'operation-project-proxy-test',
    workspaceId: 'workspace-project-proxy-test',
    projectId: 'project-proxy-test',
    clientId: 'client-project-proxy-test',
    type: 'project-proxy-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-project-proxy-output',
      manifestId: 'manifest-project-proxy-output',
    },
    maxAttempts: 2,
    createdAt: '2026-07-18T22:00:00.000Z',
  })
  let lease
  let denyHeartbeat = false
  const context = Object.freeze({
    kind: 'project-proxy-render',
    projectId: 'project-proxy-test',
    projectVersionId: 'project-version-proxy-test',
    editPlanSnapshotId: 'snapshot-edit-plan-proxy-test',
    sourceArtifactId: 'artifact-project-proxy-source',
    sourceManifestId: 'manifest-project-proxy-source',
    colorPipelineBindings,
    inputHash: projectProxyRenderInputHash({
      source: immutableSource,
      colorPipelineBindings,
    }),
    outputArtifactId: 'artifact-project-proxy-output',
    outputManifestId: 'manifest-project-proxy-output',
    originalFileName: 'source-editorial.mp4',
    ...contextOverride,
  })
  const record = () => ({ operation, context })
  const matches = (input) => lease && lease.owner === input.leaseOwner &&
    lease.attempt === input.attempt && Date.parse(lease.expiresAt) > Date.parse(input.now)

  return {
    get operation() { return operation },
    loseLease() { denyHeartbeat = true },
    repository: {
      async findById(workspaceId, operationId) {
        return workspaceId === operation.workspaceId && operationId === operation.id ? record() : null
      },
      async claimNext(input) {
        assert.equal(input.type, 'project-proxy-render')
        if (!['queued', 'retrying'].includes(operation.status)) return null
        operation = startPublicOperationAttempt(operation, input.now)
        lease = { owner: input.leaseOwner, attempt: operation.attempt, heartbeatAt: input.now, expiresAt: input.leaseUntil }
        return { ...record(), lease: Object.freeze({ ...lease }) }
      },
      async heartbeat(input) {
        if (denyHeartbeat || !matches(input)) return false
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

function source() {
  return Object.freeze({
    projectId: 'project-proxy-test',
    projectVersionId: 'project-version-proxy-test',
    editPlanSnapshotId: 'snapshot-edit-plan-proxy-test',
    editPlanHash: 'b'.repeat(64),
    editPlan: Object.freeze({
      schemaVersion: 2,
      state: 'compiled',
      projectVersionId: 'project-version-proxy-test',
      fps: 30,
      durationFrames: 300,
      movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
      subtitleTracks: Object.freeze([{ presetId: 'kinetic', cues: Object.freeze([
        Object.freeze({ id: 'cue-1', startFrame: 0, endFrame: 60, text: 'Legenda segura', anchor: 'bottom' }),
      ]) }]),
      transitions: Object.freeze([]),
      videoTracks: Object.freeze([{ kind: 'base-video', clips: Object.freeze([
        Object.freeze({ id: 'clip-1', sourceArtifactId: 'artifact-project-proxy-source', sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 }),
      ]) }]),
    }),
    format: '9:16',
    sourceArtifactId: 'artifact-project-proxy-source',
    sourceManifestId: 'manifest-project-proxy-source',
    sourceArtifactKey: 'workspaces/project-proxy-test/masters/source.mp4',
    sourceSha256: 'c'.repeat(64),
    renderSources: Object.freeze([Object.freeze({
      artifactId: 'artifact-project-proxy-source',
      manifestId: 'manifest-project-proxy-source',
      artifactKey: 'workspaces/project-proxy-test/masters/source.mp4',
      sha256: 'c'.repeat(64),
      byteSize: 4096,
      mediaType: 'video',
      container: 'mp4',
      role: 'source-master',
    })]),
    originalFileName: 'source.mp4',
    uploadReceivedAt: '2026-07-18T21:58:00.000Z',
    criticIssues: Object.freeze([]),
  })
}

/** The same source, but with a clip that names the camera it was cut from. */
function multicamSource() {
  const base = source()
  return Object.freeze({
    ...base,
    editPlan: Object.freeze({
      ...base.editPlan,
      videoTracks: Object.freeze([{ kind: 'base-video', clips: Object.freeze([
        Object.freeze({
          id: 'clip-1', sourceArtifactId: 'artifact-project-proxy-source', cameraId: 'cam-main',
          sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1,
        }),
      ]) }]),
    }),
  })
}

function dependencies(operations, overrides = {}) {
  const calls = { attached: 0, cleaned: 0, lutCleaned: 0, persisted: 0, mapped: 0, reviewed: 0, cataloged: 0 }
  let attachedReview = null
  const artifactRoot = join(tmpdir(), 'apollo-project-proxy-worker-artifacts')
  const deps = {
    operations: operations.repository,
    colorPipelines: { async read() { return { compilation: colorCompilation } } },
    colorPlans: { async readEffectiveForVersion() { return null } },
    luts: {
      async materialize() { return { selectionId: 'selection-project-proxy', selectionHash: '7'.repeat(64), lutPaths: {} } },
      async cleanup() { calls.lutCleaned += 1 },
    },
    projects: {
      async readImmutableSource() { return source() },
      async attachCompletedOutput(input) {
        calls.attached += 1
        assert.equal(input.variantId, '9:16')
        assert.equal(input.outputArtifactId, 'artifact-project-proxy-output')
        assert.equal(input.review.proxyArtifactId, input.outputArtifactId)
        attachedReview = input.review
        assert.equal(input.review.spec.codec, 'h264')
        assert.equal(input.review.spec.width, 540)
        assert.equal(input.review.spec.height, 960)
        assert.ok(input.review.timeToFirstProxyMs >= 120_000)
        calls.reviewed += 1
        calls.cataloged += 1
        assert.ok(await operations.repository.succeed({ operationId: input.operationId,
          leaseOwner: input.lease.owner, attempt: input.lease.attempt, now: input.lease.now }))
      },
    },
    artifacts: {
      async persistOrReplay(input) {
        calls.persisted += 1
        assert.equal(input.manifest.artifact.sha256, 'd'.repeat(64))
        return { artifactId: input.artifactId, manifestId: input.manifestId, replayed: false }
      },
    },
    storage: {
      async promoteDerived(input) {
        assert.equal(input.prefix, artifactOutputStoragePrefix('editorial-proxy', 'artifact-project-proxy-output'))
        return { key: `workspaces/project-proxy-test/${input.prefix}/output.mp4`, sha256: 'd'.repeat(64), byteSize: 4096 }
      },
    },
    renderer: {
      async render(input) {
        assert.deepEqual(input.lutPaths, {})
        assert.match(input.audioTimelineHash, /^[a-f0-9]{64}$/)
        return {
          outputPath: join(tmpdir(), 'project-proxy-worker-output.mp4'),
          sha256: 'd'.repeat(64),
          byteSize: 4096,
          probe: { width: 540, height: 960, duration: 10, fps: 30, codec: 'h264', container: 'mp4' },
          renderElementMap: { schemaVersion: 'render-element-map/v1', proxyHash: 'd'.repeat(64), fps: 30, durationFrames: 300, canvas: { width: 540, height: 960 }, elements: [] },
        }
      },
      async cleanup() { calls.cleaned += 1 },
    },
    // Manual perception is deliberately absent from the automatic anchor decision.
    perceptionTimelines: { async findLatest() { return null } },
    renderElementMaps: {
      async persistOrReplay(input) {
        calls.mapped += 1
        assert.equal(input.proxyArtifactId, 'artifact-project-proxy-output')
        assert.equal(input.map.proxyHash, 'd'.repeat(64))
        return { record: {}, replayed: false }
      },
    },
    artifactRoot,
    sources: {
      async materialize(input) { return { path: join(artifactRoot, ...input.artifactKey.split('/')), sha256: input.sha256, byteSize: input.byteSize } },
      async cleanup() {},
    },
    clock: createClock(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    ...overrides,
  }
  return { calls, deps, attachedReview: () => attachedReview }
}

test('project proxy worker materializes, attaches and settles the exact immutable output', async () => {
  const operations = createOperations()
  const { calls, deps, attachedReview } = dependencies(operations)
  const outcome = await runNextProjectProxyRenderOperationService(deps)('worker-project-proxy-success')

  assert.deepEqual(outcome, { operationId: 'operation-project-proxy-test', status: 'succeeded' })
  assert.equal(operations.operation.status, 'succeeded')
  assert.deepEqual(operations.operation.result.resource, operations.operation.target)
  // W65b: the cue that could not be certified is omitted and LISTED as a review item (a warning to acknowledge), not a block
  assert.equal(attachedReview()?.status, 'warning-ack-required')
  assert.equal(attachedReview()?.finalAllowed, false, 'until the reviewer has acknowledged the listed cues')
  assert.ok(attachedReview()?.criticIssues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' && issue.severity === 'warning'))
  assert.deepEqual(calls, { attached: 1, cleaned: 1, lutCleaned: 1, persisted: 1, mapped: 1, reviewed: 1, cataloged: 1 })
})

test('project proxy worker converges after an attachment commits but its response is lost', async () => {
  const operations = createOperations()
  const base = dependencies(operations)
  const attach = base.deps.projects.attachCompletedOutput
  let replayed = 0
  base.deps.projects.attachCompletedOutput = async (input) => {
    if (operations.operation.status === 'succeeded') {
      replayed += 1
      assert.equal(input.lease.attempt, operations.operation.attempt)
      assert.equal(input.outputArtifactId, operations.operation.target.id)
      return
    }
    await attach(input)
    throw new Error('W65_CONTROLLED_RESPONSE_LOSS_AFTER_COMMIT')
  }
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-project-proxy-response-loss')
  assert.deepEqual(outcome, { operationId: 'operation-project-proxy-test', status: 'succeeded' })
  assert.equal(replayed, 1)
  assert.equal(base.calls.attached, 1)
  assert.equal(operations.operation.status, 'succeeded')
})

test('snapshot proxy worker rehydrates the fenced plan and attaches without mutating project version state', async () => {
  const immutableSource = source()
  const renderableSnapshot = Object.freeze({
    planId: 'plan-localization-worker-test', planHash: '1'.repeat(64), origin: 'localization',
    sourceId: 'localization-run-worker-test', sourceHash: '2'.repeat(64),
    variantId: 'localization-variant-worker-test', format: '9:16',
  })
  const inputHash = calculateVersionHash({
    type: 'renderable-snapshot-proxy/v1', renderInputHash: projectProxyRenderInputHash({ source: immutableSource, colorPipelineBindings }),
    snapshot: renderableSnapshot,
  })
  const operations = createOperations(immutableSource, { renderableSnapshot, inputHash })
  let snapshotAttached = 0
  const base = dependencies(operations, { projects: {
    async readImmutableSource() { throw new Error('project EditPlan must not be the snapshot proxy source') },
    async readRenderableSnapshotSource(input) {
      assert.deepEqual(input, {
        workspaceId: 'workspace-project-proxy-test', projectId: 'project-proxy-test',
        planId: renderableSnapshot.planId, planHash: renderableSnapshot.planHash, format: renderableSnapshot.format,
      })
      return immutableSource
    },
    async attachCompletedOutput() { throw new Error('snapshot proxy must not settle project Director/invalidation state') },
    async attachCompletedSnapshotOutput(input) {
      snapshotAttached += 1
      assert.equal(input.variantId, renderableSnapshot.variantId)
      assert.ok(await operations.repository.succeed({ operationId: input.operationId,
        leaseOwner: input.lease.owner, attempt: input.lease.attempt, now: input.lease.now }))
    },
  } })
  let renderedInput = null
  const render = base.deps.renderer.render
  base.deps.renderer = { ...base.deps.renderer,
    async render(input) { renderedInput = input; return render(input) } }
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-snapshot-proxy-test')
  assert.deepEqual(outcome, { operationId: 'operation-project-proxy-test', status: 'succeeded' })
  assert.equal(snapshotAttached, 1)
  assert.equal(immutableSource.subtitleResolution, undefined)
  assert.equal(renderedInput.subtitleCues.length, 1)
  assert.equal(renderedInput.placementPlan.subtitleAnchorPlan.schemaVersion, 'subtitle-anchor-plan/v3')
  const decision = subtitleAnchorDecisionFor(renderedInput.placementPlan.subtitleAnchorPlan, 'cue-1')
  assert.equal(decision.suppressed, true)
  assert.equal(decision.anchor, null)
  assert.equal(decision.issues[0].code, 'FACE_PERCEPTION_UNAVAILABLE')
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(tmpdir(), 'w65-no-anchor-guard'),
    ffmpegPath: process.execPath })
  let colorPasses = 0
  renderer.colorProcessor.process = async () => { colorPasses += 1 }
  await assert.rejects(renderer.render({ ...renderedInput, placementPlan: null }),
    /complete unknown-face review plan/)
  assert.equal(colorPasses, 0, 'missing facial decisions must fail before the FFmpeg color prepass')
})

test('an explicitly disabled subtitle resolution sends no cues to the renderer', async () => {
  const immutableSource = Object.freeze({ ...source(), subtitleResolution: Object.freeze({ enabled: false }) })
  const operations = createOperations(immutableSource)
  const base = dependencies(operations)
  base.deps.projects = { ...base.deps.projects,
    async readImmutableSource() { return immutableSource } }
  let renderedInput = null
  const render = base.deps.renderer.render
  base.deps.renderer = { ...base.deps.renderer,
    async render(input) { renderedInput = input; return render(input) } }
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-disabled-subtitles')
  assert.equal(outcome.status, 'succeeded')
  assert.deepEqual(renderedInput.subtitleCues, [])
  assert.equal(renderedInput.placementPlan.subtitleAnchorPlan, null)
})

test('project proxy worker does not attach an output after losing its lease', async () => {
  const operations = createOperations()
  const base = dependencies(operations)
  const originalRender = base.deps.renderer.render
  base.deps.renderer = {
    ...base.deps.renderer,
    async render(input) {
      const result = await originalRender(input)
      operations.loseLease()
      return result
    },
  }
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-project-proxy-stale')

  assert.deepEqual(outcome, { operationId: 'operation-project-proxy-test', status: 'lease-lost' })
  assert.equal(operations.operation.status, 'running')
  assert.deepEqual(base.calls, { attached: 0, cleaned: 1, lutCleaned: 1, persisted: 0, mapped: 0, reviewed: 0, cataloged: 0 })
})

test('T-FR-233 project proxy worker materializes only the persisted stale range over the reusable proxy', async () => {
  const immutableSource = Object.freeze({
    ...source(),
    rangeReuse: Object.freeze({
      schemaVersion: 'project-proxy-range-reuse/v1',
      commandId: 'manual-command-range-test',
      impactHash: '1'.repeat(64),
      baseVersionId: 'project-version-proxy-base',
      ranges: Object.freeze([Object.freeze({ startFrame: 60, endFrame: 120 })]),
      artifactId: 'artifact-project-proxy-base',
      manifestId: 'manifest-project-proxy-base',
      artifactKey: 'workspaces/project-proxy-test/editorial-proxies/base.mp4',
      sha256: '2'.repeat(64),
      byteSize: 8_192,
    }),
  })
  const operations = createOperations(immutableSource)
  let renderedRange
  let manifestSources
  const base = dependencies(operations, {
    projects: {
      async readImmutableSource() { return immutableSource },
      async attachCompletedOutput(input) {
        base.calls.attached += 1
        base.calls.reviewed += 1
        assert.equal(input.review.proxyArtifactId, input.outputArtifactId)
        assert.ok(await operations.repository.succeed({ operationId: input.operationId,
          leaseOwner: input.lease.owner, attempt: input.lease.attempt, now: input.lease.now }))
      },
    },
    renderer: {
      async render(input) {
        renderedRange = input.rangeReuse
        return {
          outputPath: join(tmpdir(), 'project-proxy-range-output.mp4'),
          sha256: 'd'.repeat(64), byteSize: 4_096,
          probe: { width: 540, height: 960, duration: 10, fps: 30, codec: 'h264', container: 'mp4' },
          renderElementMap: { schemaVersion: 'render-element-map/v1', proxyHash: 'd'.repeat(64), fps: 30, durationFrames: 300, canvas: { width: 540, height: 960 }, elements: [] },
        }
      },
      async cleanup() { base.calls.cleaned += 1 },
    },
    artifacts: {
      async persistOrReplay(input) {
        base.calls.persisted += 1
        manifestSources = input.manifest.sources
        return { artifactId: input.artifactId, manifestId: input.manifestId, replayed: false }
      },
    },
  })
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)(
    'worker-project-proxy-range',
  )

  assert.equal(outcome.status, 'succeeded')
  assert.deepEqual(renderedRange.ranges, [{ startFrame: 60, endFrame: 120 }])
  assert.equal(
    renderedRange.path,
    join(base.deps.artifactRoot, immutableSource.rangeReuse.artifactKey),
  )
  assert.equal(manifestSources.at(-1).role, 'reused-proxy-range')
  assert.equal(manifestSources.at(-1).sha256, immutableSource.rangeReuse.sha256)
})

test('T-FR-233 render-free selection completes by exact proxy reuse without color resolution or worker', async () => {
  const unchangedReuse = Object.freeze({
    schemaVersion: 'project-proxy-unchanged-reuse/v1',
    commandId: 'command-selection-proxy-test',
    impactHash: '4'.repeat(64),
    baseVersionId: 'project-version-proxy-base',
    operationId: 'operation-project-proxy-base',
    artifactId: 'artifact-project-proxy-base',
    manifestId: 'manifest-project-proxy-base',
    artifactKey: 'editorial-proxies/base-selection.mp4',
    sha256: '5'.repeat(64),
    byteSize: 8192,
  })
  const immutableSource = Object.freeze({
    ...source(),
    projectVersionId: 'project-version-proxy-selection',
    editPlanSnapshotId: 'snapshot-proxy-selection',
    unchangedReuseRequired: true,
    unchangedReuse,
  })
  let persisted
  let createdArtifactId = false
  let createdManifestId = false
  const result = await enqueueProjectProxyRenderService({
    projects: { async readCurrentSource() { return immutableSource } },
    colorPipelines: { async readForSources() { throw new Error('color lookup must not run') } },
    operations: {
      async findReplay() { return null },
      async createOrReplay(input) {
        persisted = input
        return { operation: input.operation, context: input.context, replayed: false }
      },
    },
    clock: () => new Date('2026-07-31T22:40:00.000Z'),
    createId(kind) {
      if (kind === 'artifact') createdArtifactId = true
      if (kind === 'manifest') createdManifestId = true
      return `created-${kind}-selection`
    },
  })({
    workspaceId: 'workspace-project-proxy-test',
    projectId: 'project-proxy-test',
    actor: proxyActor(),
    idempotencyKey: 'selection-proxy-reuse-test',
  })
  assert.equal(result.operation.status, 'succeeded')
  assert.equal(result.operation.phase, 'completed')
  assert.equal(result.operation.attempt, 1)
  assert.equal(result.operation.target.id, unchangedReuse.artifactId)
  assert.equal(result.operation.target.manifestId, unchangedReuse.manifestId)
  assert.equal(persisted.context.kind, 'project-proxy-reuse')
  assert.equal(persisted.context.reusedFromOperationId, unchangedReuse.operationId)
  assert.equal(persisted.context.impactHash, unchangedReuse.impactHash)
  assert.deepEqual(persisted.operation.result.resource, persisted.operation.target)
  assert.equal(createdArtifactId, false)
  assert.equal(createdManifestId, false)
})

test('proxy reuse rejects output from the earlier bottom-anchor recipe', async () => {
  const toolDigest = createHash('sha256')
    .update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`).digest('hex')
  const manifestFor = (version, digest = toolDigest) => createMediaArtifactManifestV2({
    artifactKey: 'editorial-proxies/reusable.mp4', artifactSha256: 'a'.repeat(64),
    byteSize: 4096, mediaType: 'video', container: 'mp4',
    recipe: { id: 'editorial-proxy', version, parameters: { inputHash: 'b'.repeat(64) } },
    sources: [{ artifactKey: 'masters/source.mp4', sha256: 'c'.repeat(64),
      role: 'source-master', execution: { tool: { id: 'ffmpeg', version: 'static', digest } } }],
  })
  let storedManifest = manifestFor(EDITORIAL_PROXY_RECIPE_VERSION)
  let storedArtifactKey = 'editorial-proxies/reusable.mp4'
  let storedMap = { schemaVersion: 'render-element-map/v1', proxyHash: 'a'.repeat(64),
    fps: 30, durationFrames: 60, canvas: { width: 540, height: 960 }, elements: [] }
  const repository = new PrismaProjectProxyRenderRepository({
    v2ProjectProxyRenderOperation: { async findFirst() { return {
      operationId: 'operation-reusable', outputArtifactId: 'artifact-reusable',
      outputManifestId: 'manifest-reusable',
    } } },
    v2MediaArtifact: { async findFirst() { return {
      id: 'artifact-reusable', workspaceId: 'workspace-reusable',
      artifactKey: storedArtifactKey, sha256: 'a'.repeat(64), byteSize: 4096n,
      manifests: [{ id: 'manifest-reusable', manifestHash: storedManifest.manifestHash,
        workspaceId: 'workspace-reusable', artifactId: 'artifact-reusable',
        manifestJson: stableSerialize(storedManifest) }],
    } } },
    v2RenderElementMap: { async findFirst() { return storedMap && {
      id: '7fd27609-9633-47d5-9186-028639f56ed1', workspaceId: 'workspace-reusable',
      projectId: 'project-reusable', projectVersionId: 'version-reusable',
      proxyArtifactId: 'artifact-reusable', proxyHash: storedMap.proxyHash,
      mapHash: renderElementMapHash(storedMap), schemaVersion: storedMap.schemaVersion,
      fps: storedMap.fps, durationFrames: storedMap.durationFrames,
      canvasWidth: storedMap.canvas.width, canvasHeight: storedMap.canvas.height,
      elementsJson: '[]', createdAt: new Date('2026-10-09T00:00:00.000Z'),
    } } },
  })
  const scope = { workspaceId: 'workspace-reusable', projectId: 'project-reusable',
    baseVersionId: 'version-reusable' }
  assert.equal((await repository.readReusableProxy(scope))?.artifactId, 'artifact-reusable')
  storedManifest = manifestFor('1.12.0')
  assert.equal(await repository.readReusableProxy(scope), null,
    'an old bottom-anchor proxy cannot enter unchanged or partial range reuse')
  storedManifest = manifestFor(EDITORIAL_PROXY_RECIPE_VERSION, 'f'.repeat(64))
  assert.equal(await repository.readReusableProxy(scope), null,
    'recipe version alone cannot replace the pinned renderer provenance')
  storedManifest = manifestFor(EDITORIAL_PROXY_RECIPE_VERSION)
  storedArtifactKey = 'editorial-proxies/substituted.mp4'
  assert.equal(await repository.readReusableProxy(scope), null,
    'a manifest cannot attest a different artifact storage key')
  storedArtifactKey = 'editorial-proxies/reusable.mp4'
  storedMap = null
  assert.equal(await repository.readReusableProxy(scope), null,
    'a missing content-addressed element map cannot prove the old pixels have no captions')
})

test('T-FR-233 render-free selection fails closed when its base proxy is unavailable', async () => {
  await assert.rejects(
    enqueueProjectProxyRenderService({
      projects: { async readCurrentSource() { return {
        ...source(),
        unchangedReuseRequired: true,
      } } },
      colorPipelines: { async readForSources() { throw new Error('must not run') } },
      operations: { async findReplay() { throw new Error('must not run') } },
      clock: () => new Date('2026-07-31T22:40:00.000Z'),
      createId: (kind) => `created-${kind}-selection`,
    })({
      workspaceId: 'workspace-project-proxy-test',
      projectId: 'project-proxy-test',
      actor: proxyActor(),
      idempotencyKey: 'selection-proxy-missing-test',
    }),
    (error) => error.code === 'PRECONDITION_REQUIRED' && /completed proxy/.test(error.message),
  )
})

test('manual route pins its committed result when enqueueing the proxy', async () => {
  const route = await readFile(new URL('../../src/app/v1/projects/[projectId]/manual-edits/route.ts', import.meta.url), 'utf8')
  const admission = route.slice(route.indexOf('const proxy = await enqueueProjectProxyRenderService'), route.indexOf('return NextResponse.json(presentSuccess', route.indexOf('const proxy = await enqueueProjectProxyRenderService')))
  assert.match(admission, /expectedProjectVersionId: result\.version\.id/)
})

test('proxy enqueue fails closed when a committed Command result is no longer current', async () => {
  const committedVersion = Object.freeze({ id: 'project-version-command-result', commandId: 'manual-committed-command' })
  let admissions = 0
  await assert.rejects(
    enqueueProjectProxyRenderService({
      projects: { async readCurrentSource() { return source() } },
      colorPipelines: { async readForSources() { throw new Error('must not run') } },
      operations: { async findReplay() { throw new Error('must not run') },
        async createOrReplay() { admissions++; throw new Error('must not run') } },
      clock: () => new Date('2026-07-31T22:40:00.000Z'),
      createId: (kind) => `created-${kind}-version-fence`,
    })({
      workspaceId: 'workspace-project-proxy-test',
      projectId: 'project-proxy-test',
      expectedProjectVersionId: committedVersion.id,
      actor: proxyActor(),
      idempotencyKey: 'proxy-version-fence-test',
    }),
    (error) => error.code === 'VERSION_CONFLICT' && error.details.currentProjectVersionId === 'project-version-proxy-test',
  )
  assert.equal(admissions, 0)
  assert.deepEqual(committedVersion, { id: 'project-version-command-result', commandId: 'manual-committed-command' },
    'enqueue refusal cannot roll back the previously committed Command/Version')
})

test('renderable snapshot proxy enqueue binds exact immutable source, variant, format and hashes', async () => {
  const immutableSource = source()
  let persisted
  const request = {
    workspaceId: 'workspace-project-proxy-test',
    projectId: 'project-proxy-test',
    planId: 'plan-localization-test',
    planHash: '1'.repeat(64),
    origin: 'localization',
    sourceId: 'localization-run-test',
    sourceHash: '2'.repeat(64),
    variantId: 'localization-variant-test',
    format: '9:16',
    actor: proxyActor(),
    idempotencyKey: 'localization-snapshot-proxy-test',
  }
  const result = await enqueueRenderableSnapshotProxyRenderService({
    snapshots: { async readByPlan() { return {
      planId: request.planId, planHash: request.planHash, origin: request.origin,
      sourceId: request.sourceId, sourceHash: request.sourceHash,
      plan: { localeVariantRefs: [request.variantId] },
    } } },
    projects: { async readRenderableSnapshotSource(input) {
      assert.deepEqual(input, {
        workspaceId: request.workspaceId, projectId: request.projectId,
        planId: request.planId, planHash: request.planHash, format: request.format,
      })
      return immutableSource
    } },
    colorPipelines: { async listForSource() { return [{ compilation: colorCompilation }] } },
    operations: {
      async findReplay() { return null },
      async createOrReplay(input) { persisted = input; return { ...input, replayed: false } },
    },
    clock: () => new Date('2026-09-08T20:15:00.000Z'),
    createId: (kind) => `${kind}-snapshot-proxy-test`,
  })(request)
  assert.equal(result.operation.status, 'queued')
  assert.deepEqual(persisted.context.renderableSnapshot, {
    planId: request.planId, planHash: request.planHash, origin: request.origin,
    sourceId: request.sourceId, sourceHash: request.sourceHash,
    variantId: request.variantId, format: request.format,
  })
  assert.notEqual(persisted.context.inputHash, projectProxyRenderInputHash({ source: immutableSource, colorPipelineBindings }))
})

test('renderable snapshot lookup never spreads transport-only format into Prisma where', async () => {
  let where
  const repository = new PrismaRenderablePlanSnapshotRepository({ v2RenderablePlanSnapshot: {
    async findFirst(input) { where = input.where; return null },
  } })
  await repository.readByPlan({ workspaceId: 'workspace-test', projectId: 'project-test', planId: 'plan-test', planHash: 'a'.repeat(64), format: '16:9' })
  assert.deepEqual(where, { workspaceId: 'workspace-test', projectId: 'project-test', planId: 'plan-test', planHash: 'a'.repeat(64) })
})

test('T-FR-233 Prisma atomically revalidates and records a completed proxy cache hit', async () => {
  const baseVersionId = 'project-version-proxy-base'
  const resultVersionId = 'project-version-proxy-selection'
  const commandId = 'command-selection-proxy-test'
  const editPlan = { ...source().editPlan, id: `edit-plan-${baseVersionId}`, projectVersionId: baseVersionId, createdAt: '2026-07-31T22:44:00.000Z' }
  const impact = createManualCommandImpact({
    commandId,
    baseVersionId,
    resultVersionId,
    variantId: '9:16',
    targetId: 'clip-1',
    action: 'apply',
    operation: { kind: 'select', clipId: 'clip-1' },
    beforeEditPlan: editPlan,
    afterEditPlan: editPlan,
    outputReferences: [],
  })
  const now = '2026-07-31T22:45:00.000Z'
  let operation = createQueuedPublicOperation({
    id: 'operation-project-proxy-selection',
    workspaceId: 'workspace-project-proxy-test',
    projectId: 'project-proxy-test',
    clientId: 'client-project-proxy-test',
    type: 'project-proxy-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-project-proxy-base',
      manifestId: 'manifest-project-proxy-base',
    },
    createdAt: now,
  })
  operation = startPublicOperationAttempt(operation, now)
  operation = advancePublicOperationPhase(operation, 'persisting', now)
  operation = succeedPublicOperation(operation, now)
  const context = {
    kind: 'project-proxy-reuse',
    projectId: 'project-proxy-test',
    projectVersionId: resultVersionId,
    editPlanSnapshotId: 'snapshot-proxy-selection',
    commandId,
    impactHash: impact.impactHash,
    baseVersionId,
    reusedFromOperationId: 'operation-project-proxy-base',
    sourceArtifactId: 'artifact-project-proxy-source',
    sourceManifestId: 'manifest-project-proxy-source',
    inputHash: '6'.repeat(64),
    outputArtifactId: 'artifact-project-proxy-base',
    outputManifestId: 'manifest-project-proxy-base',
    originalFileName: 'source-editorial.mp4',
  }
  let publicReadCount = 0
  let operationData
  let detailData
  let mapData, mapOverride, manifestOverride, childPlanOverride, lockFailureTable, injectedFailure
  let mapCreates = 0, sourceMapLookups = 0, outboxRows = 0
  let projectState = 'revising'
  let blockedSource = false, finalRightsBlocked = false, sourceReads = 0
  const lockReads = []
  const childPlan = { ...editPlan, id: `edit-plan-${resultVersionId}`, projectVersionId: resultVersionId, createdAt: now,
    manualEditing: { schemaVersion: 1, action: 'apply', operation: { kind: 'select', clipId: 'clip-1' }, variantId: '9:16' } }
  const snapshotRow = (id, document) => ({ id, workspaceId: operation.workspaceId, projectId: operation.projectId,
    kind: 'edit-plan', schemaVersion: 2, contentJson: stableSerialize(document), contentHash: calculateCanonicalHash(document) })
  let projectCasCount = 0
  let projectCasAccepted = true
  const bindingsJson = stableSerialize(colorPipelineBindings)
  const rendererDigest = createHash('sha256')
    .update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`).digest('hex')
  const safeManifest = createMediaArtifactManifestV2({
    artifactKey: 'editorial-proxies/base-selection.mp4', artifactSha256: 'a'.repeat(64),
    byteSize: 4096, mediaType: 'video', container: 'mp4',
    recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
      parameters: { inputHash: context.inputHash } },
    sources: [{ artifactKey: 'masters/source.mp4', sha256: 'c'.repeat(64),
      role: 'source-master', execution: { tool: { id: 'ffmpeg', version: 'static', digest: rendererDigest } } }],
  })
  const safeMap = buildRenderElementMap({ proxyHash: 'a'.repeat(64),
    fps: editPlan.fps, durationFrames: editPlan.durationFrames,
    canvas: { width: 540, height: 960 }, source: { width: 1920, height: 1080 },
    clips: editPlan.videoTracks.filter((track) => track.kind === 'base-video').flatMap((track) => track.clips),
    subtitleCues: [], ctaOverlays: [] })
  assert.ok(safeMap.elements.length > 0, 'nonempty producer map exposes historical property-order identity')
  assert.notEqual(JSON.stringify(safeMap.elements), stableSerialize(safeMap.elements))
  const sourceMapRow = { id: '35b80bd0-77af-4a34-bd5c-d9a6566db1b1',
    workspaceId: operation.workspaceId, projectId: operation.projectId, projectVersionId: baseVersionId,
    proxyArtifactId: context.outputArtifactId, schemaVersion: safeMap.schemaVersion, proxyHash: safeMap.proxyHash,
    fps: safeMap.fps, durationFrames: safeMap.durationFrames, canvasWidth: safeMap.canvas.width, canvasHeight: safeMap.canvas.height,
    elementsJson: JSON.stringify(safeMap.elements), mapHash: renderElementMapHash(safeMap) }
  const repository = new PrismaPublicOperationRepository({
    async $transaction(callback) {
      const before = { operationData, detailData, mapData, mapCreates, outboxRows, projectState }
      try { return await callback({
        async $queryRaw(query, ...values) {
          const sql = (Array.isArray(query) ? query : query.strings).join('?')
          if (sql.includes('clock_timestamp()')) return [{ now: new Date(now) }]
          const table = /FROM "?([^"\s]+)"?/.exec(sql)?.[1]
          lockReads.push(table)
          assert.ok(sql.includes('FOR UPDATE') || sql.includes('FOR SHARE'))
          if (table === lockFailureTable) return []
          if (table === 'media_artifacts') return values[1].values.map((id) => ({ id }))
          return [{ id: table === 'render_element_maps' ? sourceMapRow.id : 'locked', operationId: context.reusedFromOperationId }]
        },
        v2PublicOperation: {
          async findUnique() {
            publicReadCount += 1
            if (publicReadCount === 1) return null
            return {
              ...operationData,
              resultJson: operationData.resultJson ?? null,
              errorCode: null, errorMessage: null, errorRetryable: null,
              leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
              nextAttemptAt: null, deadLetteredAt: null,
              artifactRender: null, mediaIngest: null,
              projectProxyRender: { ...detailData, createdAt: new Date(now) },
              projectFinalExport: null, sourceCleanupPlan: null,
              longFormIndexWorkflow: null,
            }
          },
          async create({ data }) { operationData = data },
        },
        v2PublicEventOutbox: { async createMany() {
          if (injectedFailure === 'outbox') throw Object.assign(new Error('controlled outbox failure'), { code: 'CONTROLLED_TRANSACTION_FAILURE' })
          outboxRows += 2
          if (injectedFailure === 'context-after-outbox') {
            childPlanOverride = structuredClone(childPlan)
            childPlanOverride.videoTracks[0].clips[0].crop = { x: .1, y: .1, width: .8, height: .8 }
          }
          return { count: 2 } } },
        v2Project: { async findFirst() {
          sourceReads += 1
          const rights = controlledProxyRightsRow(context.sourceArtifactId, {
            ...(blockedSource || (finalRightsBlocked && sourceReads > 1) ? { status: 'revoked' } : {}) })
          return { id: operation.projectId, workspaceId: operation.workspaceId, locale: 'pt-BR', format: '9:16',
            currentVersionId: resultVersionId, versions: [{ id: resultVersionId,
              editPlanSnapshotId: context.editPlanSnapshotId, editPlanSnapshot: snapshotRow(context.editPlanSnapshotId, childPlan),
              directorRunAsResult: null }], mediaAssets: [{ role: 'source-master', artifactId: context.sourceArtifactId,
                originalFileName: 'source-editorial.mp4', createdAt: new Date(now), upload: null, artifact: {
                  mediaType: 'video', status: 'available', sha256: 'c'.repeat(64), byteSize: 4096n, container: 'mp4',
                  currentRightsSnapshot: rights, manifests: [{ id: context.sourceManifestId,
                    manifestJson: JSON.stringify({ artifact: { artifactKey: 'masters/source.mp4' } }) }] } }] }
        }, async updateMany({ where, data }) {
          projectCasCount += 1
          assert.equal(where.currentVersionId, resultVersionId)
          assert.equal(data.status, 'reviewing-proxy')
          assert.equal(where.status.in.includes('completed'), false)
          assert.equal(where.status.in.includes('archived'), false)
          if (projectCasAccepted) projectState = data.status
          return { count: projectCasAccepted ? 1 : 0 }
        } },
        v2ProjectVersion: { async findFirst({ where }) {
          if (where.id === baseVersionId) return { id: baseVersionId, sequence: 10, baseHash: '5'.repeat(64),
            editPlanSnapshot: snapshotRow('snapshot-base', editPlan) }
          return {
          id: resultVersionId,
          parentVersionId: baseVersionId, sequence: 11, createdAt: new Date(now),
          editPlanSnapshot: snapshotRow(context.editPlanSnapshotId, childPlanOverride ?? childPlan),
          command: {
            id: commandId,
            type: 'manual-edit',
            baseVersionId, baseHash: '5'.repeat(64),
            payloadJson: JSON.stringify({ schemaVersion: 2, action: 'apply', expectedRevision: 10, targetId: 'clip-1', operation: { kind: 'select', clipId: 'clip-1' }, variantId: '9:16', impact }),
          },
        } } },
        v2ProjectProxyRenderOperation: {
          async findFirst() { return { operationId: context.reusedFromOperationId,
            colorPipelineBindingsJson: bindingsJson } },
          async create({ data }) { detailData = data },
        },
        v2MediaArtifact: { async findFirst() { return {
          id: context.outputArtifactId, workspaceId: operation.workspaceId,
          artifactKey: 'editorial-proxies/base-selection.mp4', sha256: 'a'.repeat(64),
          byteSize: 4096n, manifests: [{ id: context.outputManifestId,
            workspaceId: operation.workspaceId, artifactId: context.outputArtifactId,
            manifestHash: (manifestOverride ?? safeManifest).manifestHash, manifestJson: stableSerialize(manifestOverride ?? safeManifest) }],
        } } },
        v2MediaArtifactManifest: { async findFirst() { return { id: context.outputManifestId,
          manifestJson: stableSerialize(manifestOverride ?? safeManifest) } } },
        v2RenderElementMap: {
          async findFirst() { sourceMapLookups += 1; return mapOverride ?? sourceMapRow },
          async create({ data }) {
            if (injectedFailure === 'map') throw Object.assign(new Error('controlled map failure'), { code: 'CONTROLLED_TRANSACTION_FAILURE' })
            mapData = data; mapCreates += 1; return data
          },
        },
      }) } catch (error) {
        operationData = before.operationData; detailData = before.detailData
        mapData = before.mapData; mapCreates = before.mapCreates
        outboxRows = before.outboxRows; projectState = before.projectState
        throw error
      }
    },
  })
  const persisted = await repository.createOrReplay({
    operation,
    authenticationAudit: materializeActorAuditContext(proxyActor()),
    context,
    idempotencyKey: 'selection-proxy-persistence-test',
    requestFingerprint: '7'.repeat(64),
  })
  assert.deepEqual(lockReads, ['public_operations', 'project_proxy_render_operations', 'projects', 'media_artifacts', 'media_artifact_manifests', 'render_element_maps'])
  assert.equal(sourceMapLookups, 1, 'copy validates one exact source map and never reads a second row')
  assert.equal(persisted.operation.status, 'succeeded')
  assert.equal(persisted.context.kind, 'project-proxy-reuse')
  assert.equal(persisted.context.reusedFromOperationId, context.reusedFromOperationId)
  assert.equal(detailData.outputArtifactId, context.outputArtifactId)
  assert.equal(detailData.colorPipelineBindingsJson, bindingsJson)
  assert.equal(detailData.reuseCommandId, commandId)
  assert.equal(detailData.reuseImpactHash, impact.impactHash)
  assert.equal(detailData.reuseBaseVersionId, baseVersionId)
  assert.equal(operationData.resultJson, stableSerialize(operation.result))

  projectCasAccepted = false
  const replay = await repository.createOrReplay({ operation,
    authenticationAudit: materializeActorAuditContext(proxyActor()), context,
    idempotencyKey: 'selection-proxy-persistence-test', requestFingerprint: '7'.repeat(64) })
  assert.equal(replay.replayed, true)
  assert.equal(mapCreates, 1, 'replay cannot duplicate the child map')
  assert.equal(sourceMapLookups, 1, 'replay does not load or recopy a source map')
  assert.equal(projectCasCount, 1, 'replay cannot rewrite a project that advanced after the inline cache hit')
  publicReadCount = 0
  await assert.rejects(repository.createOrReplay({ operation,
    authenticationAudit: materializeActorAuditContext(proxyActor()), context,
    idempotencyKey: 'selection-proxy-stale-project', requestFingerprint: '7'.repeat(64) }),
  (error) => error.code === 'PROJECT_TRANSITION_REJECTED')
  projectCasAccepted = true

  publicReadCount = 0
  operationData = undefined
  detailData = undefined
  await assert.rejects(
    repository.createOrReplay({
      operation,
      authenticationAudit: materializeActorAuditContext(proxyActor()),
      context: { ...context, impactHash: '8'.repeat(64) },
      idempotencyKey: 'selection-proxy-tamper-test',
      requestFingerprint: '9'.repeat(64),
    }),
    (error) => error.code === 'PERSISTENCE_CONFLICT' && /unchanged immutable Command/.test(error.message),
  )
  const positiveMap = mapData
  assert.match(positiveMap.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(positiveMap.id, sourceMapRow.id)
  assert.equal(positiveMap.projectVersionId, resultVersionId)
  assert.equal(positiveMap.mapHash, sourceMapRow.mapHash)
  assert.equal(positiveMap.elementsJson, JSON.stringify(safeMap.elements))
  const copiedMapRepository = new PrismaRenderElementMapRepository({ v2RenderElementMap: {
    async findFirst({ where }) {
      assert.deepEqual(where, { workspaceId: operation.workspaceId, projectId: operation.projectId,
        projectVersionId: resultVersionId, proxyArtifactId: context.outputArtifactId })
      return positiveMap
    },
  } })
  const copiedMap = await copiedMapRepository.findExact({ workspaceId: operation.workspaceId,
    projectId: operation.projectId, projectVersionId: resultVersionId, proxyArtifactId: context.outputArtifactId })
  assert.equal(copiedMap.id, positiveMap.id)
  assert.equal(copiedMap.mapHash, sourceMapRow.mapHash)
  assert.deepEqual(copiedMap.map, safeMap)
  // Reordering valid JSON without resealing is a contradiction under the historical map hash.
  const reorderedMapRepository = new PrismaRenderElementMapRepository({ v2RenderElementMap: {
    async findFirst() { return { ...positiveMap, elementsJson: stableSerialize(safeMap.elements) } },
  } })
  await assert.rejects(reorderedMapRepository.findExact({ workspaceId: operation.workspaceId,
    projectId: operation.projectId, projectVersionId: resultVersionId, proxyArtifactId: context.outputArtifactId }),
  (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  assert.equal(mapCreates, 1)
  assert.equal('review' in positiveMap, false)

  for (const [label, mutate] of [
    ['base map scope', () => { mapOverride = { ...sourceMapRow, projectVersionId: 'version-sister' } }],
    ['map seal', () => { mapOverride = { ...sourceMapRow, mapHash: 'b'.repeat(64) } }],
    ['map JSON', () => { mapOverride = { ...sourceMapRow, elementsJson: '{' } }],
    ['map keys reordered with original hash', () => {
      mapOverride = { ...sourceMapRow, elementsJson: stableSerialize(safeMap.elements) }
    }],
    ['map clock', () => {
      const wrong = { ...safeMap, durationFrames: 60 }
      mapOverride = { ...sourceMapRow, durationFrames: 60, mapHash: renderElementMapHash(wrong) }
    }],
    ['manifest seal', () => { manifestOverride = { ...safeManifest, manifestHash: 'b'.repeat(64) } }],
    ['valid manifest but wrong artifact', () => {
      const body = { ...safeManifest }; delete body.manifestHash
      body.artifact = { ...body.artifact, sha256: 'b'.repeat(64) }
      manifestOverride = { ...body, manifestHash: calculateCanonicalHash(body) }
    }],
    ['valid output manifest contradicts current source bytes', () => {
      const body = structuredClone(safeManifest); delete body.manifestHash
      body.sources[0].sha256 = 'b'.repeat(64)
      manifestOverride = { ...body, manifestHash: calculateCanonicalHash(body) }
    }],
    ['old recipe', () => {
      const body = { ...safeManifest }; delete body.manifestHash
      body.recipe = { ...body.recipe, version: '0.0.0' }
      manifestOverride = { ...body, manifestHash: calculateCanonicalHash(body) }
    }],
    ['wrong declared renderer', () => {
      const body = structuredClone(safeManifest); delete body.manifestHash
      body.sources[0].execution.tool.digest = 'b'.repeat(64)
      manifestOverride = { ...body, manifestHash: calculateCanonicalHash(body) }
    }],
    ['subtitle present', () => {
      const caption = { elementId: 'subtitle:cue-1', type: 'subtitle', clipId: 'clip-1', sceneId: 'scene:clip-1',
        sourceId: 'artifact-project-proxy-source', frame: 0, bounds: { x: 0, y: 0, width: 10, height: 10 },
        zIndex: 20, opacity: 1, priority: 300 }
      const wrong = { ...safeMap, elements: [caption] }
      mapOverride = { ...sourceMapRow, elementsJson: JSON.stringify([caption]), mapHash: renderElementMapHash(wrong) }
    }],
    ['child geometry changed despite selection impact', () => {
      childPlanOverride = structuredClone(childPlan)
      childPlanOverride.videoTracks[0].clips[0].crop = { x: .1, y: .1, width: .8, height: .8 }
    }],
    ['source map lock lost', () => { lockFailureTable = 'render_element_maps' }],
  ]) {
    publicReadCount = 0; operationData = undefined; detailData = undefined
    mapData = undefined; mapCreates = 0; lockReads.length = 0
    mapOverride = undefined; manifestOverride = undefined; childPlanOverride = undefined; lockFailureTable = undefined
    mutate()
    await assert.rejects(repository.createOrReplay({ operation,
      authenticationAudit: materializeActorAuditContext(proxyActor()), context,
      idempotencyKey: `selection-negative-${label}`, requestFingerprint: '7'.repeat(64) }),
    (error) => error.code === 'PERSISTENCE_CONFLICT', label)
    assert.equal(operationData, undefined, label + ': transaction rolls back operation')
    assert.equal(detailData, undefined, label + ': transaction rolls back detail')
    assert.equal(mapCreates, 0, label + ': no committed map')
  }
  for (const finalOnly of [false, true]) {
    publicReadCount = 0; operationData = undefined; detailData = undefined
    mapData = undefined; mapCreates = 0; sourceReads = 0; lockReads.length = 0
    outboxRows = 0; projectState = 'revising'
    mapOverride = undefined; manifestOverride = undefined; childPlanOverride = undefined; lockFailureTable = undefined
    blockedSource = !finalOnly; finalRightsBlocked = finalOnly
    await assert.rejects(repository.createOrReplay({ operation,
      authenticationAudit: materializeActorAuditContext(proxyActor()), context,
      idempotencyKey: 'selection-rights-' + finalOnly, requestFingerprint: '7'.repeat(64) }),
    (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
    assert.equal(sourceReads, finalOnly ? 2 : 1)
    assert.equal(operationData, undefined); assert.equal(detailData, undefined); assert.equal(mapData, undefined)
    assert.equal(mapCreates, 0, 'controlled transaction rolls back only inline writes, not the prior child Version')
    assert.equal(outboxRows, 0); assert.equal(projectState, 'revising')
  }
  blockedSource = false; finalRightsBlocked = false
  publicReadCount = 0; operationData = undefined; detailData = undefined
  mapData = undefined; mapCreates = 0; sourceReads = 0; outboxRows = 0; projectState = 'revising'
  mapOverride = undefined; manifestOverride = undefined; childPlanOverride = undefined; lockFailureTable = undefined
  injectedFailure = 'context-after-outbox'
  await assert.rejects(repository.createOrReplay({ operation,
    authenticationAudit: materializeActorAuditContext(proxyActor()), context,
    idempotencyKey: 'selection-context-after-outbox', requestFingerprint: '7'.repeat(64) }),
  (error) => error.code === 'PERSISTENCE_CONFLICT')
  assert.equal(operationData, undefined); assert.equal(detailData, undefined); assert.equal(mapData, undefined)
  assert.equal(outboxRows, 0); assert.equal(projectState, 'revising')
  injectedFailure = undefined; childPlanOverride = undefined

  for (const failure of ['map', 'outbox']) {
    publicReadCount = 0; operationData = undefined; detailData = undefined
    mapData = undefined; mapCreates = 0; lockReads.length = 0
    mapOverride = undefined; manifestOverride = undefined; childPlanOverride = undefined; lockFailureTable = undefined
    injectedFailure = failure
    await assert.rejects(repository.createOrReplay({ operation,
      authenticationAudit: materializeActorAuditContext(proxyActor()), context,
      idempotencyKey: `selection-rollback-${failure}`, requestFingerprint: '7'.repeat(64) }),
      (error) => error.code === 'CONTROLLED_TRANSACTION_FAILURE')
    assert.equal(operationData, undefined); assert.equal(detailData, undefined)
    assert.equal(mapData, undefined); assert.equal(mapCreates, 0)
  }

})

async function runWithStaleRanges(ranges) {
  const immutableSource = Object.freeze({
    ...source(),
    rangeReuse: Object.freeze({
      schemaVersion: 'project-proxy-range-reuse/v1',
      commandId: 'manual-command-multi-range-test',
      impactHash: '7'.repeat(64),
      baseVersionId: 'project-version-proxy-base',
      ranges: Object.freeze(ranges.map((range) => Object.freeze({ ...range }))),
      artifactId: 'artifact-project-proxy-base',
      manifestId: 'manifest-project-proxy-base',
      artifactKey: 'workspaces/project-proxy-test/editorial-proxies/multi-base.mp4',
      sha256: '8'.repeat(64),
      byteSize: 16_384,
    }),
  })
  const operations = createOperations(immutableSource)
  let renderedRange
  let persistedManifest
  let lineageIds
  const base = dependencies(operations, {
    projects: {
      async readImmutableSource() { return immutableSource },
      async attachCompletedOutput(input) {
        base.calls.attached += 1
        base.calls.reviewed += 1
        assert.equal(input.review.proxyArtifactId, input.outputArtifactId)
        assert.ok(await operations.repository.succeed({ operationId: input.operationId,
          leaseOwner: input.lease.owner, attempt: input.lease.attempt, now: input.lease.now }))
      },
    },
    renderer: {
      async render(input) {
        renderedRange = input.rangeReuse
        return {
          outputPath: join(tmpdir(), 'project-proxy-multi-range-output.mp4'),
          sha256: 'd'.repeat(64), byteSize: 4_096,
          probe: { width: 540, height: 960, duration: 10, fps: 30, codec: 'h264', container: 'mp4' },
          renderElementMap: { schemaVersion: 'render-element-map/v1', proxyHash: 'd'.repeat(64), fps: 30, durationFrames: 300, canvas: { width: 540, height: 960 }, elements: [] },
        }
      },
      async cleanup() { base.calls.cleaned += 1 },
    },
    artifacts: {
      async persistOrReplay(input) {
        base.calls.persisted += 1
        persistedManifest = input.manifest
        lineageIds = input.lineageIds
        return { artifactId: input.artifactId, manifestId: input.manifestId, replayed: false }
      },
    },
  })
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)(
    'worker-project-proxy-multi-range',
  )
  return { outcome, renderedRange, persistedManifest, lineageIds, immutableSource, base }
}

test('T-FR-233 project proxy worker carries every stale range into renderer, recipe and lineage', async () => {
  const two = await runWithStaleRanges([
    { startFrame: 30, endFrame: 60 },
    { startFrame: 150, endFrame: 210 },
  ])

  assert.equal(two.outcome.status, 'succeeded')
  // Nothing truncates the range list to [0] on the way to the renderer.
  assert.deepEqual(two.renderedRange.ranges, [
    { startFrame: 30, endFrame: 60 },
    { startFrame: 150, endFrame: 210 },
  ])
  assert.equal(two.renderedRange.impactHash, '7'.repeat(64))
  assert.equal(two.renderedRange.commandId, 'manual-command-multi-range-test')
  assert.equal(
    two.renderedRange.path,
    join(two.base.deps.artifactRoot, two.immutableSource.rangeReuse.artifactKey),
  )
  assert.equal(two.persistedManifest.recipe.version, EDITORIAL_PROXY_RECIPE_VERSION)
  // The reused base proxy stays a declared lineage source of the new artifact.
  assert.equal(two.persistedManifest.sources.at(-1).role, 'reused-proxy-range')
  assert.equal(two.persistedManifest.sources.at(-1).sha256, two.immutableSource.rangeReuse.sha256)
  assert.equal(two.lineageIds.length, two.immutableSource.renderSources.length + 1)
  assert.equal(new Set(two.lineageIds).size, two.lineageIds.length)

  // The manifest content-addresses its recipe parameters rather than storing them
  // verbatim, so the proof that EVERY range reaches the recipe is that dropping
  // or moving one changes the recorded parametersHash.
  const truncated = await runWithStaleRanges([{ startFrame: 30, endFrame: 60 }])
  const shifted = await runWithStaleRanges([
    { startFrame: 30, endFrame: 60 },
    { startFrame: 150, endFrame: 211 },
  ])
  const hashes = [two, truncated, shifted].map((run) => run.persistedManifest.recipe.parametersHash)
  assert.ok(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)))
  assert.equal(new Set(hashes).size, 3, 'each stale-range set must address a distinct recipe')
})

test('T-FR-173 project proxy worker does not trust manually supplied perception for automatic subtitle safety', async () => {
  const persisted = (projectVersionId) => ({
    schemaVersion: 'persisted-perception-timeline/v2',
    id: 'perception-proxy-test', workspaceId: 'workspace-project-proxy-test',
    projectId: 'project-proxy-test', projectVersionId, baseRevision: null,
    timeline: SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace,
    origin: { kind: 'manual-controlled', trust: 'unverified', suppliedByClientId: 'client-proxy-test' },
    requestFingerprint: 'f'.repeat(64), idempotencyKey: 'idem-perception-proxy-test',
    authenticationAudit: {}, createdByClientId: 'client-proxy-test',
    createdAt: '2026-08-21T09:00:00.000Z', recordHash: 'e'.repeat(64),
  })
  const withPerception = (projectVersionId) => {
    const operations = createOperations()
    let seen = null
    const base = dependencies(operations)
    base.deps.projects = {
      ...base.deps.projects,
      async readImmutableSource() {
        return Object.freeze({
          ...source(),
          subtitleResolution: Object.freeze({
            presetId: 'kinetic', presetHash: subtitlePresetHash('kinetic'),
            registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: true,
            presetSnapshot: materializeSubtitlePresetSnapshot('kinetic'),
          }),
        })
      },
    }
    const attachWithFinalization = base.deps.projects.attachCompletedOutput
    let review = null
    base.deps.projects.attachCompletedOutput = async (input) => {
      review = input.review
      assert.equal(review.status, 'warning-ack-required')
      assert.equal(review.finalAllowed, false)
      assert.equal(review.formatQuality?.exportAllowed, true, 'the listed cue is a warning of the format report, not a block')
      assert.ok(review.criticIssues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' &&
        issue.severity === 'warning' && issue.evidenceRange.startFrame === 0 && issue.evidenceRange.endFrame === 60))
      return attachWithFinalization(input)
    }
    base.deps.perceptionTimelines = { async findLatest() { return persisted(projectVersionId) } }
    const originalRender = base.deps.renderer.render
    base.deps.renderer = {
      ...base.deps.renderer,
      async render(input) { seen = input; return originalRender(input) },
    }
    let manifest = null
    base.deps.artifacts = {
      async persistOrReplay(input) {
        manifest = input.manifest
        return { artifactId: input.artifactId, manifestId: input.manifestId, replayed: false }
      },
    }
    return { operations, deps: base.deps, render: () => seen, manifest: () => manifest, review: () => review }
  }

  // Even a matching manually supplied timeline cannot certify face clearance.
  const matched = withPerception('project-version-proxy-test')
  assert.deepEqual(
    await runNextProjectProxyRenderOperationService(matched.deps)('worker-project-proxy-anchor'),
    { operationId: 'operation-project-proxy-test', status: 'succeeded' },
  )
  const anchorPlan = matched.render().placementPlan.subtitleAnchorPlan
  assert.ok(anchorPlan, 'the worker must hand the renderer a decided anchor plan')
  assert.equal(anchorPlan.schemaVersion, 'subtitle-anchor-plan/v3')
  assert.equal(anchorPlan.perceptionTimelineHash, null)
  assert.equal(subtitleAnchorDecisionFor(anchorPlan, 'cue-1').anchor, null)
  assert.equal(subtitleAnchorDecisionFor(anchorPlan, 'cue-1').issues[0].code, 'FACE_PERCEPTION_UNAVAILABLE')
  const matchedParametersHash = matched.manifest().recipe.parametersHash
  assert.match(matchedParametersHash, /^[a-f0-9]{64}$/)

  // A different project version remains equally untrusted.
  const mismatched = withPerception('project-version-somewhere-else')
  assert.deepEqual(
    await runNextProjectProxyRenderOperationService(mismatched.deps)('worker-project-proxy-anchor-other'),
    { operationId: 'operation-project-proxy-test', status: 'succeeded' },
  )
  const fallbackPlan = mismatched.render().placementPlan.subtitleAnchorPlan
  assert.equal(fallbackPlan.perceptionTimelineHash, null)
  assert.equal(subtitleAnchorDecisionFor(fallbackPlan, 'cue-1').anchor, null)
  assert.equal(subtitleAnchorDecisionFor(fallbackPlan, 'cue-1').issues[0].code, 'FACE_PERCEPTION_UNAVAILABLE')

  assert.equal(anchorPlan.anchorPlanHash, fallbackPlan.anchorPlanHash)
  assert.equal(
    matched.render().placementPlan.placementPlanHash,
    mismatched.render().placementPlan.placementPlanHash,
  )
  assert.equal(matchedParametersHash, mismatched.manifest().recipe.parametersHash)
})

// ---------------------------------------------------------------------------
// F4.014 — the colour verdict reaching the gate, inside the worker
// ---------------------------------------------------------------------------

/**
 * The critic as the worker takes it, built on the REAL
 * `evaluateColorCriticService` over a fake evaluator and a fake report store.
 * Only the two things a unit test cannot have are faked — decoded frames and a
 * database — so what runs between the render and the review here is the code
 * that runs in production.
 */
function colorCriticRuntime(options = {}) {
  const calls = { evaluated: 0, cleaned: 0, located: [], measured: [] }
  const evaluator = {
    async measureStages(input) {
      calls.measured.push(input)
      if (options.evaluatorFails) {
        throw new DomainError('COLOR_MEASUREMENT_INSUFFICIENT', 'the intermediate could not be decoded')
      }
      return {
        before: [buildMeasurement({
          measurementId: 'ccm-before-worker', cameraId: 'cam-main',
          sourceAssetId: 'artifact-project-proxy-source', sourceSha256: 'c'.repeat(64),
        })],
        after: [buildMeasurement({
          measurementId: 'ccm-after-worker', cameraId: 'cam-main',
          sourceAssetId: 'artifact-project-proxy-output', sourceSha256: 'd'.repeat(64),
          ...(options.highlights !== undefined ? { highlights: options.highlights } : {}),
        })],
        evidence: [],
      }
    },
    async cleanup() { calls.cleaned += 1 },
  }
  const rows = new Map()
  const reports = {
    async persist({ report }) {
      if (options.persistFails) throw new Error('deadlock detected')
      const held = rows.get(report.reportHash)
      if (held) return { report: held, replayed: true }
      rows.set(report.reportHash, report)
      return { report, replayed: false }
    },
    async read() { return null },
    async readByHash({ reportHash }) { return rows.get(reportHash) ?? null },
    async listForProjectVersion() { return [] },
    async findDependentsOfMatchPlan() { return [] },
    async findDependentsOfMeasurement() { return [] },
  }
  const evaluate = evaluateColorCriticService({
    evaluator, reports, clock: () => new Date('2026-07-18T22:05:00.000Z'),
  })
  return {
    calls,
    rows,
    colorCritic: Object.freeze({
      async evaluate(request) { calls.evaluated += 1; return evaluate(request) },
      async cleanup(operationId) { await evaluator.cleanup(operationId) },
      async locateSession(context) { calls.located.push([...context.cameraIds]); return null },
    }),
  }
}

/** The compilation the critic can read a creative intent off. */
const criticCompilation = Object.freeze({
  ...colorCompilation,
  pipeline: Object.freeze({ ...colorCompilation.pipeline, stages: Object.freeze([]) }),
})

async function runWithCritic(options = {}) {
  const immutableSource = multicamSource()
  const operations = createOperations(immutableSource)
  const runtime = colorCriticRuntime(options)
  let review = null
  const base = dependencies(operations, {
    colorPipelines: { async read() { return { compilation: criticCompilation } } },
    projects: {
      async readImmutableSource() { return immutableSource },
      async attachCompletedOutput(input) {
        base.calls.attached += 1
        base.calls.reviewed += 1
        review = input.review
        assert.ok(await operations.repository.succeed({ operationId: input.operationId,
          leaseOwner: input.lease.owner, attempt: input.lease.attempt, now: input.lease.now }))
      },
    },
    colorCritic: runtime.colorCritic,
  })
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-color-critic')
  return { outcome, review, runtime, base }
}

test('T-F4.014 a colour rejection reaches the proxy review as a hard issue and blocks the final export', async () => {
  // The delivered frames clip 6% of their pixels: irreversible, so the verdict
  // is a rejection whatever anybody declares about it.
  const run = await runWithCritic({ highlights: 0.06 })
  assert.equal(run.outcome.status, 'succeeded', 'a rejected colour is a blocked review, not a failed render')
  assert.equal(run.runtime.calls.evaluated, 1)
  assert.deepEqual(run.runtime.calls.located, [['cam-main']],
    'the session is located by the cameras this render cut to, not by which session was touched last')
  const hard = run.review.criticIssues.filter((issue) => issue.severity === 'hard')
  assert.ok(hard.length >= 1, `the rejection never reached the review: ${JSON.stringify(run.review.criticIssues)}`)
  assert.ok(hard.some((issue) => issue.code === 'COLOR_CRITIC_REJECTED' &&
    issue.evidenceIds.some((ref) => ref.startsWith('color-critic-report:'))))
  assert.ok(run.review.criticIssues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' && issue.severity === 'warning'),
    'the cue that could not be certified is listed beside the colour rejection')
  assert.equal(run.review.status, 'blocked')
  assert.equal(run.review.finalAllowed, false)
  // The critic's intermediates and crops are released with the renderer's.
  assert.equal(run.runtime.calls.cleaned, 1, 'a full re-encode of every source per render is not a cache')
})

test('T-F4.014 a critic that was wired and could not run leaves a warning, not an approval', async () => {
  const run = await runWithCritic({ evaluatorFails: true })
  assert.equal(run.outcome.status, 'succeeded')
  const warnings = run.review.criticIssues.filter((issue) => issue.code === 'COLOR_CRITIC_UNAVAILABLE')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].severity, 'warning')
  assert.match(warnings[0].message, /was not judged/)
  assert.equal(run.review.status, 'warning-ack-required', 'the colour warning is not an approval: it, and the listed cue, wait for an acknowledgement')
  assert.equal(run.review.finalAllowed, false)
  assert.equal(run.runtime.calls.cleaned, 1, 'a failed evaluation still wrote intermediates')
})

test('T-F4.014 a rejection whose report could not be written still blocks, and says why it is unrecorded', async () => {
  // The verdict was reached on the frames and the database refused the row.
  // Reporting that as "its colour was not judged" would be false, and a person
  // could acknowledge the warning and export a rejected render.
  const run = await runWithCritic({ highlights: 0.06, persistFails: true })
  assert.equal(run.outcome.status, 'succeeded')
  assert.equal(run.runtime.rows.size, 0, 'nothing was stored')
  const hard = run.review.criticIssues.filter((issue) => issue.severity === 'hard')
  assert.ok(hard.length >= 1, `a lost row must not lose the rejection: ${JSON.stringify(run.review.criticIssues)}`)
  assert.ok(hard.some((issue) => issue.code === 'COLOR_CRITIC_REJECTED'))
  assert.ok(run.review.criticIssues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' && issue.severity === 'warning'))
  const unrecorded = run.review.criticIssues.filter((issue) => issue.code === 'COLOR_CRITIC_REPORT_UNRECORDED')
  assert.equal(unrecorded.length, 1)
  assert.match(unrecorded[0].message, /could not be recorded/)
  assert.ok(run.review.criticIssues.every((issue) => issue.code !== 'COLOR_CRITIC_UNAVAILABLE'),
    'frames that were judged must never be reported as unjudged')
  assert.equal(run.review.status, 'blocked')
  assert.equal(run.review.finalAllowed, false)
})

test('T-F4.014 an approved colour adds nothing to the review and still releases the critic work', async () => {
  const run = await runWithCritic()
  assert.equal(run.outcome.status, 'succeeded')
  assert.ok(run.review.criticIssues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE'))
  assert.ok(run.review.criticIssues.every((issue) => issue.code !== 'COLOR_CRITIC_REJECTED'))
  assert.equal(run.review.status, 'warning-ack-required', 'an approved colour leaves only the listed cue to acknowledge')
  assert.equal(run.review.finalAllowed, false)
  assert.equal(run.runtime.calls.cleaned, 1)
  assert.equal(run.runtime.rows.size, 1, 'the approving verdict is recorded too')
})

// ---------------------------------------------------------------------------------------------------------------------
// W65/W65b: captions are decided on the variant's canvas from the sealed face windows of the SOURCES the render plays.
// ---------------------------------------------------------------------------------------------------------------------
const portraitMasterSource = (extra = {}) => Object.freeze({
  ...source(),
  // a 9:16 master on the 9:16 canvas: the picture fills the frame, so every caption band lies over it and needs evidence
  renderSources: Object.freeze(source().renderSources.map((asset) => Object.freeze({ ...asset, probe: Object.freeze({ width: 720, height: 1280 }) }))),
  subtitleResolution: Object.freeze({
    presetId: 'kinetic', presetHash: subtitlePresetHash('kinetic'),
    registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: true,
    presetSnapshot: materializeSubtitlePresetSnapshot('kinetic'),
  }),
  ...extra,
})
const SEALED_SCOPE = Object.freeze({
  workspaceId: 'workspace-project-proxy-test', projectId: 'project-proxy-test',
  sourceArtifactId: 'artifact-project-proxy-source', sourceSha256: 'c'.repeat(64),
})
// A source window carries no project and no version: only the source (artifact and bytes) and the workspace it belongs to.
const faceWindow = (rowsAt, overrides = {}) => sealedSourceWindow({ start: 0, end: 300, rowsAt,
  overrides: { workspaceId: SEALED_SCOPE.workspaceId, sourceArtifactId: SEALED_SCOPE.sourceArtifactId, sourceSha256: SEALED_SCOPE.sourceSha256, ...overrides } })
const FAR_FACE = [0.9, 0.0, 0.0, 0.03, 0.05]

async function runCaptionWorker(immutableSource, envelopes) {
  const operations = createOperations(immutableSource)
  const requests = []
  const base = dependencies(operations, envelopes ? {
    faceEvidence: { async listSourceWindows(input) { requests.push(input); return envelopes.map((envelope) => ({ envelope })) } },
  } : {})
  base.deps.projects = { ...base.deps.projects, async readImmutableSource() { return immutableSource } }
  let rendered = null
  const originalRender = base.deps.renderer.render
  base.deps.renderer = { ...base.deps.renderer, async render(input) { rendered = input; return originalRender(input) } }
  let manifest = null
  base.deps.artifacts = {
    async persistOrReplay(input) { manifest = input.manifest; return { artifactId: input.artifactId, manifestId: input.manifestId, replayed: false } },
  }
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-w65-captions')
  return { outcome, rendered, review: base.attachedReview(), manifest, requests }
}

test('W65 proxy worker: a cue is drawn only where the sealed face windows of this Version certify its band', async () => {
  // no reader wired: every band over the picture is unknown, the cue is not drawn and is LISTED for review (W65b)
  const unknown = await runCaptionWorker(portraitMasterSource(), undefined)
  assert.deepEqual(unknown.outcome, { operationId: 'operation-project-proxy-test', status: 'succeeded' })
  const unknownPlan = unknown.rendered.placementPlan.subtitleAnchorPlan
  assert.equal(unknownPlan.schemaVersion, 'subtitle-anchor-plan/v3')
  assert.equal(subtitleAnchorDecisionFor(unknownPlan, 'cue-1').disposition, 'review-required')
  assert.equal(unknownPlan.policy.onNoSafeRegion, 'omit-and-list')
  assert.equal(unknown.review.status, 'warning-ack-required')
  assert.ok(unknown.review.criticIssues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' && issue.severity === 'warning'))

  // a clean, complete, authenticated stream of this exact source (by its bytes) certifies the preferred band
  const clean = await runCaptionWorker(portraitMasterSource(), [faceWindow(() => [FAR_FACE])])
  assert.equal(clean.requests.length, 1)
  assert.deepEqual({ ...clean.requests[0], now: undefined },
    { workspaceId: SEALED_SCOPE.workspaceId, projectId: SEALED_SCOPE.projectId,
      sourceArtifactId: SEALED_SCOPE.sourceArtifactId, fromSourceFrame: 0, toSourceFrame: 75, now: undefined, limit: 200 })
  const cleanDecision = subtitleAnchorDecisionFor(clean.rendered.placementPlan.subtitleAnchorPlan, 'cue-1')
  assert.equal(cleanDecision.disposition, 'placed'); assert.equal(cleanDecision.anchor, 'bottom')
  assert.ok(!clean.review.criticIssues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' || issue.code === 'NO_SAFE_SUBTITLE_REGION'))
  // the placement identity is bound into the recipe: the evidence moves the hash
  assert.notEqual(clean.manifest.recipe.parametersHash, unknown.manifest.recipe.parametersHash)

  // a detected face under the bottom of the frame moves the caption up, onto a band that is certified clear
  const faceBelow = await runCaptionWorker(portraitMasterSource(), [faceWindow((frame) => (frame === 30 ? [[0.9, 0.2, 0.74, 0.8, 0.96]] : [FAR_FACE]))])
  const movedDecision = subtitleAnchorDecisionFor(faceBelow.rendered.placementPlan.subtitleAnchorPlan, 'cue-1')
  assert.equal(movedDecision.bandAssessments.bottom.face.state, 'occupied')
  assert.equal(movedDecision.disposition, 'placed'); assert.notEqual(movedDecision.anchor, 'bottom')

  // evidence of other bytes (another source file) is not evidence of this one; evidence is NOT tied to a Version any more
  const foreign = await runCaptionWorker(portraitMasterSource(), [faceWindow(() => [FAR_FACE], { sourceSha256: 'd'.repeat(64) })])
  assert.equal(subtitleAnchorDecisionFor(foreign.rendered.placementPlan.subtitleAnchorPlan, 'cue-1').disposition, 'review-required')
  assert.equal(foreign.review.status, 'warning-ack-required')
})

test('W65 proxy worker: without the source dimensions nothing is projected; on a 16:9 master the 9:16 bottom band is certified by geometry', async () => {
  const noDimensions = await runCaptionWorker(Object.freeze({ ...portraitMasterSource(), renderSources: source().renderSources }), [faceWindow(() => [FAR_FACE])])
  const plan = noDimensions.rendered.placementPlan.subtitleAnchorPlan
  assert.equal(plan.faceClearance.projectionHash, null)
  assert.equal(subtitleAnchorDecisionFor(plan, 'cue-1').disposition, 'review-required')
  assert.equal(noDimensions.requests.length, 0)
  // 1280x720 on the 9:16 canvas is a strip; the bottom band is over the blurred copy and no source pixel is under it
  const landscapeMaster = portraitMasterSource({
    renderSources: Object.freeze(source().renderSources.map((asset) => Object.freeze({ ...asset, probe: Object.freeze({ width: 1280, height: 720 }) }))),
  })
  const geometry = await runCaptionWorker(landscapeMaster, undefined)
  const decision = subtitleAnchorDecisionFor(geometry.rendered.placementPlan.subtitleAnchorPlan, 'cue-1')
  assert.equal(decision.disposition, 'placed'); assert.equal(decision.anchor, 'bottom')
  assert.equal(decision.bandAssessments.bottom.face.evaluations[0].kind, 'geometry-outside-foreground')
  assert.equal(geometry.rendered.placementPlan.subtitleAnchorPlan.faceClearance.faceSafety, 'unknown')
})

test('W65 proxy worker: a reused range cannot carry a caption the plan draws, so the render is done in full', async () => {
  const reuse = Object.freeze({
    schemaVersion: 'project-proxy-range-reuse/v1', commandId: 'manual-command-w65-reuse', impactHash: '7'.repeat(64),
    baseVersionId: 'project-version-proxy-base', ranges: Object.freeze([Object.freeze({ startFrame: 30, endFrame: 60 })]),
    artifactId: 'artifact-project-proxy-base', manifestId: 'manifest-project-proxy-base',
    artifactKey: 'workspaces/project-proxy-test/editorial-proxies/w65-base.mp4', sha256: '8'.repeat(64), byteSize: 16_384,
  })
  // the cue is [0,60) and only [30,60) is re-rendered: a drawn caption over the kept [0,30) would be missing from the reused bytes
  const placed = await runCaptionWorker(portraitMasterSource({ rangeReuse: reuse }), [faceWindow(() => [FAR_FACE])])
  assert.equal(subtitleAnchorDecisionFor(placed.rendered.placementPlan.subtitleAnchorPlan, 'cue-1').disposition, 'placed')
  assert.equal(placed.rendered.rangeReuse, undefined)
  assert.ok(!placed.manifest.sources.some((entry) => entry.role === 'reused-proxy-range'))
  // an undrawn cue leaves the reuse alone
  const suppressed = await runCaptionWorker(portraitMasterSource({ rangeReuse: reuse }), undefined)
  assert.equal(suppressed.rendered.rangeReuse.artifactId, 'artifact-project-proxy-base')
  assert.ok(suppressed.manifest.sources.some((entry) => entry.role === 'reused-proxy-range'))
})

test('W65 proxy worker: the pixel critic is run on a plan that draws a cue, against a caption-free control render, and its verdict lands on the review', async () => {
  const requests = []
  const rendered = []
  const cleaned = []
  const operations = createOperations(portraitMasterSource())
  const base = dependencies(operations, {
    faceEvidence: { async listSourceWindows() { return [{ envelope: faceWindow(() => [FAR_FACE]) }] } },
    captionPixelCritic: {
      async verify(request) {
        requests.push(request)
        const control = await request.renderControl()
        return { samples: [], issues: [{ code: 'CAPTION_PLACEMENT_MISMATCH', severity: 'hard', cueId: 'cue-1',
          evidenceRange: { startFrame: 10, endFrame: 11 }, elementIds: ['subtitle:cue-1'], evidenceIds: [], message: `controlled mismatch ${control.path}` }] }
      },
    },
  })
  base.deps.projects = { ...base.deps.projects, async readImmutableSource() { return portraitMasterSource() } }
  const originalRender = base.deps.renderer.render
  base.deps.renderer = {
    async render(input) { rendered.push(input); return originalRender(input) },
    async cleanup(operationId) { cleaned.push(operationId) },
  }
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-w65-pixel-critic')
  assert.deepEqual(outcome, { operationId: 'operation-project-proxy-test', status: 'succeeded' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].plan.subtitleAnchorPlan.decisions[0].disposition, 'placed')
  assert.equal(requests[0].deliveredPath.endsWith('project-proxy-worker-output.mp4'), true)
  // the control is the same input without the burned cues, in its own work directory
  assert.equal(rendered.length, 2)
  assert.equal(rendered[0].subtitleCues.length, 1)
  assert.equal(rendered[1].subtitleCues.length, 0)
  assert.equal(rendered[1].operationId, 'operation-project-proxy-test-caption-control')
  assert.deepEqual({ ...rendered[1], operationId: rendered[0].operationId, subtitleCues: rendered[0].subtitleCues, signal: undefined },
    { ...rendered[0], signal: undefined })
  assert.ok(cleaned.includes('operation-project-proxy-test-caption-control'))
  const review = base.attachedReview()
  assert.equal(review.status, 'blocked')
  const issue = review.criticIssues.find((entry) => entry.code === 'CAPTION_PLACEMENT_MISMATCH')
  assert.ok(issue && issue.severity === 'hard')
  assert.equal(issue.placementPlanHash, requests[0].plan.placementPlanHash)
})

test('W65 proxy worker: no control render is paid for when the plan draws nothing, and a critic that breaks is a warning, not a failed render', async () => {
  const quiet = []
  const none = dependencies(createOperations(portraitMasterSource()), { captionPixelCritic: { async verify(request) { quiet.push(request); return { issues: [], samples: [] } } } })
  none.deps.projects = { ...none.deps.projects, async readImmutableSource() { return portraitMasterSource() } }
  assert.equal((await runNextProjectProxyRenderOperationService(none.deps)('worker-w65-pixel-critic-idle')).status, 'succeeded')
  assert.equal(quiet.length, 0, 'every cue is withheld here (no face windows), so there is nothing to verify')

  const broken = dependencies(createOperations(portraitMasterSource()), {
    faceEvidence: { async listSourceWindows() { return [{ envelope: faceWindow(() => [FAR_FACE]) }] } },
    captionPixelCritic: { async verify() { throw new Error('W65_CONTROLLED_CRITIC_FAILURE') } },
  })
  broken.deps.projects = { ...broken.deps.projects, async readImmutableSource() { return portraitMasterSource() } }
  assert.equal((await runNextProjectProxyRenderOperationService(broken.deps)('worker-w65-pixel-critic-broken')).status, 'succeeded')
  const review = broken.attachedReview()
  assert.equal(review.status, 'warning-ack-required')
  assert.deepEqual(review.criticIssues.filter((entry) => entry.code === 'FACE_PIXEL_CHECK_UNAVAILABLE').map((entry) => entry.severity), ['warning'])
})
