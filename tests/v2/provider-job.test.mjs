import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  assertProviderJob,
  createProviderJob,
  normalizeProviderStatus,
  transitionProviderJob,
} from '../../src/v2/domain/provider-job.ts'
import { runProviderJobWorkerLoop, runProviderJobWorkerOnce } from '../../src/v2/application/provider-jobs.ts'
import { ControlledAsyncMediaProviderAdapter } from '../../src/v2/infrastructure/controlled-async-media-provider.ts'

const hash = (character) => character.repeat(64)
const at = (second) => `2029-01-01T00:00:${String(second).padStart(2, '0')}.000Z`

function authorization() {
  const body = {
    id: 'provider-authorization-one',
    profileSnapshotId: 'presenter-one:v1',
    profileSnapshotHash: hash('a'),
    artifactDecisions: [{ artifactId: 'audio-one', rightsSnapshotId: 'rights-audio-one', rightsSnapshotHash: hash('b'), validUntil: '2030-01-01T00:00:00.000Z' }],
    evaluatedAt: at(0),
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
  return Object.freeze({ ...body, authorizationHash: calculateCanonicalHash(body) })
}

function planned() {
  return createProviderJob({
    id: 'provider-job-one', workspaceId: 'workspace-provider', projectId: 'project-provider',
    originProjectVersionId: 'version-provider', operation: 'audio-avatar', adapterId: 'controlled-avatar',
    adapterVersion: 'version-1', providerInput: { audioArtifactId: 'audio-one', durationMs: 2_000, locale: 'pt-BR' },
    idempotencyKey: 'provider-job-key', authorization: authorization(), createdAt: at(0),
  })
}

test('T-FR-101 ProviderJob persists every paid and trust boundary before approval', () => {
  let job = planned()
  job = transitionProviderJob(job, { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 12, estimatedLatencyMs: 3_000 } })
  job = transitionProviderJob(job, { status: 'submitted', occurredAt: at(2), providerJobId: 'controlled-job-one' })
  job = transitionProviderJob(job, { status: 'queued', occurredAt: at(3), providerStatus: 'queued' })
  job = transitionProviderJob(job, { status: 'processing', occurredAt: at(4), providerStatus: 'processing' })
  job = transitionProviderJob(job, { status: normalizeProviderStatus('completed'), occurredAt: at(5), providerStatus: 'completed' })
  job = transitionProviderJob(job, { status: 'evaluating', occurredAt: at(6), resultArtifact: { artifactId: 'ingested-avatar-one', artifactSha256: hash('c'), mediaType: 'video', byteSize: 12_345 } })
  job = transitionProviderJob(job, { status: 'approved', occurredAt: at(7), criticResultHash: hash('d') })
  assert.equal(job.status, 'approved')
  assert.equal(job.attempt, 1)
  assert.equal(job.resultArtifact.artifactId, 'ingested-avatar-one')
  assert.equal(job.completedAt, at(7))
  assertProviderJob(job)
  assert.throws(() => transitionProviderJob(job, { status: 'processing', occurredAt: at(8) }), /cannot transition/)
})

test('T-FR-101 ProviderJob fails closed on secrets, authorization drift and pre-ingest approval', () => {
  assert.throws(() => createProviderJob({
    id: 'provider-job-secret', workspaceId: 'workspace-provider', projectId: 'project-provider', originProjectVersionId: 'version-provider',
    operation: 'tts', adapterId: 'controlled-tts', adapterVersion: 'version-1', providerInput: { apiToken: 'leak' },
    idempotencyKey: 'provider-secret-key', authorization: authorization(), createdAt: at(0),
  }), /credentials/)
  const forged = { ...authorization(), profileSnapshotHash: hash('f') }
  assert.throws(() => createProviderJob({
    id: 'provider-job-forged', workspaceId: 'workspace-provider', projectId: 'project-provider', originProjectVersionId: 'version-provider',
    operation: 'tts', adapterId: 'controlled-tts', adapterVersion: 'version-1', providerInput: { text: 'Olá' },
    idempotencyKey: 'provider-forged-key', authorization: forged, createdAt: at(0),
  }), /authorization hash/)
  const estimated = transitionProviderJob(planned(), { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 1, estimatedLatencyMs: 1 } })
  const submitted = transitionProviderJob(estimated, { status: 'submitted', occurredAt: at(2), providerJobId: 'controlled-job-two' })
  const retrieving = transitionProviderJob(submitted, { status: 'retrieving', occurredAt: at(3), providerStatus: 'completed' })
  assert.throws(() => transitionProviderJob(retrieving, { status: 'approved', occurredAt: at(4), criticResultHash: hash('a') }), /cannot transition/)
})

test('T-FR-101 controlled adapter survives stage restarts and ingests before critic', async () => {
  let stored = { job: planned(), requestFingerprint: hash('e') }
  let lease
  const history = ['planned']
  const jobs = {
    async claimNext(input) {
      if (lease || ['approved', 'rejected', 'failed'].includes(stored.job.status)) return null
      lease = { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() }
      return { ...stored, lease }
    },
    async advance(input) {
      assert.equal(input.current.job.jobHash, stored.job.jobHash)
      assert.equal(input.current.lease.token, lease.token)
      stored = { ...stored, job: input.next }
      history.push(input.next.status)
      lease = undefined
      return stored
    },
  }
  const adapter = new ControlledAsyncMediaProviderAdapter('controlled-avatar', 'version-1', {
    capabilities: {
      operations: ['audio-avatar'], inputFormats: ['wav'], outputFormats: ['mp4'], locales: ['pt-BR'],
      duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: true,
      supportsIdempotency: true, supportsCancellation: false, completion: 'polling', fetchedAt: at(0), expiresAt: '2030-01-01T00:00:00.000Z',
    },
    estimate: { currency: 'USD', costMinorUnits: 12, estimatedLatencyMs: 3_000 },
    statuses: ['queued', 'processing', 'completed'],
    result: { bytes: 'controlled-video', mediaType: 'video' },
  })
  let tick = 0
  let transition = 0
  let ingested = false
  const runOnce = runProviderJobWorkerOnce({
    jobs,
    adapters: { get: ({ adapterId, adapterVersion }) => adapterId === adapter.id && adapterVersion === adapter.adapterVersion ? adapter : null },
    materializer: { async materialize({ job }) { return { ...job.input, audioUrl: 'https://signed.invalid/audio?token=ephemeral-only' } } },
    ingestor: { async ingest() { ingested = true; return { artifactId: 'ingested-avatar-one', artifactSha256: hash('c'), mediaType: 'video', byteSize: 12_345 } } },
    critic: { async evaluate({ artifact }) { assert.equal(ingested, true); assert.equal(artifact.artifactId, 'ingested-avatar-one'); return { approved: true, resultHash: hash('d') } } },
    clock: () => new Date(at(++tick)),
    createLeaseToken: () => `provider-lease-${tick}`,
    createTransitionId: () => `provider-transition-${++transition}`,
  })
  for (let stage = 0; stage < 7; stage += 1) await runOnce('provider-worker-one')
  assert.deepEqual(history, ['planned', 'estimated', 'submitted', 'queued', 'processing', 'retrieving', 'evaluating', 'approved'])
  assert.deepEqual(adapter.calls, ['capabilities', 'estimate', 'submit', 'status', 'status', 'status', 'retrieve'])
  assert.equal(stored.job.resultArtifact.artifactSha256, hash('c'))
  assert.equal(JSON.stringify(stored).includes('ephemeral-only'), false)
})

test('T-FR-101 synchronous provider completes through the durable job without polling or retrieval', async () => {
  let stored = { job: planned(), requestFingerprint: hash('e') }
  let lease
  const history = ['planned']
  const jobs = {
    async claimNext(input) {
      if (lease || ['approved', 'rejected', 'failed'].includes(stored.job.status)) return null
      lease = { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() }
      return { ...stored, lease }
    },
    async advance(input) {
      assert.equal(input.current.job.jobHash, stored.job.jobHash)
      stored = { ...stored, job: input.next }
      history.push(input.next.status)
      lease = undefined
      return stored
    },
  }
  const adapter = new ControlledAsyncMediaProviderAdapter('controlled-avatar', 'version-1', {
    capabilities: {
      operations: ['audio-avatar'], inputFormats: ['wav'], outputFormats: ['mp4'], locales: ['pt-BR'],
      duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: false,
      supportsIdempotency: false, supportsCancellation: false, completion: 'synchronous', fetchedAt: at(0), expiresAt: '2030-01-01T00:00:00.000Z',
    },
    estimate: { currency: 'USD', costMinorUnits: 9, estimatedLatencyMs: 800 },
    statuses: [],
    result: { bytes: 'immediate-video', mediaType: 'video' },
    completedAt: at(3),
    observedCost: { currency: 'USD', costMinorUnits: 9 },
  })
  let tick = 0
  let ingested = false
  const runOnce = runProviderJobWorkerOnce({
    jobs,
    adapters: { get: ({ adapterId, adapterVersion }) => adapterId === adapter.id && adapterVersion === adapter.adapterVersion ? adapter : null },
    materializer: { async materialize({ job }) { return job.input } },
    ingestor: { async ingest({ providerResult }) { assert.equal(providerResult.bytes, 'immediate-video'); ingested = true; return { artifactId: 'ingested-sync-one', artifactSha256: hash('c'), mediaType: 'video', byteSize: 777 } } },
    critic: { async evaluate({ artifact }) { assert.equal(ingested, true); assert.equal(artifact.artifactId, 'ingested-sync-one'); return { approved: true, resultHash: hash('d') } } },
    clock: () => new Date(at(++tick)),
    createLeaseToken: () => `provider-lease-sync-${tick}`,
    createTransitionId: () => `provider-transition-sync-${tick}`,
  })
  for (let stage = 0; stage < 5; stage += 1) await runOnce('provider-worker-sync')
  assert.deepEqual(history, ['planned', 'estimated', 'submitted', 'retrieving', 'evaluating', 'approved'])
  assert.deepEqual(adapter.calls, ['capabilities', 'estimate', 'submit'])
  assert.equal(stored.job.providerJobId, 'controlled-avatar:provider-job-key')
  assert.equal(stored.job.providerStatus, 'completed')
  assert.equal(stored.job.resultArtifact.artifactSha256, hash('c'))
  assert.equal(stored.job.attempt, 1)
})

test('T-FR-101 provider failure is normalized without persisting upstream diagnostics', async () => {
  let stored = { job: transitionProviderJob(planned(), { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 1, estimatedLatencyMs: 1 } }), requestFingerprint: hash('e') }
  const jobs = {
    async claimNext(input) { return { ...stored, lease: { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() } } },
    async advance(input) { stored = { ...stored, job: input.next }; return stored },
  }
  const runOnce = runProviderJobWorkerOnce({
    jobs,
    adapters: { get: () => ({
      id: 'controlled-avatar', adapterVersion: 'version-1', configHash: hash('g'),
      async submit() { const error = new Error('secret upstream response must never persist'); error.code = 'UPSTREAM_DENIED'; error.retryable = true; throw error },
    }) },
    materializer: { async materialize({ job }) { return job.input } },
    ingestor: { async ingest() { throw new Error('unreachable') } },
    critic: { async evaluate() { throw new Error('unreachable') } },
    clock: () => new Date(at(2)), createLeaseToken: () => 'provider-lease-redaction', createTransitionId: () => 'provider-transition-redaction',
  })
  await runOnce('provider-worker-redaction')
  assert.deepEqual(stored.job.normalizedError, { code: 'UPSTREAM_DENIED', message: 'Provider operation failed', retryable: true })
  assert.equal(JSON.stringify(stored).includes('secret upstream'), false)
})

test('T-FR-101 supervised provider loop stays idle, isolates iteration failure and stops on abort', async () => {
  const controller = new AbortController()
  const calls = []
  let failures = 0
  await runProviderJobWorkerLoop({
    workerId: 'provider-worker-loop', signal: controller.signal, pollIntervalMs: 100,
    runNext: async (workerId) => {
      calls.push(workerId)
      if (calls.length === 1) throw new Error('transient repository failure')
      if (calls.length === 3) controller.abort()
      return calls.length === 2 ? { status: 'estimated' } : null
    },
    onIterationError: () => { failures += 1 },
    wait: async () => {},
  })
  assert.deepEqual(calls, ['provider-worker-loop', 'provider-worker-loop', 'provider-worker-loop'])
  assert.equal(failures, 1)
})
