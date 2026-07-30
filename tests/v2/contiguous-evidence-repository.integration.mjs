import assert from 'node:assert/strict'
import test from 'node:test'

const [
  { produceContiguousEvidenceService },
  { PrismaContiguousEvidenceRepository },
] = await Promise.all([
  import('../../src/v2/application/contiguous-evidence.ts'),
  import(
    '../../src/v2/infrastructure/prisma/contiguous-evidence-repository.ts'
  ),
])

const sha = (value) => value.repeat(64).slice(0, 64)

function sourceRow(overrides = {}) {
  const rights = {
    id: 'rights-contiguous-evidence-repository',
    status: 'approved',
    consentStatus: 'not-required',
    expiresAt: null,
    consentExpiresAt: null,
  }
  return {
    id: 'index-contiguous-evidence-repository',
    workspaceId: 'workspace-contiguous-evidence-repository',
    projectId: 'project-contiguous-evidence-repository',
    recordHash: sha('a'),
    sourceArtifactId: 'artifact-contiguous-evidence-repository',
    sourceArtifactSha256: sha('b'),
    sourceManifestId: 'manifest-contiguous-evidence-repository',
    sourceManifestHash: sha('c'),
    durationMs: 7_200_000,
    rightsSnapshot: rights,
    sourceArtifact: { currentRightsSnapshot: rights },
    moments: [{
      id: 'moment-contiguous-evidence-repository',
      momentHash: sha('d'),
      recommendedStartMs: 10_000,
      recommendedEndMs: 110_000,
    }],
    ...overrides,
  }
}

function fixture(options = {}) {
  let storedRun
  let storedEvidence = []
  let deactivated = false
  let analyzerCalls = 0
  let fenceChecks = 0
  const initial = options.sourceRow ?? sourceRow()
  const transactional =
    options.transactionSourceRow ?? initial
  const client = {
    v2LongFormIndexRun: {
      async findFirst() {
        return initial
      },
    },
    v2ContiguousEvidenceRun: {
      async findUnique() {
        return storedRun
          ? { ...storedRun, evidence: storedEvidence }
          : null
      },
    },
    async $transaction(callback) {
      return callback({
        v2LongFormIndexRun: {
          async findFirst() {
            return transactional
          },
        },
        v2ApiClient: {
          async findFirst() {
            return { id: 'client-contiguous-evidence-repository' }
          },
        },
        v2PublicOperation: {
          async findFirst() {
            fenceChecks += 1
            return options.leaseAvailable === false
              ? null
              : { id: 'operation-contiguous-evidence' }
          },
        },
        v2LongFormIndexStageCheckpoint: {
          async findFirst() {
            fenceChecks += 1
            return options.leaseAvailable === false
              ? null
              : { id: 'stage-contiguous-evidence' }
          },
        },
        v2ContiguousEvaluationEvidence: {
          async updateMany() {
            deactivated = true
            return { count: 0 }
          },
          async createMany(input) {
            storedEvidence = input.data
            return { count: input.data.length }
          },
        },
        v2ContiguousEvidenceRun: {
          async create(input) {
            storedRun = input.data
            return storedRun
          },
          async findUniqueOrThrow() {
            return { ...storedRun, evidence: storedEvidence }
          },
        },
      })
    },
  }
  const repository =
    new PrismaContiguousEvidenceRepository(client)
  const produce = produceContiguousEvidenceService({
    repository,
    analyzer: {
      identity: {
        provider: 'apollo',
        model: 'transcript-boundary-analyzer',
        version: '1.0.0',
        kind: 'transcript-boundary',
      },
      async analyze(source) {
        analyzerCalls += 1
        return source.moments.map((moment) => ({
          momentId: moment.id,
          rangeMs: moment.recommendedRangeMs,
          dimensions: ['selfContained', 'integrity'],
          facts: {
            startsAtSentenceBoundary: true,
            endsAtSentenceBoundary: true,
          },
        }))
      },
    },
    createRunId: () =>
      'contiguous-evidence-run-repository',
    createEvidenceId: () =>
      'contiguous-evidence-record-repository',
    clock: () => new Date('2026-07-31T01:30:00.000Z'),
  })
  return {
    produce,
    repository,
    storedRun: () => storedRun,
    storedEvidence: () => storedEvidence,
    deactivated: () => deactivated,
    analyzerCalls: () => analyzerCalls,
    fenceChecks: () => fenceChecks,
  }
}

const request = {
  workspaceId: 'workspace-contiguous-evidence-repository',
  projectId: 'project-contiguous-evidence-repository',
  indexRunId: 'index-contiguous-evidence-repository',
  actor: {
    type: 'api-client',
    id: 'client-contiguous-evidence-repository',
  },
  idempotencyKey: 'contiguous-evidence-repository-key',
}

const fence = {
  workspaceId: request.workspaceId,
  projectId: request.projectId,
  workflowId: 'workflow-contiguous-evidence',
  operationId: 'operation-contiguous-evidence',
  stage: 'moments',
  expectedStageInputHash: sha('f'),
  expectedStageIdempotencyKey: 'moments-stage-key',
  leaseOwner: 'worker-contiguous-evidence',
  operationAttempt: 1,
  now: '2026-07-31T01:30:00.000Z',
}

test('T-FR-134 Prisma evidence adapter revalidates and persists one analyzer run atomically', async () => {
  const value = fixture()
  const created = await value.produce(request)

  assert.equal(created.replayed, false)
  assert.equal(value.storedRun().evidenceCount, 1)
  assert.equal(value.storedEvidence().length, 1)
  assert.equal(value.storedEvidence()[0].runId, created.run.id)
  assert.equal(value.storedEvidence()[0].indexRunHash, sha('a'))
  assert.equal(value.deactivated(), true)
  assert.deepEqual(
    await value.repository.findIdempotent({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      sourceIndexRunId: request.indexRunId,
      createdByClientId: request.actor.id,
      idempotencyKey: request.idempotencyKey,
    }),
    created.run,
  )
  assert.equal(value.analyzerCalls(), 1)
})

test('T-FR-134 Prisma evidence adapter rejects source drift inside the serializable transaction', async () => {
  const value = fixture({
    transactionSourceRow: sourceRow({ recordHash: sha('9') }),
  })

  await assert.rejects(
    value.produce(request),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(value.storedRun(), undefined)
  assert.equal(value.storedEvidence().length, 0)
  assert.equal(value.deactivated(), false)
})

test('T-FR-134 Prisma evidence adapter fences worker persistence and rejects a lost moments lease', async () => {
  const active = fixture()
  const created = await active.produce({ ...request, fence })
  assert.equal(created.replayed, false)
  assert.equal(active.fenceChecks(), 2)
  assert.equal(active.storedEvidence().length, 1)

  const lost = fixture({ leaseAvailable: false })
  await assert.rejects(
    lost.produce({ ...request, fence }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(lost.fenceChecks(), 2)
  assert.equal(lost.storedRun(), undefined)
  assert.equal(lost.storedEvidence().length, 0)
  assert.equal(lost.deactivated(), false)
})
