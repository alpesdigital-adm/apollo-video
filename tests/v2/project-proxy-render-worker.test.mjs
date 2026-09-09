import assert from 'node:assert/strict'
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
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaRenderablePlanSnapshotRepository } from '../../src/v2/infrastructure/prisma/renderable-plan-snapshot-repository.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { SUBTITLE_ANCHOR_PERCEPTION_FIXTURES, subtitleAnchorDecisionFor } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { materializeSubtitlePresetSnapshot, SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } from '../../src/v2/domain/subtitle-system.ts'
import { evaluateColorCriticService } from '../../src/v2/application/color-critic.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { buildMeasurement } from './wave20-fixtures.mjs'

const colorCompilation = Object.freeze({
  id: 'color-pipeline-proxy-test', sourceArtifactId: 'artifact-project-proxy-source',
  sourceManifestId: 'manifest-project-proxy-source', compilationHash: '8'.repeat(64),
  pipeline: Object.freeze({ pipelineHash: '9'.repeat(64) }),
})
const colorPipelineBindings = Object.freeze([Object.freeze({
  sourceArtifactId: colorCompilation.sourceArtifactId, sourceManifestId: colorCompilation.sourceManifestId,
  compilationId: colorCompilation.id, compilationHash: colorCompilation.compilationHash,
  pipelineHash: colorCompilation.pipeline.pipelineHash,
})])

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
      subtitleTracks: Object.freeze([{ cues: Object.freeze([
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
  const artifactRoot = join(tmpdir(), 'apollo-project-proxy-worker-artifacts')
  const deps = {
    async catalogOutput(input) { calls.cataloged += 1; assert.equal(input.artifactId, 'artifact-project-proxy-output') },
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
      async promoteDerived() {
        return { key: 'workspaces/project-proxy-test/editorial-proxies/output.mp4', sha256: 'd'.repeat(64), byteSize: 4096 }
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
    // No perception recorded for this project: the anchor decision then has nothing to consult and
    // the render keeps the reserved bottom band, which is the Director's face-safe fallback.
    perceptionTimelines: { async findLatest() { return null } },
    renderElementMaps: {
      async persistOrReplay(input) {
        calls.mapped += 1
        assert.equal(input.proxyArtifactId, 'artifact-project-proxy-output')
        assert.equal(input.map.proxyHash, 'd'.repeat(64))
        return { record: {}, replayed: false }
      },
    },
    proxyReviews: {
      async persistGenerated(input) {
        calls.reviewed += 1
        assert.equal(input.review.proxyArtifactId, 'artifact-project-proxy-output')
        assert.equal(input.review.status, 'ready-for-final')
        assert.equal(input.review.finalAllowed, true)
        assert.equal(input.review.spec.codec, 'h264')
        assert.equal(input.review.spec.width, 540)
        assert.equal(input.review.spec.height, 960)
        assert.ok(input.review.timeToFirstProxyMs >= 120_000)
        return { ...input.review, id: input.id }
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
  return { calls, deps }
}

test('project proxy worker materializes, attaches and settles the exact immutable output', async () => {
  const operations = createOperations()
  const { calls, deps } = dependencies(operations)
  const outcome = await runNextProjectProxyRenderOperationService(deps)('worker-project-proxy-success')

  assert.deepEqual(outcome, { operationId: 'operation-project-proxy-test', status: 'succeeded' })
  assert.equal(operations.operation.status, 'succeeded')
  assert.deepEqual(operations.operation.result.resource, operations.operation.target)
  assert.deepEqual(calls, { attached: 1, cleaned: 1, lutCleaned: 1, persisted: 1, mapped: 1, reviewed: 1, cataloged: 1 })
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
    },
  } })
  const outcome = await runNextProjectProxyRenderOperationService(base.deps)('worker-snapshot-proxy-test')
  assert.deepEqual(outcome, { operationId: 'operation-project-proxy-test', status: 'succeeded' })
  assert.equal(snapshotAttached, 1)
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
      async attachCompletedOutput() { base.calls.attached += 1 },
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

test('proxy enqueue fails closed when a committed Command result is no longer current', async () => {
  await assert.rejects(
    enqueueProjectProxyRenderService({
      projects: { async readCurrentSource() { return source() } },
      colorPipelines: { async readForSources() { throw new Error('must not run') } },
      operations: { async findReplay() { throw new Error('must not run') } },
      clock: () => new Date('2026-07-31T22:40:00.000Z'),
      createId: (kind) => `created-${kind}-version-fence`,
    })({
      workspaceId: 'workspace-project-proxy-test',
      projectId: 'project-proxy-test',
      expectedProjectVersionId: 'project-version-command-result',
      actor: proxyActor(),
      idempotencyKey: 'proxy-version-fence-test',
    }),
    (error) => error.code === 'VERSION_CONFLICT' && error.details.currentProjectVersionId === 'project-version-proxy-test',
  )
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
  const editPlan = source().editPlan
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
  const bindingsJson = stableSerialize(colorPipelineBindings)
  const repository = new PrismaPublicOperationRepository({
    async $transaction(callback) {
      return callback({
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
        v2PublicEventOutbox: { async createMany() { return { count: 2 } } },
        v2ProjectVersion: { async findFirst() { return {
          id: resultVersionId,
          parentVersionId: baseVersionId,
          command: {
            id: commandId,
            type: 'manual-edit',
            baseVersionId,
            payloadJson: JSON.stringify({ impact }),
          },
        } } },
        v2ProjectProxyRenderOperation: {
          async findFirst() { return { colorPipelineBindingsJson: bindingsJson } },
          async create({ data }) { detailData = data },
        },
        v2MediaArtifact: { async findFirst() { return { id: context.outputArtifactId } } },
        v2MediaArtifactManifest: { async findFirst() { return { id: context.outputManifestId } } },
      })
    },
  })
  const persisted = await repository.createOrReplay({
    operation,
    authenticationAudit: materializeActorAuditContext(proxyActor()),
    context,
    idempotencyKey: 'selection-proxy-persistence-test',
    requestFingerprint: '7'.repeat(64),
  })
  assert.equal(persisted.operation.status, 'succeeded')
  assert.equal(persisted.context.kind, 'project-proxy-reuse')
  assert.equal(persisted.context.reusedFromOperationId, context.reusedFromOperationId)
  assert.equal(detailData.outputArtifactId, context.outputArtifactId)
  assert.equal(detailData.colorPipelineBindingsJson, bindingsJson)
  assert.equal(detailData.reuseCommandId, commandId)
  assert.equal(detailData.reuseImpactHash, impact.impactHash)
  assert.equal(detailData.reuseBaseVersionId, baseVersionId)
  assert.equal(operationData.resultJson, stableSerialize(operation.result))

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
      async attachCompletedOutput() { base.calls.attached += 1 },
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

test('T-FR-173 project proxy worker decides the subtitle anchor from persisted perception and carries it into recipe and critic', async () => {
  const persisted = (projectVersionId) => ({
    schemaVersion: 'persisted-perception-timeline/v1',
    id: 'perception-proxy-test', workspaceId: 'workspace-project-proxy-test',
    projectId: 'project-proxy-test', projectVersionId, baseRevision: null,
    timeline: SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace,
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
    return { operations, deps: base.deps, render: () => seen, manifest: () => manifest }
  }

  // The perception recorded for THIS version decides the anchor, and the renderer receives it.
  const matched = withPerception('project-version-proxy-test')
  assert.deepEqual(
    await runNextProjectProxyRenderOperationService(matched.deps)('worker-project-proxy-anchor'),
    { operationId: 'operation-project-proxy-test', status: 'succeeded' },
  )
  const anchorPlan = matched.render().placementPlan.subtitleAnchorPlan
  assert.ok(anchorPlan, 'the worker must hand the renderer a decided anchor plan')
  assert.equal(anchorPlan.perceptionTimelineHash, SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace.timelineHash)
  assert.equal(subtitleAnchorDecisionFor(anchorPlan, 'cue-1').anchor, 'upper-third')
  const matchedParametersHash = matched.manifest().recipe.parametersHash
  assert.match(matchedParametersHash, /^[a-f0-9]{64}$/)

  // Perception recorded against another version is not evidence about these frames.
  const mismatched = withPerception('project-version-somewhere-else')
  assert.deepEqual(
    await runNextProjectProxyRenderOperationService(mismatched.deps)('worker-project-proxy-anchor-other'),
    { operationId: 'operation-project-proxy-test', status: 'succeeded' },
  )
  const fallbackPlan = mismatched.render().placementPlan.subtitleAnchorPlan
  assert.equal(fallbackPlan.perceptionTimelineHash, null)
  assert.equal(subtitleAnchorDecisionFor(fallbackPlan, 'cue-1').anchor, 'bottom')

  // The decision is part of the artifact identity, not a runtime detail that vanishes after render:
  // the same sources with a different anchor decision address a different recipe and a different
  // placement plan, so a replay can never silently substitute one for the other.
  assert.notEqual(anchorPlan.anchorPlanHash, fallbackPlan.anchorPlanHash)
  assert.notEqual(
    matched.render().placementPlan.placementPlanHash,
    mismatched.render().placementPlan.placementPlanHash,
  )
  assert.notEqual(matchedParametersHash, mismatched.manifest().recipe.parametersHash)
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
      async attachCompletedOutput() { base.calls.attached += 1 },
    },
    proxyReviews: {
      async persistGenerated(input) {
        base.calls.reviewed += 1
        review = input.review
        return { ...input.review, id: input.id }
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
  assert.ok(hard.every((issue) => issue.code === 'COLOR_CRITIC_REJECTED'))
  assert.ok(hard.every((issue) => issue.evidenceIds.some((ref) => ref.startsWith('color-critic-report:'))))
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
  assert.equal(run.review.status, 'warning-ack-required')
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
  assert.ok(hard.every((issue) => issue.code === 'COLOR_CRITIC_REJECTED'))
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
  assert.deepEqual(run.review.criticIssues, [])
  assert.equal(run.review.status, 'ready-for-final')
  assert.equal(run.review.finalAllowed, true)
  assert.equal(run.runtime.calls.cleaned, 1)
  assert.equal(run.runtime.rows.size, 1, 'the approving verdict is recorded too')
})
