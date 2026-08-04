import assert from 'node:assert/strict'
import test from 'node:test'

const baseFence = Object.freeze({
  workspaceId: 'workspace-fencing',
  projectId: 'project-fencing',
  workflowId: 'workflow-fencing',
  operationId: 'operation-fencing',
  expectedStageInputHash: 'a'.repeat(64),
  expectedStageIdempotencyKey:
    'workflow-fencing:stage:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  leaseOwner: 'worker-fencing',
  operationAttempt: 1,
  now: '2026-07-30T13:00:00.000Z',
})

function execution(stage) {
  return {
    createdBy: {
      type: 'api-client',
      id: 'client-fencing',
    },
    authenticationAudit: Object.freeze({
      clientId: 'client-fencing',
      credentialId: 'credential-fencing',
      workspaceId: baseFence.workspaceId,
      environment: 'sandbox',
      authenticationKind: 'bearer',
      contextHash:
        '96bc71273e02f454a5299b35966ae7c5462941237a3edf10d702c7e857161f02',
    }),
    provenance: {
      kind: 'long-form-stage',
      workflowId: baseFence.workflowId,
      operationId: baseFence.operationId,
      stage,
      stageInputHash: baseFence.expectedStageInputHash,
      stageIdempotencyKey: baseFence.expectedStageIdempotencyKey,
    },
  }
}

function clientWithoutLease(runModel) {
  let transactionCount = 0
  const transaction = {
    [runModel]: {
      async findUnique() {
        return null
      },
    },
    v2PublicOperation: {
      async findFirst() {
        return null
      },
    },
    v2LongFormIndexStageCheckpoint: {
      async findFirst() {
        return null
      },
    },
  }
  return {
    client: {
      async $transaction(callback) {
        transactionCount += 1
        return callback(transaction)
      },
    },
    transactions: () => transactionCount,
  }
}

test('T-FR-133 hierarchical repository fences tenant and missing operation lease before writing chunks', async () => {
  const {
    PrismaHierarchicalProcessingRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/hierarchical-processing-repository.ts'
  )
  const fixture = clientWithoutLease(
    'v2HierarchicalProcessingRun',
  )
  const repository =
    new PrismaHierarchicalProcessingRepository(fixture.client)
  const run = {
    ...execution('chunks'),
    workspaceId: baseFence.workspaceId,
    projectId: baseFence.projectId,
    idempotencyKey:
      baseFence.expectedStageIdempotencyKey,
  }
  await assert.rejects(
    repository.persistWithLongFormLease({
      run,
      fence: {
        ...baseFence,
        workspaceId: 'workspace-fencing-other',
        stage: 'chunks',
      },
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(fixture.transactions(), 0)
  await assert.rejects(
    repository.persistWithLongFormLease({
      run: {
        ...run,
        provenance: {
          ...run.provenance,
          operationId: 'operation-fencing-tampered',
        },
      },
      fence: { ...baseFence, stage: 'chunks' },
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(fixture.transactions(), 0)
  assert.equal(
    await repository.persistWithLongFormLease({
      run,
      fence: { ...baseFence, stage: 'chunks' },
    }),
    null,
  )
  assert.equal(fixture.transactions(), 1)
})

test('T-FR-133 hierarchical fence binds chunks to the persisted transcript checkpoint output', async () => {
  const {
    PrismaHierarchicalProcessingRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/hierarchical-processing-repository.ts'
  )
  let stageWhere
  const repository = new PrismaHierarchicalProcessingRepository({
    async $transaction(callback) {
      return callback({
        v2HierarchicalProcessingRun: {
          async findUnique() {
            return null
          },
        },
        v2PublicOperation: {
          async findFirst() {
            return { id: baseFence.operationId }
          },
        },
        v2LongFormIndexStageCheckpoint: {
          async findFirst(input) {
            stageWhere = input.where
            return null
          },
        },
      })
    },
  })
  const run = {
    ...execution('chunks'),
    workspaceId: baseFence.workspaceId,
    projectId: baseFence.projectId,
    sourceArtifactId: 'artifact-fencing',
    sourceArtifactSha256: 'b'.repeat(64),
    sourceManifestId: 'manifest-fencing',
    sourceManifestHash: 'c'.repeat(64),
    sourceTranscriptId: 'generated-transcript-fencing',
    sourceTranscriptHash: 'd'.repeat(64),
    idempotencyKey: baseFence.expectedStageIdempotencyKey,
  }

  assert.equal(
    await repository.persistWithLongFormLease({
      run,
      fence: { ...baseFence, stage: 'chunks' },
    }),
    null,
  )
  assert.deepEqual(
    stageWhere.workflow.stages,
    {
      some: {
        stage: 'transcript',
        status: 'succeeded',
        outputEntityType: 'media-transcript',
        outputEntityId: run.sourceTranscriptId,
        outputHash: run.sourceTranscriptHash,
      },
    },
  )
  assert.equal(
    stageWhere.workflow.sourceTranscriptId,
    undefined,
  )
  assert.equal(
    stageWhere.workflow.sourceTranscriptHash,
    undefined,
  )
})

test('T-FR-133 long-form repository fences tenant and missing operation lease before writing moments', async () => {
  const {
    PrismaLongFormIndexRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/long-form-index-repository.ts'
  )
  const fixture = clientWithoutLease('v2LongFormIndexRun')
  const repository =
    new PrismaLongFormIndexRepository(fixture.client)
  const run = {
    ...execution('moments'),
    workspaceId: baseFence.workspaceId,
    projectId: baseFence.projectId,
    idempotencyKey:
      baseFence.expectedStageIdempotencyKey,
  }
  await assert.rejects(
    repository.persistWithLongFormLease({
      run,
      transcriptEvidence: [],
      fence: {
        ...baseFence,
        projectId: 'project-fencing-other',
        stage: 'moments',
      },
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(fixture.transactions(), 0)
  assert.equal(
    await repository.persistWithLongFormLease({
      run,
      transcriptEvidence: [],
      fence: { ...baseFence, stage: 'moments' },
    }),
    null,
  )
  assert.equal(fixture.transactions(), 1)
})

test('T-FR-134 long-form repository revalidates transcript sidecar against the hierarchical run', async () => {
  const [
    { PrismaLongFormIndexRepository },
    { createLongFormMomentTranscriptEvidence },
    { calculateCanonicalHash, stableSerialize },
  ] = await Promise.all([
    import(
      '../../src/v2/infrastructure/prisma/long-form-index-repository.ts'
    ),
    import(
      '../../src/v2/domain/long-form-transcript-evidence.ts'
    ),
    import('../../src/v2/domain/canonical-hash.ts'),
  ])
  const spanContent = {
    id: 'span-fencing-transcript',
    sourceSegmentId: 1,
    rangeMs: [10_000, 40_000],
    text: 'Contexto completo preservado.',
    textHash: calculateCanonicalHash(
      'Contexto completo preservado.',
    ),
    wordCount: 3,
    chunkIds: ['chunk-fencing-transcript'],
  }
  const span = {
    ...spanContent,
    spanHash: calculateCanonicalHash(spanContent),
  }
  const run = {
    ...execution('moments'),
    id: 'index-fencing-transcript',
    workspaceId: baseFence.workspaceId,
    projectId: baseFence.projectId,
    sourceArtifactId: 'artifact-fencing-transcript',
    sourceArtifactSha256: 'b'.repeat(64),
    sourceManifestId: 'manifest-fencing-transcript',
    sourceManifestHash: 'c'.repeat(64),
    recordHash: 'd'.repeat(64),
    idempotencyKey:
      baseFence.expectedStageIdempotencyKey,
    moments: [{
      id: 'moment-fencing-transcript',
      sourceMomentId: 'hierarchical-moment-fencing',
      momentHash: 'e'.repeat(64),
    }],
  }
  const evidence = createLongFormMomentTranscriptEvidence({
    id: 'sidecar-fencing-transcript',
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    indexRunId: run.id,
    indexRunHash: run.recordHash,
    momentId: run.moments[0].id,
    momentHash: run.moments[0].momentHash,
    hierarchicalRunId: 'hierarchical-run-fencing',
    hierarchicalRunHash: 'f'.repeat(64),
    sourceTranscriptId: 'transcript-fencing',
    sourceTranscriptHash: '1'.repeat(64),
    spans: [span],
  })
  const aggregation = {
    chapters: [],
    moments: [{
      id: run.moments[0].sourceMomentId,
      evidenceSpanIds: [span.id],
    }],
    evidencePreserved: true,
  }
  const repository = new PrismaLongFormIndexRepository({
    async $transaction(callback) {
      return callback({
        v2LongFormIndexRun: {
          async findUnique() {
            return null
          },
        },
        v2PublicOperation: {
          async findFirst() {
            return {
              id: baseFence.operationId,
              clientId: run.authenticationAudit.clientId,
              actorContextHash:
                run.authenticationAudit.contextHash,
            }
          },
        },
        v2LongFormIndexStageCheckpoint: {
          async findFirst() {
            return {
              id: 'stage-fencing-transcript',
              workflow: {
                createdByClientId:
                  run.authenticationAudit.clientId,
                actorContextHash:
                  run.authenticationAudit.contextHash,
              },
            }
          },
        },
        v2HierarchicalProcessingRun: {
          async findFirst() {
            return {
              id: evidence.hierarchicalRunId,
              runHash: '9'.repeat(64),
              sourceTranscriptId:
                evidence.sourceTranscriptId,
              sourceTranscriptHash:
                evidence.sourceTranscriptHash,
              evidenceSpansJson: stableSerialize([span]),
              aggregationJson:
                stableSerialize(aggregation),
            }
          },
        },
      })
    },
  })

  await assert.rejects(
    repository.persistWithLongFormLease({
      run,
      transcriptEvidence: [evidence],
      fence: { ...baseFence, stage: 'moments' },
    }),
    (error) =>
      error.code === 'VERSION_CONFLICT' &&
      /transcript evidence source changed/.test(error.message),
  )
})

test('T-FR-133 transcript repository refuses publication without the exact operation lease', async () => {
  const [
    { PrismaLongFormIndexWorkflowRepository },
    { createMediaTranscript },
  ] = await Promise.all([
    import(
      '../../src/v2/infrastructure/prisma/long-form-index-workflow-repository.ts'
    ),
    import('../../src/v2/domain/media-transcript.ts'),
  ])
  let createCount = 0
  const transaction = {
    v2MediaTranscript: {
      async findFirst() {
        return null
      },
      async create() {
        createCount += 1
      },
    },
    v2LongFormIndexWorkflow: {
      async findFirst() {
        return null
      },
    },
    v2PublicOperation: {
      async findFirst() {
        return null
      },
    },
    v2MediaArtifact: {
      async findFirst() {
        return null
      },
    },
    v2MediaArtifactManifest: {
      async findFirst() {
        return null
      },
    },
    v2Project: {
      async findFirst() {
        return null
      },
    },
  }
  const repository = new PrismaLongFormIndexWorkflowRepository({
    async $transaction(callback) {
      return callback(transaction)
    },
  })
  const transcript = createMediaTranscript({
    language: 'pt-BR',
    text: 'Transcript cercado.',
    words: [{ word: 'Transcript', start: 0, end: 0.4 }],
    segments: [{
      id: 0,
      start: 0,
      end: 0.4,
      text: 'Transcript cercado.',
    }],
    provider: 'groq',
    model: 'whisper-large-v3',
  })
  const result = await repository.persistTranscriptWithLease({
    ...baseFence,
    transcriptId: `transcript-${transcript.transcriptHash}`,
    transcript,
    sourceArtifactId: 'artifact-fencing',
    sourceArtifactSha256: 'b'.repeat(64),
    sourceManifestId: 'manifest-fencing',
    sourceManifestHash: 'c'.repeat(64),
  })
  assert.equal(result, null)
  assert.equal(createCount, 0)
})
