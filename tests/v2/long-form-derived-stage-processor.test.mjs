import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  createLongFormDerivedStageProcessor,
  createLongFormIndexStageRouter,
} from '../../src/v2/application/long-form-derived-stage-processor.ts'
import {
  completeLongFormIndexStage,
  createLongFormIndexWorkflow,
  startLongFormIndexStage,
} from '../../src/v2/domain/long-form-index-workflow.ts'
import {
  createSpeakerDiarizationRun,
} from '../../src/v2/domain/speaker-diarization.ts'

const sha = (value) =>
  createHash('sha256').update(value).digest('hex')

const identities = Object.freeze({
  workspaceId: 'workspace-derived-stages',
  projectId: 'project-derived-stages',
  workflowId: 'workflow-derived-stages',
  operationId: 'operation-derived-stages',
  sourceArtifactId: 'artifact-derived-stages',
  sourceArtifactSha256: sha('derived-artifact'),
  sourceManifestId: 'manifest-derived-stages',
  sourceManifestHash: sha('derived-manifest'),
  sourceTranscriptId: 'transcript-derived-stages',
  sourceTranscriptHash: sha('derived-transcript'),
  clientId: 'client-derived-stages',
})

const versions = Object.freeze({
  probe: Object.freeze({
    provider: 'ffprobe',
    model: 'probe',
    version: '8.0.0',
  }),
  transcript: Object.freeze({
    provider: 'groq',
    model: 'whisper-large-v3',
    version: '2026-07',
  }),
  diarization: Object.freeze({
    provider: 'openai',
    model: 'gpt-4o-transcribe-diarize',
    version: 'diarized-json/v1',
  }),
  chunks: Object.freeze({
    provider: 'apollo',
    model: 'overlapping-time-chunks',
    version: '1.0.0',
  }),
  moments: Object.freeze({
    provider: 'apollo',
    model: 'hierarchical-moments',
    version: '1.0.0',
  }),
})

function budgets(overrides = {}) {
  return Object.freeze(Object.fromEntries(
    Object.keys(versions).map((stage) => [
      stage,
      Object.freeze({
        estimatedCostMinorUnits: stage === 'chunks' ? 12 : 0,
        maximumCostMinorUnits: stage === 'chunks' ? 20 : 10,
        maximumElapsedMs: 60_000,
        ...overrides[stage],
      }),
    ]),
  ))
}

function diarizationRun(workflow, inputSegments) {
  const checkpoint = workflow.stages.find(
    (stage) => stage.stage === 'diarization',
  )
  return createSpeakerDiarizationRun({
    id: 'diarization-run-derived-stages',
    workspaceId: identities.workspaceId,
    projectId: identities.projectId,
    workflowId: identities.workflowId,
    sourceArtifactId: identities.sourceArtifactId,
    sourceArtifactSha256: identities.sourceArtifactSha256,
    sourceManifestId: identities.sourceManifestId,
    sourceManifestHash: identities.sourceManifestHash,
    sourceTranscriptId: identities.sourceTranscriptId,
    sourceTranscriptHash: identities.sourceTranscriptHash,
    durationMs: 600_000,
    providerInput: {
      sha256: sha('derived-provider-input'),
      byteSize: 1_200_000,
      durationMs: 600_000,
      preparation: {
        toolId: 'ffmpeg',
        toolVersion: '8.0.0',
        configurationHash: sha('derived-audio-preparation'),
      },
    },
    provider: {
      id: versions.diarization.provider,
      model: versions.diarization.model,
      version: versions.diarization.version,
    },
    segments: inputSegments ?? [
      {
        providerSegmentId: 'provider-derived-a',
        providerLabel: 'A',
        startMs: 0,
        endMs: 300_000,
        text: 'Primeiro participante conduz o tema inicial.',
      },
      {
        providerSegmentId: 'provider-derived-b',
        providerLabel: 'B',
        startMs: 300_000,
        endMs: 600_000,
        text: 'Segundo participante desenvolve o tema final.',
      },
    ],
    usageSeconds: 600,
    costMinorUnits: 1,
    elapsedMs: 1_000,
    requestFingerprint: sha('derived-diarization-request'),
    idempotencyKey: checkpoint.idempotencyKey,
    createdByClientId: identities.clientId,
    createdAt: '2026-07-30T12:00:01.000Z',
  })
}

function runningChunksWorkflow(options = {}) {
  const initial = createLongFormIndexWorkflow({
    id: identities.workflowId,
    workspaceId: identities.workspaceId,
    projectId: identities.projectId,
    sourceArtifactId: identities.sourceArtifactId,
    sourceArtifactSha256: identities.sourceArtifactSha256,
    sourceManifestId: identities.sourceManifestId,
    sourceManifestHash: identities.sourceManifestHash,
    sourceTranscriptId: identities.sourceTranscriptId,
    sourceTranscriptHash: identities.sourceTranscriptHash,
    durationMs: 600_000,
    versions,
    stageBudgets: budgets(options.stageBudgets),
    reusableOutputs: {
      probe: {
        outputHash: sha('derived-probe'),
        outputEntityId: identities.sourceManifestId,
        resultCount: 1,
      },
      transcript: {
        outputHash: identities.sourceTranscriptHash,
        outputEntityId: identities.sourceTranscriptId,
        resultCount: 4,
      },
    },
    budget: {
      currency: 'USD',
      maximumCostMinorUnits: 100,
      maximumElapsedMs: 300_000,
      maximumConcurrency: 2,
    },
    createdByClientId: identities.clientId,
    createdAt: '2026-07-30T12:00:00.000Z',
  })
  const startedDiarization = startLongFormIndexStage({
    workflow: initial,
    stage: 'diarization',
    expectedRunHash: initial.runHash,
    startedAt: '2026-07-30T12:00:01.000Z',
  })
  const diarization = diarizationRun(
    startedDiarization,
    options.diarizationSegments,
  )
  const completedDiarization = completeLongFormIndexStage({
    workflow: startedDiarization,
    stage: 'diarization',
    expectedRunHash: startedDiarization.runHash,
    expectedInputHash:
      startedDiarization.stages[2].inputHash,
    outputHash: diarization.runHash,
    outputEntityId: diarization.id,
    resultCount: diarization.segmentCount,
    costMinorUnits: diarization.costMinorUnits,
    elapsedMs: diarization.elapsedMs,
    completedAt: '2026-07-30T12:00:02.000Z',
  })
  return {
    workflow: startLongFormIndexStage({
      workflow: completedDiarization,
      stage: 'chunks',
      expectedRunHash: completedDiarization.runHash,
      startedAt: '2026-07-30T12:00:03.000Z',
    }),
    diarization,
  }
}

function sourceContext(rights = {}) {
  return Object.freeze({
    sourceArtifactId: identities.sourceArtifactId,
    sourceArtifactSha256: identities.sourceArtifactSha256,
    sourceManifestId: identities.sourceManifestId,
    sourceManifestHash: identities.sourceManifestHash,
    sourceTranscriptId: identities.sourceTranscriptId,
    sourceTranscriptHash: identities.sourceTranscriptHash,
    durationMs: 600_000,
    probe: Object.freeze({
      width: 1920,
      height: 1080,
      fps: 30,
    }),
    transcriptSegments: Object.freeze([
      Object.freeze({
        id: 1,
        startMs: 10_000,
        endMs: 40_000,
        text: 'A aquisição começa pela leitura correta do contexto.',
      }),
      Object.freeze({
        id: 2,
        startMs: 100_000,
        endMs: 140_000,
        text: 'A oferta organiza a transformação prometida.',
      }),
      Object.freeze({
        id: 3,
        startMs: 310_000,
        endMs: 350_000,
        text: 'A prova precisa sustentar o claim sem exagero.',
      }),
      Object.freeze({
        id: 4,
        startMs: 430_000,
        endMs: 470_000,
        text: 'O fechamento conecta a próxima ação ao objetivo.',
      }),
    ]),
    catalogedVisualObservationCount: 2,
    rights: Object.freeze({
      id: 'rights-derived-stages',
      status: 'approved',
      consentStatus: 'not-required',
      ...rights,
    }),
  })
}

function processorFixture(options = {}) {
  let hierarchical = options.hierarchical
  let longForm
  let hierarchicalPersistCount = 0
  let longFormPersistCount = 0
  let hierarchicalSourceReadCount = 0
  let hierarchicalFindRunCount = 0
  let diarizationFindRunCount = 0
  let longFormContextReadCount = 0
  const hierarchicalFences = []
  const longFormFences = []
  const hierarchicalRepository = {
    async readSourceContext() {
      hierarchicalSourceReadCount += 1
      options.onHierarchicalSourceRead?.()
      return sourceContext(options.rights)
    },
    async findIdempotent(input) {
      return hierarchical?.idempotencyKey === input.idempotencyKey
        ? hierarchical
        : null
    },
    async findRun(input) {
      hierarchicalFindRunCount += 1
      options.onHierarchicalFindRun?.()
      return hierarchical?.id === input.runId
        ? hierarchical
        : null
    },
    async persist() {
      throw new Error('unfenced hierarchical persistence is forbidden')
    },
    async persistWithLongFormLease(input) {
      hierarchicalFences.push(input.fence)
      if (options.hierarchicalLeaseLost) return null
      hierarchicalPersistCount += 1
      hierarchical = input.run
      return Object.freeze({
        run: hierarchical,
        replayed: false,
      })
    },
  }
  const longFormRepository = {
    async readCreationContext() {
      longFormContextReadCount += 1
      options.onLongFormContextRead?.()
      return Object.freeze({
        sourceArtifactId: identities.sourceArtifactId,
        sourceArtifactSha256:
          identities.sourceArtifactSha256,
        sourceManifestId: identities.sourceManifestId,
        sourceManifestHash:
          identities.sourceManifestHash,
        durationMs: 600_000,
        rights: Object.freeze({
          id: 'rights-derived-stages',
          status: options.rights?.status ?? 'approved',
          consentStatus:
            options.rights?.consentStatus ?? 'not-required',
          ...(options.rights?.expiresAt
            ? { expiresAt: options.rights.expiresAt }
            : {}),
          ...(options.rights?.consentExpiresAt
            ? {
                consentExpiresAt:
                  options.rights.consentExpiresAt,
              }
            : {}),
        }),
      })
    },
    async findIdempotent(input) {
      return longForm?.idempotencyKey === input.idempotencyKey
        ? longForm
        : null
    },
    async persist() {
      throw new Error('unfenced long-form persistence is forbidden')
    },
    async persistWithLongFormLease(input) {
      longFormFences.push(input.fence)
      if (options.longFormLeaseLost) return null
      longFormPersistCount += 1
      longForm = input.run
      return Object.freeze({ run: longForm, replayed: false })
    },
    async search() {
      return []
    },
  }
  let monotonic = 0
  const processor = createLongFormDerivedStageProcessor({
    hierarchical: hierarchicalRepository,
    longForm: longFormRepository,
    diarization: {
      async readSourceContext() {
        throw new Error('not used by derived stages')
      },
      async findRun(input) {
        diarizationFindRunCount += 1
        options.onDiarizationFindRun?.()
        return options.diarization?.id === input.runId
          ? options.diarization
          : null
      },
      async findReplay() {
        return null
      },
      async persistWithLease() {
        throw new Error('not used by derived stages')
      },
    },
    createId(kind, sourceId) {
      return sourceId
        ? `${kind}-${sourceId}`
        : `${kind}-derived-stage`
    },
    clock: () => new Date('2026-07-30T12:00:04.000Z'),
    monotonicClock: () => {
      const current = monotonic
      monotonic += 5
      return current
    },
  })
  return {
    processor,
    getHierarchical: () => hierarchical,
    getLongForm: () => longForm,
    getHierarchicalPersistCount: () =>
      hierarchicalPersistCount,
    getLongFormPersistCount: () => longFormPersistCount,
    getHierarchicalSourceReadCount: () =>
      hierarchicalSourceReadCount,
    getHierarchicalFindRunCount: () =>
      hierarchicalFindRunCount,
    getDiarizationFindRunCount: () =>
      diarizationFindRunCount,
    getLongFormContextReadCount: () =>
      longFormContextReadCount,
    hierarchicalFences,
    longFormFences,
  }
}

function processInput(workflow, options = {}) {
  return Object.freeze({
    workflow,
    checkpoint: workflow.stages.find(
      (stage) => stage.status === 'running',
    ),
    lease: Object.freeze({
      operationId: identities.operationId,
      owner: 'worker-derived-stages',
      attempt: 1,
    }),
    signal:
      options.signal ?? new AbortController().signal,
    heartbeat: options.heartbeat ?? (async () => true),
  })
}

test('T-FR-133 chunks persist exactly once behind the workflow lease and replay without duplication', async () => {
  const setup = runningChunksWorkflow()
  const fixture = processorFixture({
    diarization: setup.diarization,
  })
  const first = await fixture.processor.process(
    processInput(setup.workflow),
  )
  assert.equal(first.resultCount, 2)
  assert.equal(first.costMinorUnits, 12)
  assert.equal(fixture.getHierarchicalPersistCount(), 1)
  assert.equal(
    fixture.hierarchicalFences[0].workspaceId,
    identities.workspaceId,
  )
  assert.equal(
    fixture.hierarchicalFences[0].projectId,
    identities.projectId,
  )
  assert.equal(
    fixture.hierarchicalFences[0].expectedStageInputHash,
    processInput(setup.workflow).checkpoint.inputHash,
  )

  const replay = await fixture.processor.process(
    processInput(setup.workflow),
  )
  assert.deepEqual(replay, first)
  assert.equal(fixture.getHierarchicalPersistCount(), 1)
  assert.equal(fixture.hierarchicalFences.length, 1)
})

test('T-FR-133 chunks fail before work when cost is unapproved and never publish after lease loss', async () => {
  const budgetSetup = runningChunksWorkflow({
    stageBudgets: {
      chunks: {
        estimatedCostMinorUnits: 0,
        maximumCostMinorUnits: 1,
      },
    },
  })
  const budgetFixture = processorFixture({
    diarization: budgetSetup.diarization,
  })
  await assert.rejects(
    budgetFixture.processor.process(
      processInput(budgetSetup.workflow),
    ),
    (error) => error.code === 'PRECONDITION_REQUIRED',
  )
  assert.equal(budgetFixture.getHierarchical(), undefined)
  assert.equal(budgetFixture.hierarchicalFences.length, 0)

  const leaseSetup = runningChunksWorkflow()
  const leaseFixture = processorFixture({
    diarization: leaseSetup.diarization,
    hierarchicalLeaseLost: true,
  })
  await assert.rejects(
    leaseFixture.processor.process(
      processInput(leaseSetup.workflow),
    ),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(leaseFixture.getHierarchical(), undefined)
  assert.equal(leaseFixture.hierarchicalFences.length, 1)
})

async function runningMomentsFixture(options = {}) {
  const setup = runningChunksWorkflow({
    diarizationSegments: options.diarizationSegments,
  })
  const chunkFixture = processorFixture({
    diarization: setup.diarization,
  })
  const chunksResult = await chunkFixture.processor.process(
    processInput(setup.workflow),
  )
  const completedChunks = completeLongFormIndexStage({
    workflow: setup.workflow,
    stage: 'chunks',
    expectedRunHash: setup.workflow.runHash,
    expectedInputHash:
      processInput(setup.workflow).checkpoint.inputHash,
    outputHash: chunksResult.outputHash,
    outputEntityId: chunksResult.outputEntityId,
    resultCount: chunksResult.resultCount,
    costMinorUnits: chunksResult.costMinorUnits,
    elapsedMs: chunksResult.elapsedMs,
    completedAt: '2026-07-30T12:00:05.000Z',
  })
  const workflow = startLongFormIndexStage({
    workflow: completedChunks,
    stage: 'moments',
    expectedRunHash: completedChunks.runHash,
    startedAt: '2026-07-30T12:00:06.000Z',
  })
  const fixture = processorFixture({
    hierarchical: chunkFixture.getHierarchical(),
    diarization: setup.diarization,
    longFormLeaseLost: options.longFormLeaseLost,
    rights: options.rights,
    onHierarchicalFindRun:
      options.onHierarchicalFindRun,
  })
  return { workflow, fixture, diarization: setup.diarization }
}

test('T-FR-133 moments derive anonymous speakers only from temporal overlap and persist behind the lease', async () => {
  const { workflow, fixture, diarization } =
    await runningMomentsFixture()
  const result = await fixture.processor.process(
    processInput(workflow),
  )
  const stored = fixture.getLongForm()
  assert.equal(result.resultCount, stored.momentCount)
  assert.ok(stored.moments.length >= 1)
  const knownSpeakerIds = new Set(
    diarization.segments.map((segment) => segment.speakerKey),
  )
  for (const moment of stored.moments) {
    assert.ok(moment.speakerIds.length >= 1)
    assert.ok(
      moment.speakerIds.every((speakerId) =>
        knownSpeakerIds.has(speakerId)),
    )
    const expected = new Set(
      diarization.segments
        .filter((segment) => moment.rangesMs.some(
          ([startMs, endMs]) =>
            segment.startMs < endMs &&
            segment.endMs > startMs,
        ))
        .map((segment) => segment.speakerKey),
    )
    assert.deepEqual(
      new Set(moment.speakerIds),
      expected,
    )
    assert.ok(
      moment.speakerIds.every((speakerId) =>
        !speakerId.includes('person-')),
    )
  }
  assert.equal(fixture.getLongFormPersistCount(), 1)
  assert.equal(fixture.longFormFences[0].stage, 'moments')
  assert.equal(
    fixture.longFormFences[0].expectedStageIdempotencyKey,
    processInput(workflow).checkpoint.idempotencyKey,
  )

  const replay = await fixture.processor.process(
    processInput(workflow),
  )
  assert.equal(replay.outputHash, result.outputHash)
  assert.equal(replay.outputEntityId, result.outputEntityId)
  assert.equal(fixture.getLongFormPersistCount(), 1)
  assert.equal(fixture.longFormFences.length, 1)
})

test('T-FR-133 moments fail closed without temporal speaker evidence or when the persistence lease is lost', async () => {
  const noSpeaker = await runningMomentsFixture({
    diarizationSegments: [{
      providerSegmentId: 'provider-derived-silence-edge',
      providerLabel: 'A',
      startMs: 590_000,
      endMs: 599_000,
      text: 'Fala fora dos momentos catalogados.',
    }],
  })
  await assert.rejects(
    noSpeaker.fixture.processor.process(
      processInput(noSpeaker.workflow),
    ),
    (error) =>
      error.code === 'PERSISTENCE_CONFLICT' &&
      /temporally overlapping speaker/.test(error.message),
  )
  assert.equal(noSpeaker.fixture.getLongForm(), undefined)

  const lost = await runningMomentsFixture({
    longFormLeaseLost: true,
  })
  await assert.rejects(
    lost.fixture.processor.process(
      processInput(lost.workflow),
    ),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(lost.fixture.getLongForm(), undefined)
  assert.equal(lost.fixture.longFormFences.length, 1)
})

test('T-FR-133 derived stages fail closed after rights revocation and the router rejects unconfigured stages', async () => {
  const setup = runningChunksWorkflow()
  const revoked = processorFixture({
    diarization: setup.diarization,
    rights: { status: 'blocked' },
  })
  await assert.rejects(
    revoked.processor.process(processInput(setup.workflow)),
    (error) => error.code === 'ASSET_RIGHTS_BLOCKED',
  )
  assert.equal(revoked.getHierarchical(), undefined)

  const router = createLongFormIndexStageRouter({
    chunks: revoked.processor,
  })
  assert.throws(
    () => router.process({
      ...processInput(setup.workflow),
      checkpoint: {
        ...processInput(setup.workflow).checkpoint,
        stage: 'transcript',
      },
    }),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
})

test('T-FR-133 derived stages validate heartbeat, cancellation and current rights before publication', async () => {
  const chunks = runningChunksWorkflow()
  const controller = new AbortController()
  const cancelled = processorFixture({
    diarization: chunks.diarization,
    onHierarchicalSourceRead: () => controller.abort(),
  })
  await assert.rejects(
    cancelled.processor.process(processInput(
      chunks.workflow,
      { signal: controller.signal },
    )),
    (error) =>
      error.code === 'VERSION_CONFLICT' &&
      /aborted during source validation/.test(error.message),
  )
  assert.equal(cancelled.getHierarchicalSourceReadCount(), 1)
  assert.equal(cancelled.getHierarchicalPersistCount(), 0)
  assert.equal(cancelled.hierarchicalFences.length, 0)

  const moments = await runningMomentsFixture()
  let heartbeatCount = 0
  await assert.rejects(
    moments.fixture.processor.process(processInput(
      moments.workflow,
      {
        heartbeat: async () => {
          heartbeatCount += 1
          return false
        },
      },
    )),
    (error) =>
      error.code === 'VERSION_CONFLICT' &&
      /lease was lost before execution/.test(error.message),
  )
  assert.equal(heartbeatCount, 1)
  assert.equal(
    moments.fixture.getHierarchicalFindRunCount(),
    0,
  )
  assert.equal(moments.fixture.getDiarizationFindRunCount(), 0)
  assert.equal(moments.fixture.getLongFormContextReadCount(), 0)
  assert.equal(moments.fixture.getLongFormPersistCount(), 0)

  const expired = await runningMomentsFixture({
    rights: {
      status: 'approved',
      consentStatus: 'not-required',
      expiresAt: '2026-07-30T12:00:04.000Z',
    },
  })
  await assert.rejects(
    expired.fixture.processor.process(
      processInput(expired.workflow),
    ),
    (error) => error.code === 'ASSET_RIGHTS_BLOCKED',
  )
  assert.equal(expired.fixture.getLongFormContextReadCount(), 1)
  assert.equal(expired.fixture.getLongFormPersistCount(), 0)
  assert.equal(expired.fixture.longFormFences.length, 0)
})
