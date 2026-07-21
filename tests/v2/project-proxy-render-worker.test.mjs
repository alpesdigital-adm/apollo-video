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
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'

function createClock() {
  let current = Date.parse('2026-07-18T22:00:00.000Z')
  return () => new Date((current += 100))
}

function createOperations() {
  let operation = createQueuedPublicOperation({
    id: 'operation-project-proxy-test',
    workspaceId: 'workspace-project-proxy-test',
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
    inputHash: 'a'.repeat(64),
    outputArtifactId: 'artifact-project-proxy-output',
    outputManifestId: 'manifest-project-proxy-output',
    originalFileName: 'source-editorial.mp4',
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
      fps: 30,
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
    originalFileName: 'source.mp4',
  })
}

function dependencies(operations, overrides = {}) {
  const calls = { attached: 0, cleaned: 0, persisted: 0, mapped: 0 }
  const deps = {
    operations: operations.repository,
    projects: {
      async readImmutableSource() { return source() },
      async attachCompletedOutput(input) {
        calls.attached += 1
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
        assert.deepEqual(input.subtitleCues, [{ id: 'cue-1', startFrame: 0, endFrame: 60, text: 'Legenda segura', anchor: 'bottom' }])
        assert.deepEqual(input.transitions, [])
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
    renderElementMaps: {
      async persistOrReplay(input) {
        calls.mapped += 1
        assert.equal(input.proxyArtifactId, 'artifact-project-proxy-output')
        assert.equal(input.map.proxyHash, 'd'.repeat(64))
        return { record: {}, replayed: false }
      },
    },
    artifactRoot: join(tmpdir(), 'apollo-project-proxy-worker-artifacts'),
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
  assert.deepEqual(calls, { attached: 1, cleaned: 1, persisted: 1, mapped: 1 })
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
  assert.deepEqual(base.calls, { attached: 0, cleaned: 0, persisted: 0, mapped: 0 })
})
