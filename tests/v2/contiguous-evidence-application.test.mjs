import assert from 'node:assert/strict'
import test from 'node:test'

import {
  produceContiguousEvidenceService,
} from '../../src/v2/application/contiguous-evidence.ts'
import { authenticationAudit } from './helpers/authentication-audit.mjs'

const sha = (value) => value.repeat(64).slice(0, 64)

function source(overrides = {}) {
  return {
    workspaceId: 'workspace-contiguous-evidence',
    projectId: 'project-contiguous-evidence',
    indexRunId: 'index-contiguous-evidence',
    indexRunHash: sha('a'),
    sourceArtifactId: 'artifact-contiguous-evidence',
    sourceArtifactSha256: sha('b'),
    sourceArtifactKey:
      'workspaces/contiguous-evidence/master.mp4',
    sourceArtifactByteSize: '2000000',
    sourceManifestId: 'manifest-contiguous-evidence',
    sourceManifestHash: sha('c'),
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-contiguous-evidence',
    rightsStatus: 'approved',
    consentStatus: 'approved',
    moments: [{
      id: 'moment-contiguous-evidence',
      momentHash: sha('d'),
      recommendedRangeMs: [5_000, 125_000],
    }],
    ...overrides,
  }
}

function fixture(overrides = {}) {
  let stored
  let calls = 0
  let currentSource = overrides.source ?? source()
  const repository = {
    async readSource() {
      return currentSource
    },
    async findIdempotent() {
      return stored
    },
    async persistWithLongFormLease({ run }) {
      stored = run
      return { run, replayed: false }
    },
  }
  const analyzer = {
    identity: {
      provider: 'apollo',
      model: 'transcript-boundary-analyzer',
      version: '1.0.0',
      kind: 'transcript-boundary',
    },
    async analyze(value) {
      calls += 1
      return overrides.observations ?? value.moments.map((moment) => ({
        momentId: moment.id,
        rangeMs: moment.recommendedRangeMs,
        dimensions: ['selfContained', 'integrity'],
        facts: {
          startsAtSentenceBoundary: true,
          endsAtSentenceBoundary: true,
        },
      }))
    },
  }
  return {
    produce: produceContiguousEvidenceService({
      repository,
      analyzer,
      createRunId: () => 'contiguous-evidence-run-1',
      createEvidenceId: (momentId) => `${momentId}-boundary-evidence`,
      clock: () => new Date('2026-07-31T01:00:00.000Z'),
    }),
    calls: () => calls,
    stored: () => stored,
    setSource(value) {
      currentSource = value
    },
  }
}

const request = {
  workspaceId: 'workspace-contiguous-evidence',
  projectId: 'project-contiguous-evidence',
  indexRunId: 'index-contiguous-evidence',
  authenticationAudit: authenticationAudit({
    clientId: 'client-contiguous-evidence',
    credentialId: 'credential-contiguous-evidence',
    workspaceId: 'workspace-contiguous-evidence',
  }),
  fence: {
    workspaceId: 'workspace-contiguous-evidence',
    projectId: 'project-contiguous-evidence',
    workflowId: 'workflow-contiguous-evidence',
    operationId: 'operation-contiguous-evidence',
    stage: 'moments',
    expectedStageInputHash: sha('e'),
    expectedStageIdempotencyKey: 'moments-contiguous-evidence',
    leaseOwner: 'worker-contiguous-evidence',
    operationAttempt: 1,
    now: '2026-07-31T01:00:00.000Z',
  },
  idempotencyKey: 'contiguous-evidence-request-1',
}

test('T-FR-134 evidence producer covers every moment and binds analyzer lineage', async () => {
  const value = fixture()
  const created = await value.produce(request)

  assert.equal(created.replayed, false)
  assert.equal(created.run.evidence.length, 1)
  assert.equal(created.run.evidence[0].sourceIndexRunHash, sha('a'))
  assert.equal(created.run.evidence[0].sourceMomentHash, sha('d'))
  assert.deepEqual(created.run.evidence[0].dimensions, [
    'selfContained',
    'integrity',
  ])
  assert.deepEqual(
    created.run.authenticationAudit,
    request.authenticationAudit,
  )
  assert.deepEqual(created.run.provenance, {
    kind: 'long-form-stage',
    workflowId: request.fence.workflowId,
    operationId: request.fence.operationId,
    stage: 'moments',
    stageInputHash: request.fence.expectedStageInputHash,
    stageIdempotencyKey:
      request.fence.expectedStageIdempotencyKey,
  })
  assert.equal(value.calls(), 1)
})

test('T-FR-134 evidence producer replays before analyzer and rejects source drift', async () => {
  const value = fixture()
  await value.produce(request)
  const replay = await value.produce(request)
  assert.equal(replay.replayed, true)
  assert.equal(value.calls(), 1)

  value.setSource(source({
    sourceArtifactKey:
      'relocated/contiguous-evidence/master.mp4',
    sourceArtifactByteSize: '3000000',
  }))
  const relocatedReplay = await value.produce(request)
  assert.equal(relocatedReplay.replayed, true)
  assert.equal(value.calls(), 1)

  value.setSource(source({ indexRunHash: sha('9') }))
  await assert.rejects(
    value.produce(request),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(value.calls(), 1)
})

test('T-FR-242 evidence producer rejects fence and credential drift before duplicate work', async () => {
  const value = fixture()
  await assert.rejects(
    value.produce({
      ...request,
      fence: { ...request.fence, projectId: 'project-other' },
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(value.calls(), 0)

  await value.produce(request)
  await assert.rejects(
    value.produce({
      ...request,
      authenticationAudit: authenticationAudit({
        clientId: request.authenticationAudit.clientId,
        credentialId: 'credential-contiguous-evidence-other',
        workspaceId: request.workspaceId,
      }),
    }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(value.calls(), 1)
})

test('T-FR-134 evidence producer rejects incomplete, malformed and out-of-source observations', async () => {
  const missing = fixture({ observations: [] })
  await assert.rejects(
    missing.produce(request),
    (error) => error.code === 'RENDER_OUTPUT_INVALID',
  )
  assert.equal(missing.stored(), undefined)

  const malformed = fixture({ observations: [null] })
  await assert.rejects(
    malformed.produce(request),
    (error) => error.code === 'RENDER_OUTPUT_INVALID',
  )
  assert.equal(malformed.stored(), undefined)

  const outside = fixture({
    observations: [{
      momentId: 'moment-contiguous-evidence',
      rangeMs: [7_199_000, 7_201_000],
      dimensions: ['selfContained'],
      facts: { boundary: true },
    }],
  })
  await assert.rejects(
    outside.produce(request),
    (error) => error.code === 'RENDER_OUTPUT_INVALID',
  )
  assert.equal(outside.stored(), undefined)
})
