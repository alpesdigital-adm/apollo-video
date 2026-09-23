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
import { createProviderExecutionReceipt } from '../../src/v2/application/provider-transport-observation.ts'
import { createProviderTransportObservation } from '../../src/v2/application/provider-transport-observation.ts'
import { createProviderJobTransportState } from '../../src/v2/domain/provider-job-transport.ts'
import { ProviderAdapterError } from '../../src/v2/domain/provider-contract.ts'

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

function planned(transport) {
  return createProviderJob({
    id: 'provider-job-one', workspaceId: 'workspace-provider', projectId: 'project-provider',
    originProjectVersionId: 'version-provider', operation: 'audio-avatar', adapterId: 'controlled-avatar',
    adapterVersion: 'version-1', providerInput: { audioArtifactId: 'audio-one', durationMs: 2_000, locale: 'pt-BR' },
    idempotencyKey: 'provider-job-key', authorization: authorization(), createdAt: at(0), transport,
  })
}

function runtimeEvidence() {
  const evidence = []
  return {
    provenance: {
      async recordEvidence({ evidence: value }) { evidence.push(value); return { evidence: value, replayed: false } },
      async listEvidenceByJob() { return evidence },
      async createReceipt({ receipt }) { return { receipt, replayed: false } },
      async readReceiptByJob() { return null },
    },
    resultArtifacts: {
      async listByJob({ workspaceId, projectId, jobId }) { return [{ id: `${jobId}-result`, workspaceId, projectId, jobId, recordHash: hash('9'), role: 'primary-video', artifactId: 'controlled-result', artifactSha256: hash('c'), byteSize: 777 }] },
    },
  }
}

test('W24.2 receipt identity survives a new worker lease after post-commit crash', () => {
  const base = { schemaVersion: 'provider-execution-receipt/v1', id: 'provider-receipt-one', workspaceId: 'workspace-provider', projectId: 'project-provider', jobId: 'provider-job-one', attempt: 1, runtimeClass: 'controlled', adapterId: 'controlled-avatar', adapterVersion: 'version-1', adapterConfigHash: hash('1'), inputHash: hash('2'), authorizationHash: hash('3'), providerJobRef: 'controlled-avatar:provider-job-key', submitEvidenceId: 'provider-evidence-submit', submitEvidenceHash: hash('4'), results: [{ resultRecordId: 'provider-result-one', resultRecordHash: hash('5'), role: 'primary-video', artifactId: 'artifact-one', artifactSha256: hash('6'), byteSize: 123 }], createdAt: at(1) }
  const first = createProviderExecutionReceipt({ ...base, leaseOwner: 'worker-one', leaseToken: 'lease-one' })
  const replay = createProviderExecutionReceipt({ ...base, leaseOwner: 'worker-two', leaseToken: 'lease-two', createdAt: at(2) })
  assert.equal(replay.receiptHash, first.receiptHash)
})

test('W24.2 transport observation builder projects only server-owned input fields', () => {
  const observation = createProviderTransportObservation({
    phase: 'retrieve', runtimeClass: 'controlled', adapterId: 'controlled-avatar', adapterVersion: 'version-1',
    adapterConfigHash: hash('1'), endpointClass: 'controlled-adapter', method: 'CALL',
    requestHash: hash('2'), responseHash: hash('3'), responseStatus: 200,
    providerJobRef: 'controlled-avatar:provider-job-key', observedAt: at(1),
  })
  const rebuilt = createProviderTransportObservation({ ...observation })
  assert.deepEqual(rebuilt, observation)
})

test('T-FR-101 ProviderJob persists every paid and trust boundary before approval', () => {
  let job = planned()
  job = transitionProviderJob(job, { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 12, estimatedLatencyMs: 3_000 } })
  job = transitionProviderJob(job, { status: 'submitting', occurredAt: at(2) })
  job = transitionProviderJob(job, { status: 'submitted', occurredAt: at(3), providerJobId: 'controlled-job-one' })
  job = transitionProviderJob(job, { status: 'queued', occurredAt: at(4), providerStatus: 'queued' })
  job = transitionProviderJob(job, { status: 'processing', occurredAt: at(5), providerStatus: 'processing' })
  job = transitionProviderJob(job, { status: normalizeProviderStatus('completed'), occurredAt: at(6), providerStatus: 'completed' })
  job = transitionProviderJob(job, { status: 'evaluating', occurredAt: at(7), resultArtifact: { artifactId: 'ingested-avatar-one', artifactSha256: hash('c'), mediaType: 'video', byteSize: 12_345 } })
  job = transitionProviderJob(job, { status: 'approved', occurredAt: at(8), criticResultHash: hash('d') })
  assert.equal(job.status, 'approved')
  assert.equal(job.attempt, 1)
  assert.equal(job.resultArtifact.artifactId, 'ingested-avatar-one')
  assert.equal(job.completedAt, at(8))
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
  const submitting = transitionProviderJob(estimated, { status: 'submitting', occurredAt: at(2) })
  const submitted = transitionProviderJob(submitting, { status: 'submitted', occurredAt: at(3), providerJobId: 'controlled-job-two' })
  const retrieving = transitionProviderJob(submitted, { status: 'retrieving', occurredAt: at(4), providerStatus: 'completed' })
  assert.throws(() => transitionProviderJob(retrieving, { status: 'approved', occurredAt: at(5), criticResultHash: hash('a') }), /cannot transition/)
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
    async beginSubmission(input) {
      assert.equal(input.current.job.jobHash, stored.job.jobHash)
      assert.equal(input.current.lease.token, lease.token)
      stored = { ...stored, job: input.next }
      history.push(input.next.status)
      return { ...stored, lease }
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
    result: { bytes: 'controlled-video', mediaType: 'video', observedCost: { currency: 'USD', costMinorUnits: 11 } },
  })
  let tick = 0
  let transition = 0
  let ingested = false
  const runOnce = runProviderJobWorkerOnce({
    ...runtimeEvidence(),
    jobs,
    adapters: { get: ({ adapterId, adapterVersion }) => adapterId === adapter.id && adapterVersion === adapter.adapterVersion ? adapter : null },
    materializer: { async materialize({ job }) { return { ...job.input, audioUrl: 'https://signed.invalid/audio?token=ephemeral-only' } } },
    ingestor: { async ingest() { ingested = true; return { artifactId: 'ingested-avatar-one', artifactSha256: hash('c'), mediaType: 'video', byteSize: 12_345 } } },
    critic: { async evaluate({ artifact }) { assert.equal(ingested, true); assert.equal(artifact.artifactId, 'ingested-avatar-one'); return { approved: true, resultHash: hash('d') } } },
    clock: () => new Date(at(++tick)),
    createLeaseToken: () => `provider-lease-${tick}`,
    createTransitionId: () => `provider-transition-${++transition}`,
  })
  for (let stage = 0; stage < 8; stage += 1) await runOnce('provider-worker-one')
  assert.deepEqual(history, ['planned', 'estimated', 'submitting', 'submitted', 'queued', 'processing', 'retrieving', 'retrieving', 'evaluating', 'approved'])
  assert.deepEqual(adapter.calls, ['capabilities', 'estimate', 'submit', 'status', 'status', 'status', 'retrieve', 'capabilities'])
  assert.equal(stored.job.resultArtifact.artifactSha256, hash('c'))
  assert.deepEqual(stored.job.observedCost, { currency: 'USD', costMinorUnits: 11 })
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
    async beginSubmission(input) {
      assert.equal(input.current.job.jobHash, stored.job.jobHash)
      stored = { ...stored, job: input.next }
      history.push(input.next.status)
      return { ...stored, lease }
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
    ...runtimeEvidence(),
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
  assert.deepEqual(history, ['planned', 'estimated', 'submitting', 'submitted', 'retrieving', 'evaluating', 'approved'])
  assert.deepEqual(adapter.calls, ['capabilities', 'estimate', 'submit', 'capabilities'])
  assert.equal(stored.job.providerJobId, 'controlled-avatar:provider-job-key')
  assert.equal(stored.job.providerStatus, 'completed')
  assert.equal(stored.job.resultArtifact.artifactSha256, hash('c'))
  assert.equal(stored.job.attempt, 1)
})

test('T-FR-101 provider failure is normalized without persisting upstream diagnostics', async () => {
  let stored = { job: transitionProviderJob(planned(), { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 1, estimatedLatencyMs: 1 } }), requestFingerprint: hash('e') }
  const jobs = {
    async claimNext(input) { return { ...stored, lease: { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() } } },
    async beginSubmission(input) { stored = { ...stored, job: input.next }; return { ...stored, lease: input.current.lease } },
    async advance(input) { stored = { ...stored, job: input.next }; return stored },
  }
  const runOnce = runProviderJobWorkerOnce({
    ...runtimeEvidence(),
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

test('T-FR-101 ambiguous non-idempotent submission is never repeated after a worker crash', async () => {
  let stored = {
    job: transitionProviderJob(planned(), {
      status: 'estimated', occurredAt: at(1),
      estimate: { currency: 'USD', costMinorUnits: 9, estimatedLatencyMs: 800 },
    }),
    requestFingerprint: hash('e'),
  }
  let lease
  let loseFirstOutcome = true
  const jobs = {
    async claimNext(input) {
      lease = { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() }
      return { ...stored, lease }
    },
    async beginSubmission(input) {
      stored = { ...stored, job: input.next }
      return { ...stored, lease: input.current.lease }
    },
    async advance(input) {
      if (loseFirstOutcome && input.next.status === 'submitted') {
        loseFirstOutcome = false
        lease = undefined
        throw new Error('simulated process loss after provider response')
      }
      stored = { ...stored, job: input.next }
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
    statuses: [], result: { bytes: 'immediate-video', mediaType: 'video' }, completedAt: at(2),
  })
  let tick = 1
  const runOnce = runProviderJobWorkerOnce({
    ...runtimeEvidence(),
    resultArtifacts: { async listByJob() { return [] } },
    jobs,
    adapters: { get: () => adapter },
    materializer: { async materialize({ job }) { return job.input } },
    ingestor: { async ingest() { return { artifactId: 'ambiguous-result', artifactSha256: hash('c'), mediaType: 'video', byteSize: 777 } } },
    critic: { async evaluate() { throw new Error('unreachable') } },
    clock: () => new Date(at(++tick)),
    createLeaseToken: () => `ambiguous-lease-${tick}`,
    createTransitionId: () => `ambiguous-transition-${tick}`,
  })

  await assert.rejects(runOnce('provider-worker-before-crash'), /simulated process loss/)
  assert.equal(stored.job.status, 'submitting')
  assert.equal(adapter.calls.filter((call) => call === 'submit').length, 1)

  await runOnce('provider-worker-after-crash')
  assert.equal(stored.job.status, 'failed')
  assert.equal(stored.job.normalizedError.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(stored.job.normalizedError.retryable, false)
  assert.equal(adapter.calls.filter((call) => call === 'submit').length, 1)
})

test('W24.2 synchronous restart recovers from attested submit plus complete canonical ledger', async () => {
  let stored = { job: transitionProviderJob(planned(), { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 9, estimatedLatencyMs: 800 } }), requestFingerprint: hash('e') }
  let loseAdvance = true
  const jobs = {
    async claimNext(input) { return { ...stored, lease: { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() } } },
    async renewLease({ current, leaseExpiresAt }) { return { ...current, lease: { ...current.lease, expiresAt: leaseExpiresAt.toISOString() } } },
    async beginSubmission(input) { stored = { ...stored, job: input.next }; return { ...stored, lease: input.current.lease } },
    async advance(input) {
      if (loseAdvance && input.next.status === 'submitted') { loseAdvance = false; throw new Error('lost sync advance after ledger') }
      stored = { ...stored, job: input.next }; return stored
    },
  }
  const adapter = new ControlledAsyncMediaProviderAdapter('controlled-avatar', 'version-1', {
    capabilities: { operations: ['audio-avatar'], inputFormats: ['wav'], outputFormats: ['mp4'], duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: false, supportsIdempotency: false, supportsCancellation: false, completion: 'synchronous', fetchedAt: at(0), expiresAt: '2030-01-01T00:00:00.000Z' },
    estimate: { currency: 'USD', costMinorUnits: 9, estimatedLatencyMs: 800 }, statuses: [], result: { bytes: 'immediate-video' }, completedAt: at(2),
  })
  const runtime = runtimeEvidence()
  let tick = 1
  const runOnce = runProviderJobWorkerOnce({
    ...runtime, jobs, adapters: { get: () => adapter }, materializer: { async materialize({ job }) { return job.input } },
    ingestor: { async ingest() { return { artifactId: 'sync-ledger-result', artifactSha256: hash('c'), mediaType: 'video', byteSize: 777 } } },
    resultArtifacts: { async listByJob({ workspaceId, projectId, jobId }) { return [{ id: 'sync-ledger-record', workspaceId, projectId, jobId, schemaVersion: 'provider-result-artifact/v1', role: 'primary-video', providerJobRef: 'controlled-avatar:provider-job-key', artifactId: 'sync-ledger-result', artifactSha256: hash('c'), byteSize: 777, mediaType: 'video', container: 'mp4', adapterId: 'controlled-avatar', adapterVersion: 'version-1', adapterConfigHash: adapter.configHash, inputHash: stored.job.inputHash, authorizationHash: stored.job.authorization.authorizationHash, completedAt: at(2), createdAt: at(2), recordHash: hash('9') }] } },
    critic: { async evaluate() { throw new Error('unreachable') } }, clock: () => new Date(at(++tick)),
    createLeaseToken: () => `sync-recovery-lease-${tick}`, createTransitionId: () => `sync-recovery-transition-${tick}`,
  })
  await assert.rejects(runOnce('provider-worker-sync-recovery-first'), /lost sync advance/)
  assert.equal(stored.job.status, 'submitting')
  await runOnce('provider-worker-sync-recovery-second')
  assert.equal(stored.job.status, 'submitted')
  assert.equal(stored.job.providerStatus, 'completed')
  assert.equal(stored.job.resultArtifact.artifactId, 'sync-ledger-result')
  assert.equal(adapter.calls.filter((call) => call === 'submit').length, 1)
})

test('W24.2 persisted async submit evidence reconciles restart without a second paid submit', async () => {
  let stored = { job: transitionProviderJob(planned(), { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 9, estimatedLatencyMs: 800 } }), requestFingerprint: hash('e') }
  let loseAdvance = true
  const evidence = []
  const jobs = {
    async claimNext(input) { return { ...stored, lease: { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() } } },
    async renewLease({ current, leaseExpiresAt }) { return { ...current, lease: { ...current.lease, expiresAt: leaseExpiresAt.toISOString() } } },
    async beginSubmission(input) { stored = { ...stored, job: input.next }; return { ...stored, lease: input.current.lease } },
    async advance(input) {
      if (loseAdvance && input.next.status === 'submitted') { loseAdvance = false; throw new Error('lost advance after attested submit') }
      stored = { ...stored, job: input.next }; return stored
    },
  }
  const adapter = new ControlledAsyncMediaProviderAdapter('controlled-avatar', 'version-1', {
    capabilities: { operations: ['audio-avatar'], inputFormats: ['wav'], outputFormats: ['mp4'], duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: false, supportsIdempotency: true, supportsCancellation: false, completion: 'polling', fetchedAt: at(0), expiresAt: '2030-01-01T00:00:00.000Z' },
    estimate: { currency: 'USD', costMinorUnits: 9, estimatedLatencyMs: 800 }, statuses: ['queued'], result: { bytes: 'later' },
  })
  let tick = 1
  const runOnce = runProviderJobWorkerOnce({
    ...runtimeEvidence(),
    jobs, provenance: {
      async recordEvidence({ evidence: value }) { evidence.push(value); return { evidence: value, replayed: false } },
      async listEvidenceByJob() { return evidence },
    },
    adapters: { get: () => adapter }, materializer: { async materialize({ job }) { return job.input } },
    ingestor: { async ingest() { throw new Error('unreachable') } }, critic: { async evaluate() { throw new Error('unreachable') } },
    clock: () => new Date(at(++tick)), createLeaseToken: () => `reconcile-lease-${tick}`, createTransitionId: () => `reconcile-transition-${tick}`,
  })
  await assert.rejects(runOnce('provider-worker-reconcile-first'), /lost advance/)
  assert.equal(stored.job.status, 'submitting')
  assert.equal(evidence.length, 1)
  await runOnce('provider-worker-reconcile-second')
  assert.equal(stored.job.status, 'submitted')
  assert.equal(stored.job.providerJobId, evidence[0].providerJobRef)
  assert.equal(adapter.calls.filter((call) => call === 'submit').length, 1)
})

test('W24.2 retrieve retry keeps one paid effect and receipt replay survives a new lease', async () => {
  let job = planned('polling')
  job = transitionProviderJob(job, { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 9, estimatedLatencyMs: 800 } })
  job = transitionProviderJob(job, { status: 'submitting', occurredAt: at(2) })
  job = transitionProviderJob(job, { status: 'submitted', occurredAt: at(3), providerJobId: 'controlled-avatar:provider-job-key' })
  job = transitionProviderJob(job, { status: 'retrieving', occurredAt: at(4), providerStatus: 'completed' })
  let stored = {
    job,
    requestFingerprint: hash('e'),
    transportState: createProviderJobTransportState({
      workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id,
      transport: 'polling', completion: 'polling', createdAt: at(0), deadlineAt: '2029-01-01T00:10:00.000Z',
    }),
  }
  let tick = 4
  let leaseSequence = 0
  let crashAfterReceipt = true
  const jobs = {
    async claimNext(input) {
      return { ...stored, lease: { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() } }
    },
    async renewLease({ current, leaseExpiresAt }) {
      return { ...current, lease: { ...current.lease, expiresAt: leaseExpiresAt.toISOString() } }
    },
    async advance(input) {
      if (crashAfterReceipt && input.next.status === 'evaluating') {
        crashAfterReceipt = false
        throw new Error('simulated crash after receipt commit')
      }
      stored = { ...stored, job: input.next, transportState: input.transportState ?? stored.transportState }
      return stored
    },
  }
  const evidence = [{
    id: 'provider-evidence-submit', schemaVersion: 'provider-transport-evidence/v1',
    workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id, attempt: job.attempt,
    phase: 'submit', runtimeClass: 'controlled', adapterId: job.adapterId, adapterVersion: job.adapterVersion,
    adapterConfigHash: hash('1'), endpointClass: 'controlled-adapter', method: 'CALL', requestHash: hash('2'),
    responseHash: hash('3'), responseStatus: 200, providerJobRef: job.providerJobId, observedAt: at(3),
    observationHash: hash('4'), inputHash: job.inputHash, authorizationHash: job.authorization.authorizationHash,
    jobHash: hash('5'), leaseOwner: 'submit-worker', leaseToken: 'submit-lease', evidenceHash: hash('6'),
  }]
  let canonicalReceipt
  let receiptWrites = 0
  const receiptLeaseTokens = []
  const provenance = {
    async recordEvidence({ evidence: value }) { evidence.push(value); return { evidence: value, replayed: false } },
    async listEvidenceByJob() { return evidence },
    async createReceipt({ receipt }) {
      receiptWrites += 1
      receiptLeaseTokens.push(receipt.leaseToken)
      if (!canonicalReceipt) canonicalReceipt = receipt
      else assert.equal(receipt.receiptHash, canonicalReceipt.receiptHash)
      return { receipt: canonicalReceipt, replayed: receiptWrites > 1 }
    },
    async readReceiptByJob() { return canonicalReceipt ?? null },
  }
  let retrieveCalls = 0
  const adapter = {
    id: job.adapterId, adapterVersion: job.adapterVersion, configHash: hash('1'), calls: ['submit'],
    async getCapabilities() { return { completion: 'polling' } },
    async retrieve(providerJobId, _signal, context) {
      retrieveCalls += 1
      this.calls.push('retrieve')
      await context.observeTransport(createProviderTransportObservation({
        phase: 'retrieve', runtimeClass: 'controlled', adapterId: this.id, adapterVersion: this.adapterVersion,
        adapterConfigHash: this.configHash, endpointClass: 'controlled-adapter', method: 'CALL',
        requestHash: calculateCanonicalHash({ providerJobId }), responseHash: calculateCanonicalHash({ providerJobId, retrieveCalls }),
        responseStatus: 200, providerJobRef: providerJobId, observedAt: at(4 + retrieveCalls),
      }))
      return { providerJobId, bytes: 'controlled-video' }
    },
  }
  let ingestCalls = 0
  const artifact = { artifactId: 'retried-result', artifactSha256: hash('c'), mediaType: 'video', byteSize: 777 }
  const resultArtifacts = { async listByJob({ workspaceId, projectId, jobId }) { return [{ id: 'retried-result-record', workspaceId, projectId, jobId, schemaVersion: 'provider-result-artifact/v1', role: 'primary-video', providerJobRef: job.providerJobId, artifactId: artifact.artifactId, artifactSha256: artifact.artifactSha256, byteSize: artifact.byteSize, mediaType: 'video', container: 'mp4', adapterId: job.adapterId, adapterVersion: job.adapterVersion, adapterConfigHash: hash('1'), inputHash: job.inputHash, authorizationHash: job.authorization.authorizationHash, completedAt: at(7), createdAt: at(7), recordHash: hash('9') }] } }
  const runOnce = runProviderJobWorkerOnce({
    jobs, provenance, resultArtifacts, adapters: { get: () => adapter },
    materializer: { async materialize() { throw new Error('submission must not repeat') } },
    ingestor: { async ingest() { ingestCalls += 1; if (ingestCalls === 1) throw new ProviderAdapterError('TRANSIENT_INGEST', true); return artifact } },
    critic: { async evaluate() { throw new Error('unreachable') } }, clock: () => new Date(at(++tick)),
    createLeaseToken: () => `retrieve-lease-${++leaseSequence}`, createTransitionId: () => `retrieve-transition-${tick}`,
  })

  await runOnce('retrieve-worker-one')
  assert.equal(stored.job.status, 'retrieving')
  await runOnce('retrieve-worker-two')
  assert.equal(stored.job.status, 'retrieving')
  assert.equal(stored.job.resultArtifact.artifactId, artifact.artifactId)
  await assert.rejects(runOnce('receipt-worker-before-crash'), /simulated crash after receipt commit/)
  assert.equal(stored.job.status, 'retrieving')
  await runOnce('receipt-worker-after-crash')
  assert.equal(stored.job.status, 'evaluating')
  assert.equal(adapter.calls.filter((call) => call === 'submit').length, 1)
  assert.equal(retrieveCalls, 2)
  assert.equal(evidence.filter((entry) => entry.phase === 'retrieve').length, 2)
  assert.equal(receiptWrites, 2)
  assert.equal(new Set(receiptLeaseTokens).size, 2)
  assert.equal(canonicalReceipt.leaseToken, receiptLeaseTokens[0])
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
