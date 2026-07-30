import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createContiguousExtractionService,
  readContiguousExtractionService,
} from '../../src/v2/application/contiguous-extraction.ts'

const sha = (value) => value.repeat(64).slice(0, 64)
const observation = (value, reference) => ({
  value,
  evidenceRefs: [reference],
})

function sourceMoment() {
  return {
    id: 'moment-contiguous-app-1',
    momentHash: sha('a'),
    indexRunId: 'index-contiguous-app-1',
    sourceArtifactId: 'artifact-contiguous-app-1',
    sourceArtifactSha256: sha('b'),
    sourceManifestId: 'manifest-contiguous-app-1',
    sourceManifestHash: sha('c'),
    chapterId: 'chapter-contiguous-app-1',
    topic: 'aquisição',
    objectiveTags: ['education'],
    recommendedRangeMs: [3_500_000, 3_610_000],
    semanticRangeMs: [3_495_000, 3_615_000],
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-contiguous-app-1',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    scores: {
      selfContained: observation(0.9, 'evidence-self-app-1'),
      density: observation(0.8, 'evidence-density-app-1'),
      integrity: observation(1, 'evidence-integrity-app-1'),
      audio: observation(0.9, 'evidence-audio-app-1'),
      visual: observation(0.8, 'evidence-visual-app-1'),
    },
  }
}

function fixture() {
  const stored = []
  const candidateQueries = []
  const repository = {
    async findIdempotent(input) {
      return stored.find((value) =>
        value.result.workspaceId === input.workspaceId &&
        value.result.projectId === input.projectId &&
        value.createdBy.id === input.createdByClientId &&
        value.idempotencyKey === input.idempotencyKey,
      ) ?? null
    },
    async readCandidateMoments(input) {
      candidateQueries.push(input)
      return [sourceMoment()]
    },
    async persist(value) {
      stored.push(value)
      return { extraction: value, replayed: false }
    },
    async read(input) {
      return stored.find((value) =>
        value.result.workspaceId === input.workspaceId &&
        value.result.projectId === input.projectId &&
        value.result.id === input.extractionId,
      ) ?? null
    },
  }
  let ids = 0
  const create = createContiguousExtractionService({
    repository,
    createId: () => `contiguous-extraction-app-${++ids}`,
    clock: () => new Date('2026-07-30T22:00:00.000Z'),
  })
  const request = {
    workspaceId: 'workspace-contiguous-app',
    projectId: 'project-contiguous-app',
    objective: 'education',
    topic: 'aquisição',
    targetDurationMs: 120_000,
    toleranceMs: 15_000,
    fps: 30,
    actor: {
      type: 'api-client',
      id: 'client-contiguous-app',
    },
    idempotencyKey: 'contiguous-app-key-0001',
  }
  return {
    stored,
    candidateQueries,
    create,
    request,
    read: readContiguousExtractionService({ repository }),
  }
}

test('T-FR-134 application reads trusted candidates and persists one compiled extraction', async () => {
  const value = fixture()
  const created = await value.create(value.request)

  assert.equal(created.replayed, false)
  assert.equal(value.candidateQueries.length, 1)
  assert.deepEqual(
    Object.keys(value.candidateQueries[0]).sort(),
    [
      'limit',
      'now',
      'objective',
      'projectId',
      'targetDurationMs',
      'toleranceMs',
      'topic',
      'workspaceId',
    ],
  )
  assert.equal(created.extraction.result.candidates.length, 1)
  assert.equal(
    created.extraction.result.editPlan.synthesizedRanges,
    false,
  )
  assert.equal(value.stored.length, 1)
  assert.deepEqual(
    await value.read({
      workspaceId: value.request.workspaceId,
      projectId: value.request.projectId,
      extractionId: created.extraction.result.id,
    }),
    created.extraction,
  )
})

test('T-FR-134 application replays exact idempotency without reading or rescoring candidates', async () => {
  const value = fixture()
  const first = await value.create(value.request)
  const replay = await value.create(value.request)

  assert.equal(replay.replayed, true)
  assert.equal(replay.extraction.result.id, first.extraction.result.id)
  assert.equal(value.candidateQueries.length, 1)
  assert.equal(value.stored.length, 1)
})

test('T-FR-134 application rejects idempotency drift and never accepts client candidates or scores', async () => {
  const value = fixture()
  await value.create(value.request)

  await assert.rejects(
    value.create({
      ...value.request,
      targetDurationMs: 119_000,
    }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(value.candidateQueries.length, 1)
  assert.equal(
    'moments' in value.request || 'scores' in value.request,
    false,
  )
})
