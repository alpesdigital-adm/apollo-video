import assert from 'node:assert/strict'
import test from 'node:test'

const [
  { produceContiguousEvaluationsService },
  { PrismaContiguousEvaluationRepository },
  { createApiAccessAuditContext },
] = await Promise.all([
  import('../../src/v2/application/contiguous-evaluation.ts'),
  import(
    '../../src/v2/infrastructure/prisma/contiguous-evaluation-repository.ts'
  ),
  import('../../src/v2/domain/api-access-control.ts'),
])

const sha = (value) => value.repeat(64).slice(0, 64)
const dimensions = [
  ['selfContained', 'transcript-boundary'],
  ['density', 'transcript-density'],
  ['integrity', 'rights-integrity'],
  ['audio', 'audio-analysis'],
  ['visual', 'visual-analysis'],
]

function sourceRow(overrides = {}) {
  const rights = {
    id: 'rights-contiguous-evaluation-repository',
    status: 'approved',
    consentStatus: 'not-required',
    expiresAt: null,
    consentExpiresAt: null,
  }
  return {
    id: 'index-contiguous-evaluation-repository',
    workspaceId: 'workspace-contiguous-evaluation-repository',
    projectId: 'project-contiguous-evaluation-repository',
    recordHash: sha('a'),
    sourceArtifactId: 'artifact-contiguous-evaluation-repository',
    sourceArtifactSha256: sha('b'),
    sourceManifestId: 'manifest-contiguous-evaluation-repository',
    sourceManifestHash: sha('c'),
    durationMs: 7_200_000,
    rightsSnapshot: rights,
    sourceArtifact: {
      mediaType: 'video',
      status: 'available',
      currentRightsSnapshot: rights,
    },
    moments: [
      {
        id: 'moment-contiguous-evaluation-repository',
        momentHash: sha('d'),
        chapterId: 'chapter-contiguous-evaluation-repository',
        topicNormalized: 'aquisicao',
        recommendedStartMs: 10_000,
        recommendedEndMs: 110_000,
        contiguousEvaluationEvidence: dimensions.map(
          ([dimension, kind], index) => ({
            id: `evidence-${dimension}-repository`,
            indexRunId:
              'index-contiguous-evaluation-repository',
            indexRunHash: sha('a'),
            momentId:
              'moment-contiguous-evaluation-repository',
            momentHash: sha('d'),
            kind,
            dimensionsJson: `["${dimension}"]`,
            startMs: 5_000,
            endMs: 125_000,
            producerProvider: 'apollo',
            producerModel: `${kind}-analyzer`,
            producerVersion: '1.0.0',
            producerInputHash: sha(`${index + 1}`),
            producerOutputHash: sha(`${index + 2}`),
            factsJson: '{"measured":true,"value":0.9}',
            evidenceHash: sha(`${index + 3}`),
          }),
        ),
      },
    ],
    ...overrides,
  }
}

function fixture(options = {}) {
  let storedRun
  let storedEvaluations = []
  let deactivated = false
  let providerCalls = 0
  let fenceChecks = 0
  const initial = options.sourceRow ?? sourceRow()
  const transactional =
    options.transactionSourceRow ?? initial
  const runDelegate = {
    async findUnique() {
      return storedRun
        ? { ...storedRun, evaluations: storedEvaluations }
        : null
    },
  }
  const client = {
    v2LongFormIndexRun: {
      async findFirst() {
        return initial
      },
    },
    v2ContiguousEvaluationRun: runDelegate,
    async $transaction(callback) {
      return callback({
        v2LongFormIndexRun: {
          async findFirst() {
            return transactional
          },
        },
        v2ApiClient: {
          async findFirst() {
            return { id: 'client-contiguous-evaluation-repository' }
          },
        },
        v2PublicOperation: {
          async findFirst() {
            fenceChecks += 1
            return options.leaseAvailable === false
              ? null
              : { id: 'operation-contiguous-evaluation' }
          },
        },
        v2LongFormIndexStageCheckpoint: {
          async findFirst() {
            fenceChecks += 1
            return options.leaseAvailable === false
              ? null
              : { id: 'stage-contiguous-evaluation' }
          },
        },
        v2ContiguousMomentEvaluation: {
          async updateMany() {
            deactivated = true
            return { count: 0 }
          },
          async createMany(input) {
            storedEvaluations = input.data
            return { count: input.data.length }
          },
        },
        v2ContiguousEvaluationRun: {
          async create(input) {
            storedRun = input.data
            return storedRun
          },
          async findUniqueOrThrow() {
            return {
              ...storedRun,
              evaluations: storedEvaluations,
            }
          },
        },
      })
    },
  }
  const repository =
    new PrismaContiguousEvaluationRepository(client)
  const produce = produceContiguousEvaluationsService({
    repository,
    provider: {
      identity: {
        provider: 'apollo',
        model: 'contiguous-quality-evaluator',
        version: '1.0.0',
      },
      async evaluate() {
        providerCalls += 1
        return [
          {
            status: 'evaluated',
            momentId:
              'moment-contiguous-evaluation-repository',
            objectiveTags: ['education'],
            semanticRangeMs: [5_000, 125_000],
            scores: Object.fromEntries(
              dimensions.map(([dimension]) => [
                dimension,
                {
                  value: 0.9,
                  evidenceRefs: [
                    `evidence-${dimension}-repository`,
                  ],
                },
              ]),
            ),
          },
        ]
      },
    },
    createRunId: () =>
      'contiguous-evaluation-run-repository',
    createEvaluationId: () =>
      'contiguous-evaluation-record-repository',
    clock: () => new Date('2026-07-31T00:20:00.000Z'),
  })
  return {
    produce,
    repository,
    storedRun: () => storedRun,
    storedEvaluations: () => storedEvaluations,
    deactivated: () => deactivated,
    providerCalls: () => providerCalls,
    fenceChecks: () => fenceChecks,
  }
}

const request = {
  workspaceId: 'workspace-contiguous-evaluation-repository',
  projectId: 'project-contiguous-evaluation-repository',
  indexRunId: 'index-contiguous-evaluation-repository',
  authenticationAudit: createApiAccessAuditContext({
    clientId: 'client-contiguous-evaluation-repository',
    credentialId: 'credential-contiguous-evaluation-repository',
    workspaceId: 'workspace-contiguous-evaluation-repository',
    environment: 'sandbox',
    authenticationKind: 'bearer',
  }),
  idempotencyKey: 'contiguous-evaluation-repository-key',
}

const fence = {
  workspaceId: request.workspaceId,
  projectId: request.projectId,
  workflowId: 'workflow-contiguous-evaluation',
  operationId: 'operation-contiguous-evaluation',
  stage: 'moments',
  expectedStageInputHash: sha('f'),
  expectedStageIdempotencyKey: 'moments-stage-key',
  leaseOwner: 'worker-contiguous-evaluation',
  operationAttempt: 1,
  now: '2026-07-31T00:20:00.000Z',
}
request.fence = fence

test('T-FR-134 Prisma evaluation adapter revalidates and persists one canonical run atomically', async () => {
  const value = fixture()
  const created = await value.produce(request)

  assert.equal(created.replayed, false)
  assert.equal(value.storedRun().evaluationCount, 1)
  assert.equal(value.storedRun().rejectedCount, 0)
  assert.equal(value.storedEvaluations().length, 1)
  assert.equal(
    value.storedEvaluations()[0].runId,
    created.run.id,
  )
  assert.equal(value.deactivated(), true)
  assert.equal(
    value.storedRun().actorCredentialId,
    request.authenticationAudit.credentialId,
  )
  assert.equal(
    value.storedRun().actorContextHash,
    request.authenticationAudit.contextHash,
  )
  assert.equal(value.storedRun().executionKind, 'long-form-stage')
  assert.equal(value.storedRun().originOperationId, fence.operationId)
  assert.equal(value.storedRun().originWorkflowId, fence.workflowId)
  assert.equal(value.storedRun().originStage, 'moments')
  assert.deepEqual(
    await value.repository.findIdempotent({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      sourceIndexRunId: request.indexRunId,
      createdByClientId: request.authenticationAudit.clientId,
      actorContextHash: request.authenticationAudit.contextHash,
      idempotencyKey: request.idempotencyKey,
    }),
    created.run,
  )
  assert.equal(value.providerCalls(), 1)
  await assert.rejects(
    value.repository.findIdempotent({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      sourceIndexRunId: request.indexRunId,
      createdByClientId: request.authenticationAudit.clientId,
      actorContextHash: sha('9'),
      idempotencyKey: request.idempotencyKey,
    }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('T-FR-134 Prisma evaluation adapter rejects source drift inside the serializable transaction', async () => {
  const value = fixture({
    transactionSourceRow: sourceRow({ recordHash: sha('9') }),
  })

  await assert.rejects(
    value.produce(request),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(value.storedRun(), undefined)
  assert.equal(value.storedEvaluations().length, 0)
  assert.equal(value.deactivated(), false)
})

test('T-FR-134 Prisma evaluation adapter persists behind the moments lease and rejects lease loss', async () => {
  const active = fixture()
  const created = await active.produce(request)
  assert.equal(created.replayed, false)
  assert.equal(active.fenceChecks(), 2)
  assert.equal(active.storedEvaluations().length, 1)

  const lost = fixture({ leaseAvailable: false })
  await assert.rejects(
    lost.produce(request),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(lost.fenceChecks(), 2)
  assert.equal(lost.storedRun(), undefined)
  assert.equal(lost.storedEvaluations().length, 0)
  assert.equal(lost.deactivated(), false)
})
