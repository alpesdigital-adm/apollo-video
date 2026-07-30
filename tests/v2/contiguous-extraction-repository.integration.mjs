import assert from 'node:assert/strict'
import test from 'node:test'

const [
  { createContiguousExtractionService },
  { calculateContiguousMomentEvaluationHash },
  { PrismaContiguousExtractionRepository },
] = await Promise.all([
  import('../../src/v2/application/contiguous-extraction.ts'),
  import('../../src/v2/domain/contiguous-extraction.ts'),
  import(
    '../../src/v2/infrastructure/prisma/contiguous-extraction-repository.ts'
  ),
])

const sha = (value) => value.repeat(64).slice(0, 64)
const evidence = {
  selfContained: ['evidence-self-repository'],
  density: ['evidence-density-repository'],
  integrity: ['evidence-integrity-repository'],
  audio: ['evidence-audio-repository'],
  visual: ['evidence-visual-repository'],
}
const scores = {
  selfContained: { value: 0.9, evidenceRefs: evidence.selfContained },
  density: { value: 0.8, evidenceRefs: evidence.density },
  integrity: { value: 1, evidenceRefs: evidence.integrity },
  audio: { value: 0.9, evidenceRefs: evidence.audio },
  visual: { value: 0.8, evidenceRefs: evidence.visual },
}
const evaluationHash =
  calculateContiguousMomentEvaluationHash({
    momentId: 'moment-contiguous-repository',
    momentHash: sha('a'),
    indexRunId: 'index-contiguous-repository',
    objectiveTags: ['education'],
    semanticRangeMs: [3_495_000, 3_615_000],
    scores,
  })

function evaluationRow(overrides = {}) {
  const rights = {
    id: 'rights-contiguous-repository',
    status: 'approved',
    consentStatus: 'not-required',
    expiresAt: null,
    consentExpiresAt: null,
  }
  return {
    id: 'evaluation-contiguous-repository',
    workspaceId: 'workspace-contiguous-repository',
    projectId: 'project-contiguous-repository',
    indexRunId: 'index-contiguous-repository',
    momentId: 'moment-contiguous-repository',
    policyVersion: 'contiguous-extraction/v1',
    objectiveTagsJson: '["education"]',
    semanticStartMs: 3_495_000,
    semanticEndMs: 3_615_000,
    selfContainedScore: 0.9,
    densityScore: 0.8,
    integrityScore: 1,
    audioScore: 0.9,
    visualScore: 0.8,
    selfContainedEvidenceJson:
      '["evidence-self-repository"]',
    densityEvidenceJson:
      '["evidence-density-repository"]',
    integrityEvidenceJson:
      '["evidence-integrity-repository"]',
    audioEvidenceJson:
      '["evidence-audio-repository"]',
    visualEvidenceJson:
      '["evidence-visual-repository"]',
    evaluationHash,
    active: true,
    createdAt: new Date('2026-07-30T22:30:00.000Z'),
    moment: {
      id: 'moment-contiguous-repository',
      momentHash: sha('a'),
      chapterId: 'chapter-contiguous-repository',
      topicNormalized: 'aquisição',
      recommendedStartMs: 3_500_000,
      recommendedEndMs: 3_610_000,
    },
    indexRun: {
      id: 'index-contiguous-repository',
      sourceArtifactId: 'artifact-contiguous-repository',
      sourceArtifactSha256: sha('b'),
      sourceManifestId: 'manifest-contiguous-repository',
      sourceManifestHash: sha('c'),
      durationMs: 7_200_000,
      rightsSnapshot: rights,
      sourceArtifact: {
        currentRightsSnapshot: rights,
      },
      sourceManifest: {
        id: 'manifest-contiguous-repository',
      },
    },
    ...overrides,
  }
}

function fixture(row = evaluationRow()) {
  let stored
  let candidateQuery
  const client = {
    v2ContiguousExtraction: {
      async findUnique() {
        return null
      },
      async findFirst() {
        return stored ?? null
      },
    },
    v2ContiguousMomentEvaluation: {
      async findMany(input) {
        candidateQuery = input
        return [row]
      },
    },
    async $transaction(callback) {
      return callback({
        v2ContiguousMomentEvaluation: {
          async findFirst() {
            return row
          },
        },
        v2ApiClient: {
          async findFirst() {
            return { id: 'client-contiguous-repository' }
          },
        },
        v2ContiguousExtraction: {
          async create(input) {
            stored = input.data
            return stored
          },
        },
      })
    },
  }
  const repository =
    new PrismaContiguousExtractionRepository(client)
  const create = createContiguousExtractionService({
    repository,
    createId: () => 'contiguous-extraction-repository',
    clock: () => new Date('2026-07-30T22:31:00.000Z'),
  })
  return {
    repository,
    create,
    candidateQuery: () => candidateQuery,
    stored: () => stored,
  }
}

const request = {
  workspaceId: 'workspace-contiguous-repository',
  projectId: 'project-contiguous-repository',
  objective: 'education',
  topic: 'aquisição',
  targetDurationMs: 120_000,
  toleranceMs: 15_000,
  fps: 30,
  actor: {
    type: 'api-client',
    id: 'client-contiguous-repository',
  },
  idempotencyKey: 'contiguous-repository-key-1',
}

test('T-FR-134 Prisma adapter reads authorized evaluations and round-trips a canonical extraction', async () => {
  const value = fixture()
  const created = await value.create(request)

  assert.equal(created.replayed, false)
  assert.equal(
    created.extraction.result.candidates[0].sourceEvaluationHash,
    evaluationHash,
  )
  assert.equal(
    value.stored().selectedEvaluationId,
    'evaluation-contiguous-repository',
  )
  assert.equal(
    value.candidateQuery().where.indexRun.rightsStatus,
    'approved',
  )
  assert.equal(
    value.candidateQuery().where.active,
    true,
  )
  assert.deepEqual(
    await value.repository.read({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      extractionId: created.extraction.result.id,
    }),
    created.extraction,
  )
})

test('T-FR-134 Prisma adapter cannot publish a tampered persisted evaluation', async () => {
  const value = fixture(evaluationRow({
    evaluationHash: sha('f'),
  }))
  await assert.rejects(
    value.create(request),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.equal(value.stored(), undefined)
})
