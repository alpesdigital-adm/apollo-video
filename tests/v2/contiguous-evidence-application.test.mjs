import assert from 'node:assert/strict'
import test from 'node:test'

import {
  produceContiguousEvidenceService,
} from '../../src/v2/application/contiguous-evidence.ts'

const sha = (value) => value.repeat(64).slice(0, 64)

function source(overrides = {}) {
  return {
    workspaceId: 'workspace-contiguous-evidence',
    projectId: 'project-contiguous-evidence',
    indexRunId: 'index-contiguous-evidence',
    indexRunHash: sha('a'),
    sourceArtifactId: 'artifact-contiguous-evidence',
    sourceArtifactSha256: sha('b'),
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
    async persist(run) {
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
  actor: { type: 'api-client', id: 'client-contiguous-evidence' },
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
  assert.equal(value.calls(), 1)
})

test('T-FR-134 evidence producer replays before analyzer and rejects source drift', async () => {
  const value = fixture()
  await value.produce(request)
  const replay = await value.produce(request)
  assert.equal(replay.replayed, true)
  assert.equal(value.calls(), 1)

  value.setSource(source({ indexRunHash: sha('9') }))
  await assert.rejects(
    value.produce(request),
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
