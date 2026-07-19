import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { enqueueProjectFinalExportService } from '../../src/v2/application/enqueue-project-final-export.ts'
import { runNextProjectFinalExportOperationService } from '../../src/v2/application/run-project-final-export-worker.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'

const workspaceId = 'workspace-final-export-test'
const projectId = 'project-final-export-test'
const projectVersionId = 'project-version-final-export-test'
const sourceArtifactId = 'artifact-final-export-source'
const sourceManifestId = 'manifest-final-export-source'

function rightsSnapshot() {
  return createAssetRightsSnapshot({
    id: 'rights-final-export-test',
    workspaceId,
    artifactId: sourceArtifactId,
    sequence: 1,
    draft: {
      status: 'approved',
      allowedUses: ['rendering'],
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
      fps: 30.000000097244733,
      movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
      subtitleTracks: Object.freeze([{ cues: Object.freeze([
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
    sourceArtifactId,
    sourceManifestId,
    sourceArtifactKey: 'workspaces/final-export/masters/source.mp4',
    sourceSha256: '4'.repeat(64),
    originalFileName: 'gravacao-bruta.mp4',
  })
}

test('final export enqueue binds approval, exact Director evidence and 1080x1920 output idempotently', async () => {
  let created
  const replays = new Map()
  const operations = {
    async findReplay(input) { return replays.get(`${input.clientId}:${input.idempotencyKey}`) ?? null },
    async createOrReplay(input) {
      created = input
      const result = { operation: input.operation, context: input.context, replayed: false }
      replays.set(`${input.operation.clientId}:${input.idempotencyKey}`, result)
      return result
    },
  }
  const ids = { operation: 0, artifact: 0, manifest: 0 }
  const enqueue = enqueueProjectFinalExportService({
    projects: { async readApprovedCurrentSource() { return approvedSource() } },
    rights: { async findCurrent() { return { snapshot: rightsSnapshot(), revision: 'revision-1' } } },
    operations,
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
    actor: { type: 'api-client', id: 'client-final-export-test' },
    idempotencyKey: 'final-export-request-1',
  }

  const first = await enqueue(request)
  const replay = await enqueue(request)

  assert.equal(first.operation.type, 'project-final-export')
  assert.equal(first.context.directorRunId, 'director-run-final-export-test')
  assert.equal(first.context.qualitySnapshotHash, '3'.repeat(64))
  assert.deepEqual(first.context.outputSpec, { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 })
  assert.deepEqual(first.context.approval, {
    actorType: 'api-client', actorId: 'client-final-export-test',
    approvedAt: '2026-07-19T01:05:00.000Z', note: 'Aprovado para publicação.',
  })
  assert.match(first.context.inputHash, /^[a-f0-9]{64}$/)
  assert.equal(replay.operation.id, first.operation.id)
  assert.equal(created.requestFingerprint.length, 64)
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
    actor: { type: 'api-client', id: 'client-final-export-test' },
    idempotencyKey: 'final-export-blocked',
  }), (error) => error instanceof DomainError && error.code === 'ASSET_RIGHTS_BLOCKED')
})

function createOperations() {
  let operation = createQueuedPublicOperation({
    id: 'operation-final-export-test',
    workspaceId,
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
    sourceArtifactId,
    sourceManifestId,
    inputHash: '5'.repeat(64),
    outputArtifactId: 'artifact-final-output',
    outputManifestId: 'manifest-final-output',
    outputSpec: { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 },
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
  const calls = { rights: 0, rendered: 0, persisted: 0, converged: 0, attached: 0, failed: 0, cleaned: 0 }
  return {
    calls,
    dependencies: {
      operations: operations.repository,
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
            `lineage-${createHash('sha256').update(`${workspaceId}:${'5'.repeat(64)}:manifest-final-output:final`).digest('hex')}`,
          ])
          assert.equal(input.manifest.schemaVersion, 'media-artifact-manifest/v3')
          assert.equal(input.manifest.recipe.parametersRef, input.recipeParameters.ref)
          const parameters = JSON.parse(input.recipeParameters.canonicalJson)
          assert.equal(parameters.directorRunId, 'director-run-final-export-test')
          assert.equal(parameters.qualitySnapshotId, 'quality-snapshot-final-export-test')
          assert.deepEqual(parameters.outputSpec, { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 })
          assert.deepEqual(input.manifest.probe, { width: 1080, height: 1920, duration: 10, fps: 30 })
          return { ...persistedIdentity, replayed: false }
        },
      },
      storage: {
        async promoteDerived(input) {
          assert.equal(input.prefix, 'final-exports')
          return { key: 'workspaces/final-export/final-exports/output.mp4', sha256: '6'.repeat(64), byteSize: 8192 }
        },
      },
      renderer: {
        async render(input) {
          calls.rendered += 1
          assert.equal(input.renderKind, 'final')
          assert.equal(input.fps, 30)
          assert.deepEqual(input.outputSpec, { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 })
          return {
            outputPath: join(tmpdir(), 'apollo-final-export-output.mp4'),
            sha256: '6'.repeat(64), byteSize: 8192,
            probe: { width: 1080, height: 1920, duration: 10, fps: 30, codec: 'h264', container: 'mp4' },
          }
        },
        async cleanup() { calls.cleaned += 1 },
      },
      artifactRoot: join(tmpdir(), 'apollo-final-export-artifacts'),
      clock: () => new Date((now += 100)),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 1_000,
    },
  }
}

test('final export worker revalidates rights, persists lineage and completes the project', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations)
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-success')

  assert.deepEqual(calls, { rights: 2, rendered: 1, persisted: 1, converged: 0, attached: 1, failed: 0, cleaned: 1 })
  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'succeeded' })
  assert.equal(operations.operation.status, 'succeeded')
})

test('final export worker fails closed if rights are revoked before persistence', async () => {
  const operations = createOperations()
  const { calls, dependencies } = workerDependencies(operations, (call) => call === 1 ? rightsSnapshot() : null)
  const outcome = await runNextProjectFinalExportOperationService(dependencies)('worker-final-export-revoked')

  assert.deepEqual(outcome, { operationId: 'operation-final-export-test', status: 'failed' })
  assert.equal(operations.operation.status, 'failed')
  assert.deepEqual(calls, { rights: 2, rendered: 1, persisted: 0, converged: 0, attached: 0, failed: 1, cleaned: 1 })
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
