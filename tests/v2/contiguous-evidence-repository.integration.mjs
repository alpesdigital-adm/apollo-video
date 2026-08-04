import assert from 'node:assert/strict'
import test from 'node:test'

const [
  { produceContiguousEvidenceService },
  { PrismaContiguousEvidenceRepository },
  { calculateCanonicalHash, stableSerialize },
  { createApiAccessAuditContext },
  { createLongFormMomentTranscriptEvidence },
  {
    TranscriptBoundaryContiguousEvidenceAnalyzer,
    TranscriptDensityContiguousEvidenceAnalyzer,
  },
] = await Promise.all([
  import('../../src/v2/application/contiguous-evidence.ts'),
  import(
    '../../src/v2/infrastructure/prisma/contiguous-evidence-repository.ts'
  ),
  import('../../src/v2/domain/canonical-hash.ts'),
  import('../../src/v2/domain/api-access-control.ts'),
  import('../../src/v2/domain/long-form-transcript-evidence.ts'),
  import(
    '../../src/v2/infrastructure/analysis/transcript-contiguous-evidence-analyzers.ts'
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
    sourceArtifact: {
      artifactKey:
        'workspaces/contiguous-evidence/master.mp4',
      byteSize: BigInt(2_000_000),
      mediaType: 'video',
      status: 'available',
      currentRightsSnapshot: rights,
    },
    moments: [{
      id: 'moment-contiguous-evidence-repository',
      momentHash: sha('d'),
      recommendedStartMs: 10_000,
      recommendedEndMs: 110_000,
    }],
    ...overrides,
  }
}

function transcriptSidecarRow() {
  const spanContent = {
    id: 'span-contiguous-evidence-repository',
    sourceSegmentId: 1,
    rangeMs: [10_000, 110_000],
    text: 'Uma ideia completa para extração.',
    textHash: calculateCanonicalHash(
      'Uma ideia completa para extração.',
    ),
    wordCount: 5,
    chunkIds: ['chunk-contiguous-evidence-repository'],
  }
  const span = {
    ...spanContent,
    spanHash: calculateCanonicalHash(spanContent),
  }
  const evidence = createLongFormMomentTranscriptEvidence({
    id: 'sidecar-contiguous-evidence-repository',
    workspaceId:
      'workspace-contiguous-evidence-repository',
    projectId: 'project-contiguous-evidence-repository',
    indexRunId: 'index-contiguous-evidence-repository',
    indexRunHash: sha('a'),
    momentId: 'moment-contiguous-evidence-repository',
    momentHash: sha('d'),
    hierarchicalRunId:
      'hierarchical-contiguous-evidence-repository',
    hierarchicalRunHash: sha('e'),
    sourceTranscriptId:
      'transcript-contiguous-evidence-repository',
    sourceTranscriptHash: sha('f'),
    spans: [span],
  })
  return {
    id: evidence.id,
    workspaceId: evidence.workspaceId,
    projectId: evidence.projectId,
    indexRunId: evidence.indexRunId,
    indexRunHash: evidence.indexRunHash,
    momentId: evidence.momentId,
    momentHash: evidence.momentHash,
    hierarchicalRunId: evidence.hierarchicalRunId,
    hierarchicalRunHash: evidence.hierarchicalRunHash,
    sourceTranscriptId: evidence.sourceTranscriptId,
    sourceTranscriptHash: evidence.sourceTranscriptHash,
    spansJson: stableSerialize(evidence.spans),
    spanCount: evidence.spanCount,
    startMs: evidence.rangeMs[0],
    endMs: evidence.rangeMs[1],
    wordCount: evidence.wordCount,
    evidenceHash: evidence.evidenceHash,
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
  authenticationAudit: createApiAccessAuditContext({
    clientId: 'client-contiguous-evidence-repository',
    credentialId: 'credential-contiguous-evidence-repository',
    workspaceId: 'workspace-contiguous-evidence-repository',
    environment: 'sandbox',
    authenticationKind: 'bearer',
  }),
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
request.fence = fence

test('T-FR-134 Prisma evidence adapter revalidates and persists one analyzer run atomically', async () => {
  const value = fixture()
  const created = await value.produce(request)

  assert.equal(created.replayed, false)
  assert.equal(value.storedRun().evidenceCount, 1)
  assert.equal(value.storedEvidence().length, 1)
  assert.equal(value.storedEvidence()[0].runId, created.run.id)
  assert.equal(value.storedEvidence()[0].indexRunHash, sha('a'))
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
  assert.equal(value.analyzerCalls(), 1)
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
  const created = await active.produce(request)
  assert.equal(created.replayed, false)
  assert.equal(active.fenceChecks(), 2)
  assert.equal(active.storedEvidence().length, 1)

  const lost = fixture({ leaseAvailable: false })
  await assert.rejects(
    lost.produce(request),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(lost.fenceChecks(), 2)
  assert.equal(lost.storedRun(), undefined)
  assert.equal(lost.storedEvidence().length, 0)
  assert.equal(lost.deactivated(), false)
})

test('T-FR-134 Prisma evidence source hydrates exact transcript sidecar for both analyzers', async () => {
  const row = sourceRow()
  row.moments[0].transcriptEvidence =
    transcriptSidecarRow()
  const value = fixture({ sourceRow: row })
  const source = await value.repository.readSource({
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    indexRunId: request.indexRunId,
    now: fence.now,
  })

  assert.equal(
    source.moments[0].transcriptEvidence.evidenceHash,
    row.moments[0].transcriptEvidence.evidenceHash,
  )
  assert.equal(
    source.sourceArtifactKey,
    row.sourceArtifact.artifactKey,
  )
  assert.equal(
    source.sourceArtifactByteSize,
    row.sourceArtifact.byteSize.toString(),
  )
  const signal = new AbortController().signal
  const [boundary, density] = await Promise.all([
    new TranscriptBoundaryContiguousEvidenceAnalyzer()
      .analyze(source, signal),
    new TranscriptDensityContiguousEvidenceAnalyzer()
      .analyze(source, signal),
  ])
  assert.deepEqual(boundary[0].dimensions, [
    'selfContained',
    'integrity',
  ])
  assert.deepEqual(density[0].dimensions, ['density'])
})
