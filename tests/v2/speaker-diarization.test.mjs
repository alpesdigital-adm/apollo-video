import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createSpeakerDiarizationRun,
  hydrateSpeakerDiarizationRun,
} from '../../src/v2/domain/speaker-diarization.ts'
import {
  completeLongFormIndexStage,
  createLongFormIndexWorkflow,
  startLongFormIndexStage,
} from '../../src/v2/domain/long-form-index-workflow.ts'
import {
  calculateSpeakerDiarizationRequestFingerprint,
  persistSpeakerDiarizationService,
  readSpeakerDiarizationService,
} from '../../src/v2/application/speaker-diarization.ts'
import {
  OpenAiSpeakerDiarizationProvider,
} from '../../src/v2/infrastructure/media/openai-speaker-diarization-provider.ts'
import {
  createSpeakerDiarizationStageProcessor,
} from '../../src/v2/application/speaker-diarization-stage-processor.ts'
import { authenticationAudit } from './helpers/authentication-audit.mjs'

const sha = (value) =>
  createHash('sha256').update(value).digest('hex')
const provider = Object.freeze({
  id: 'openai',
  model: 'gpt-4o-transcribe-diarize',
  version: 'v1',
})
const providerInput = Object.freeze({
  sha256: sha('prepared-audio'),
  byteSize: 14_400_000,
  durationMs: 7_200_000,
  preparation: Object.freeze({
    toolId: 'ffmpeg',
    toolVersion: 'static',
    configurationHash: sha('mono-opus-16khz-16kbps'),
  }),
})
const segments = Object.freeze([
  {
    providerSegmentId: 'provider-segment-001',
    providerLabel: 'A',
    startMs: 0,
    endMs: 5200,
    text: 'Primeira fala do apresentador.',
  },
  {
    providerSegmentId: 'provider-segment-002',
    providerLabel: 'B',
    startMs: 5200,
    endMs: 12800,
    text: 'Resposta do convidado.',
  },
  {
    providerSegmentId: 'provider-segment-003',
    providerLabel: 'A',
    startMs: 12800,
    endMs: 19000,
    text: 'Retorno ao apresentador.',
  },
])

function runInput(overrides = {}) {
  return {
    id: 'diarization-run-test-1',
    workspaceId: 'workspace-diarization',
    projectId: 'project-diarization',
    workflowId: 'workflow-diarization',
    sourceArtifactId: 'artifact-diarization',
    sourceArtifactSha256: sha('artifact'),
    sourceManifestId: 'manifest-diarization',
    sourceManifestHash: sha('manifest'),
    sourceTranscriptId: 'transcript-diarization',
    sourceTranscriptHash: sha('transcript'),
    durationMs: 7_200_000,
    providerInput,
    provider,
    segments,
    usageSeconds: 7200,
    costMinorUnits: 120,
    elapsedMs: 180000,
    requestFingerprint: sha('request'),
    idempotencyKey:
      'workflow-diarization:diarization:11111111111111111111111111111111',
    createdByClientId: 'client-diarization',
    createdAt: '2026-07-29T21:00:00.000Z',
    ...overrides,
  }
}

test('T-FR-133 diarization stores anonymous stable speaker clusters without person identity', () => {
  const run = createSpeakerDiarizationRun(runInput())
  assert.equal(run.speakerCount, 2)
  assert.equal(run.segmentCount, 3)
  assert.equal(run.identityResolved, false)
  assert.equal(run.physicalMaterialized, false)
  assert.equal(
    run.segments[0].speakerKey,
    run.segments[2].speakerKey,
  )
  assert.notEqual(
    run.segments[0].speakerKey,
    run.segments[1].speakerKey,
  )
  assert.match(
    run.segments[0].speakerKey,
    /^speaker-cluster-[a-f0-9]{40}$/,
  )
  assert.deepEqual(
    hydrateSpeakerDiarizationRun(structuredClone(run)),
    run,
  )
})

test('T-FR-133 diarization rejects unordered, duplicate and tampered provider evidence', () => {
  assert.throws(
    () => createSpeakerDiarizationRun(runInput({
      segments: [
        segments[1],
        { ...segments[0], providerSegmentId: segments[1].providerSegmentId },
      ],
    })),
    /ordered with unique provider IDs/,
  )
  const run = structuredClone(
    createSpeakerDiarizationRun(runInput()),
  )
  run.segments[0].speakerKey = 'speaker-cluster-fabricated'
  assert.throws(
    () => hydrateSpeakerDiarizationRun(run),
    /failed integrity validation/,
  )
})

function repositoryFixture(options = {}) {
  let stored
  const audit = authenticationAudit({
    clientId: 'client-diarization',
    credentialId: 'credential-diarization',
    workspaceId: 'workspace-diarization',
  })
  const context = Object.freeze({
    operationId: 'operation-diarization',
    createdByClientId: 'client-diarization',
    sourceArtifactId: 'artifact-diarization',
    sourceArtifactKey: 'masters/workspace/source.mp4',
    sourceArtifactByteSize: 1_000_000n,
    sourceArtifactSha256: sha('artifact'),
    sourceManifestId: 'manifest-diarization',
    sourceManifestHash: sha('manifest'),
    sourceTranscriptId: 'transcript-diarization',
    sourceTranscriptHash: sha('transcript'),
    language: 'pt-BR',
    durationMs: 7_200_000,
    stageStatus: 'running',
    stageInputHash: sha('stage-input'),
    stageIdempotencyKey:
      'workflow-diarization:diarization:11111111111111111111111111111111',
    authenticationAudit: audit,
    ...options.context,
  })
  return {
    repository: {
      async readSourceContext() {
        return context
      },
      async findRun(input) {
        return stored?.id === input.runId ? stored : null
      },
      async findReplay(input) {
        return stored?.idempotencyKey === input.idempotencyKey &&
          stored?.authenticationAudit.contextHash === input.actorContextHash
          ? stored
          : null
      },
      async persistWithLease(input) {
        if (options.leaseLost) return null
        stored = input.run
        return Object.freeze({ run: stored, replayed: false })
      },
    },
    context,
    getStored: () => stored,
  }
}

function serviceRequest(context, overrides = {}) {
  return {
    workspaceId: 'workspace-diarization',
    projectId: 'project-diarization',
    workflowId: 'workflow-diarization',
    expectedStageInputHash: context.stageInputHash,
    provider,
    providerInput,
    segments,
    usageSeconds: 7200,
    costMinorUnits: 120,
    elapsedMs: 180000,
    lease: {
      operationId: context.operationId,
      owner: 'worker-diarization',
      attempt: 1,
    },
    ...overrides,
  }
}

test('T-FR-133 application binds diarization to the exact workflow stage and replays it', async () => {
  const fixture = repositoryFixture()
  const persist = persistSpeakerDiarizationService({
    repository: fixture.repository,
    createRunId: () => 'diarization-run-test-2',
    clock: () => new Date('2026-07-29T21:00:00.000Z'),
  })
  const first = await persist(serviceRequest(fixture.context))
  assert.equal(first.replayed, false)
  assert.equal(first.run.id, 'diarization-run-test-2')
  assert.equal(first.run.idempotencyKey, fixture.context.stageIdempotencyKey)
  assert.deepEqual(
    first.run.authenticationAudit,
    fixture.context.authenticationAudit,
  )
  assert.deepEqual(first.run.provenance, {
    kind: 'long-form-stage',
    workflowId: first.run.workflowId,
    operationId: fixture.context.operationId,
    stage: 'diarization',
    stageInputHash: fixture.context.stageInputHash,
    stageIdempotencyKey: fixture.context.stageIdempotencyKey,
  })
  const fingerprintInput = {
    workspaceId: first.run.workspaceId,
    projectId: first.run.projectId,
    workflowId: first.run.workflowId,
    sourceArtifactId: first.run.sourceArtifactId,
    sourceArtifactSha256: first.run.sourceArtifactSha256,
    sourceManifestId: first.run.sourceManifestId,
    sourceManifestHash: first.run.sourceManifestHash,
    sourceTranscriptId: first.run.sourceTranscriptId,
    sourceTranscriptHash: first.run.sourceTranscriptHash,
    durationMs: first.run.durationMs,
    providerInput: first.run.providerInput,
    expectedStageInputHash: first.run.provenance.stageInputHash,
    provider: first.run.provider,
    segments: first.run.segments.map((segment) => ({
      providerSegmentId: segment.providerSegmentId,
      providerLabel: segment.providerLabel,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
    usageSeconds: first.run.usageSeconds,
    costMinorUnits: first.run.costMinorUnits,
    elapsedMs: first.run.elapsedMs,
    createdByClientId: first.run.createdByClientId,
    actorContextHash: first.run.authenticationAudit.contextHash,
    provenance: first.run.provenance,
  }
  assert.equal(
    calculateSpeakerDiarizationRequestFingerprint(fingerprintInput),
    first.run.requestFingerprint,
  )
  assert.notEqual(
    calculateSpeakerDiarizationRequestFingerprint({
      ...fingerprintInput,
      provenance: {
        ...fingerprintInput.provenance,
        operationId: 'operation-diarization-tampered',
      },
    }),
    first.run.requestFingerprint,
  )
  const replay = await persist(serviceRequest(fixture.context))
  assert.equal(replay.replayed, true)
  assert.equal(replay.run.runHash, first.run.runHash)
  const read = await readSpeakerDiarizationService({
    repository: fixture.repository,
  })({
    workspaceId: first.run.workspaceId,
    projectId: first.run.projectId,
    runId: first.run.id,
  })
  assert.equal(read.runHash, first.run.runHash)
})

test('T-FR-133 application fails closed on stage drift and lease loss', async () => {
  const drift = repositoryFixture()
  const persistDrift = persistSpeakerDiarizationService({
    repository: drift.repository,
    createRunId: () => 'diarization-run-test-3',
    clock: () => new Date('2026-07-29T21:00:00.000Z'),
  })
  await assert.rejects(
    persistDrift(serviceRequest(drift.context, {
      expectedStageInputHash: sha('stale-stage'),
    })),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  const lease = repositoryFixture({ leaseLost: true })
  const persistLease = persistSpeakerDiarizationService({
    repository: lease.repository,
    createRunId: () => 'diarization-run-test-4',
    clock: () => new Date('2026-07-29T21:00:00.000Z'),
  })
  await assert.rejects(
    persistLease(serviceRequest(lease.context)),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(lease.getStored(), undefined)
})

async function withAudio(run) {
  const directory = await mkdtemp(
    join(tmpdir(), 'apollo-diarization-'),
  )
  const audioPath = join(directory, 'source.mp3')
  try {
    await writeFile(audioPath, Buffer.from('controlled-audio'))
    return await run(audioPath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function diarizedPayload(overrides = {}) {
  return {
    task: 'transcribe',
    duration: 12,
    text: 'Primeira fala. Segunda fala.',
    segments: [
      {
        type: 'transcript.text.segment',
        id: 'seg_001',
        start: 0,
        end: 5.2,
        text: 'Primeira fala.',
        speaker: 'A',
      },
      {
        type: 'transcript.text.segment',
        id: 'seg_002',
        start: 5.2,
        end: 12,
        text: 'Segunda fala.',
        speaker: 'B',
      },
    ],
    usage: { type: 'duration', seconds: 13 },
    ...overrides,
  }
}

test('T-FR-133 OpenAI adapter requests diarized JSON and normalizes controlled evidence', async () => {
  await withAudio(async (audioPath) => {
    let request
    const adapter = new OpenAiSpeakerDiarizationProvider({
      apiKey: `sk-${'a'.repeat(48)}`,
      fetchImplementation: async (url, init) => {
        request = { url, init }
        return Response.json(diarizedPayload())
      },
    })
    const result = await adapter.diarize({
      audioPath,
      language: 'pt-BR',
      expectedDurationMs: 12_000,
      signal: new AbortController().signal,
    })
    assert.equal(
      request.url,
      'https://api.openai.com/v1/audio/transcriptions',
    )
    assert.equal(request.init.method, 'POST')
    assert.match(
      request.init.headers.authorization,
      /^Bearer sk-/,
    )
    const form = request.init.body
    assert.equal(
      form.get('model'),
      'gpt-4o-transcribe-diarize',
    )
    assert.equal(form.get('response_format'), 'diarized_json')
    assert.equal(form.get('chunking_strategy'), 'auto')
    assert.equal(form.get('language'), 'pt')
    assert.equal(form.get('file').name, 'source.mp3')
    assert.deepEqual(result.provider, {
      id: 'openai',
      model: 'gpt-4o-transcribe-diarize',
      version: 'diarized-json/v1',
    })
    assert.equal(result.usageSeconds, 13)
    assert.deepEqual(result.segments.map((segment) => ({
      id: segment.providerSegmentId,
      speaker: segment.providerLabel,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })), [
      { id: 'seg_001', speaker: 'A', startMs: 0, endMs: 5200 },
      { id: 'seg_002', speaker: 'B', startMs: 5200, endMs: 12000 },
    ])
  })
})

test('T-FR-133 OpenAI adapter rejects misaligned or tampered provider evidence', async () => {
  await withAudio(async (audioPath) => {
    const response = diarizedPayload({
      segments: [
        diarizedPayload().segments[0],
        {
          ...diarizedPayload().segments[1],
          id: 'seg_001',
        },
      ],
    })
    const adapter = new OpenAiSpeakerDiarizationProvider({
      apiKey: `sk-${'b'.repeat(48)}`,
      fetchImplementation: async () => Response.json(response),
    })
    await assert.rejects(
      adapter.diarize({
        audioPath,
        language: 'pt-BR',
        expectedDurationMs: 12_000,
        signal: new AbortController().signal,
      }),
      (error) =>
        error.code === 'RENDER_OUTPUT_INVALID' &&
        /evidence is invalid/.test(error.message),
    )
  })
})

test('T-FR-133 OpenAI adapter fails closed without leaking credentials or paths', async () => {
  await withAudio(async (audioPath) => {
    const secret = `sk-${'c'.repeat(48)}`
    const adapter = new OpenAiSpeakerDiarizationProvider({
      apiKey: secret,
      fetchImplementation: async () =>
        new Response('provider detail', { status: 503 }),
    })
    await assert.rejects(
      adapter.diarize({
        audioPath,
        language: 'pt-BR',
        expectedDurationMs: 12_000,
        signal: new AbortController().signal,
      }),
      (error) =>
        error.code === 'RENDER_EXECUTION_FAILED' &&
        !error.message.includes(secret) &&
        !error.message.includes(audioPath) &&
        !error.message.includes('provider detail'),
    )
    await assert.rejects(
      adapter.diarize({
        audioPath,
        language: 'not a locale',
        expectedDurationMs: 12_000,
        signal: new AbortController().signal,
      }),
      (error) => error.code === 'INVALID_ARGUMENT',
    )
  })
})

function runningDiarizationWorkflow(options = {}) {
  const versions = Object.freeze({
    probe: {
      provider: 'ffprobe',
      model: 'probe',
      version: '8.0.0',
    },
    transcript: {
      provider: 'groq',
      model: 'whisper-large-v3',
      version: '2026-07',
    },
    diarization: {
      provider: 'openai',
      model: 'gpt-4o-transcribe-diarize',
      version: 'diarized-json/v1',
    },
    chunks: {
      provider: 'apollo',
      model: 'overlapping-time-chunks',
      version: '1.0.0',
    },
    moments: {
      provider: 'apollo',
      model: 'hierarchical-moments',
      version: '1.0.0',
    },
  })
  const stageBudgets = Object.freeze(Object.fromEntries(
    Object.keys(versions).map((stage) => [
      stage,
      {
        estimatedCostMinorUnits:
          stage === 'diarization' ? 120 : 0,
        maximumCostMinorUnits:
          stage === 'diarization' ? 200 : 50,
        maximumElapsedMs: 3_600_000,
      },
    ]),
  ))
  const ready = createLongFormIndexWorkflow({
    id: 'workflow-diarization',
    workspaceId: 'workspace-diarization',
    projectId: 'project-diarization',
    sourceArtifactId: 'artifact-diarization',
    sourceArtifactSha256: sha('artifact'),
    sourceManifestId: 'manifest-diarization',
    sourceManifestHash: sha('manifest'),
    ...(options.generatedTranscript
      ? {}
      : {
          sourceTranscriptId: 'transcript-diarization',
          sourceTranscriptHash: sha('transcript'),
        }),
    durationMs: 7_200_000,
    versions,
    stageBudgets,
    reusableOutputs: {
      probe: {
        outputHash: sha('probe'),
        outputEntityId: 'manifest-diarization',
        resultCount: 1,
      },
      ...(options.generatedTranscript
        ? {}
        : {
            transcript: {
              outputHash: sha('transcript'),
              outputEntityId: 'transcript-diarization',
              resultCount: 1200,
            },
          }),
    },
    budget: {
      currency: 'USD',
      maximumCostMinorUnits: 600,
      maximumElapsedMs: 10_800_000,
      maximumConcurrency: 4,
    },
    createdByClientId: 'client-diarization',
    createdAt: '2026-07-29T21:00:00.000Z',
  })
  let transcriptReady = ready
  if (options.generatedTranscript) {
    const startedTranscript = startLongFormIndexStage({
      workflow: ready,
      stage: 'transcript',
      expectedRunHash: ready.runHash,
      startedAt: '2026-07-29T21:00:01.000Z',
    })
    transcriptReady = completeLongFormIndexStage({
      workflow: startedTranscript,
      stage: 'transcript',
      expectedRunHash: startedTranscript.runHash,
      expectedInputHash: startedTranscript.stages[1].inputHash,
      outputHash: sha('transcript'),
      outputEntityId: 'transcript-diarization',
      resultCount: 1200,
      costMinorUnits: 1,
      elapsedMs: 1,
      completedAt: '2026-07-29T21:00:02.000Z',
    })
  }
  return startLongFormIndexStage({
    workflow: transcriptReady,
    stage: 'diarization',
    expectedRunHash: transcriptReady.runHash,
    startedAt: options.generatedTranscript
      ? '2026-07-29T21:00:03.000Z'
      : '2026-07-29T21:00:01.000Z',
  })
}

test('T-FR-133 stage processor prepares immutable audio, persists lineage and replays without provider cost', async () => {
  const workflow = runningDiarizationWorkflow({
    generatedTranscript: true,
  })
  assert.equal(workflow.sourceTranscriptId, undefined)
  assert.equal(workflow.sourceTranscriptHash, undefined)
  const checkpoint = workflow.stages.find(
    (stage) => stage.stage === 'diarization',
  )
  const fixture = repositoryFixture({
    context: {
      stageInputHash: checkpoint.inputHash,
      stageIdempotencyKey: checkpoint.idempotencyKey,
    },
  })
  let prepared = 0
  let providerCalls = 0
  let cleanupCalls = 0
  let providerLanguage
  let monotonic = 0
  const processor = createSpeakerDiarizationStageProcessor({
    repository: fixture.repository,
    audio: {
      async prepare(input) {
        prepared += 1
        assert.equal(
          input.sourceArtifactKey,
          fixture.context.sourceArtifactKey,
        )
        return {
          audioPath: 'C:/controlled/provider-input.ogg',
          sha256: providerInput.sha256,
          byteSize: providerInput.byteSize,
          durationMs: providerInput.durationMs,
          preparation: providerInput.preparation,
        }
      },
      async cleanup(operationId) {
        cleanupCalls += 1
        assert.equal(operationId, fixture.context.operationId)
      },
    },
    providers: {
      resolveDiarization() {
        return {
          identity: {
            provider: 'openai',
            model: 'gpt-4o-transcribe-diarize',
            version: 'diarized-json/v1',
          },
          pricingMinorUnitsPerHour: 60,
          create() {
            return {
              async diarize(input) {
                providerCalls += 1
                providerLanguage = input.language
                return {
                  provider: {
                    id: 'openai',
                    model: 'gpt-4o-transcribe-diarize',
                    version: 'diarized-json/v1',
                  },
                  segments,
                  usageSeconds: 7200,
                }
              },
            }
          },
        }
      },
    },
    createRunId: () => 'diarization-run-stage-processor',
    clock: () => new Date('2026-07-29T21:00:02.000Z'),
    monotonicClock: () => {
      const value = monotonic
      monotonic += 1000
      return value
    },
  })
  const request = {
    workflow,
    checkpoint,
    lease: {
      operationId: fixture.context.operationId,
      owner: 'worker-diarization',
      attempt: 1,
    },
    signal: new AbortController().signal,
    authenticationAudit: {},
    heartbeat: async () => true,
  }
  const first = await processor.process(request)
  assert.equal(first.outputEntityId, 'diarization-run-stage-processor')
  assert.equal(first.resultCount, segments.length)
  assert.equal(first.costMinorUnits, 120)
  assert.equal(providerLanguage, 'pt-BR')
  assert.equal(fixture.getStored().providerInput.sha256, providerInput.sha256)
  assert.equal(prepared, 1)
  assert.equal(providerCalls, 1)
  assert.equal(cleanupCalls, 1)

  const replay = await processor.process(request)
  assert.deepEqual(replay, first)
  assert.equal(prepared, 1)
  assert.equal(providerCalls, 1)
  assert.equal(cleanupCalls, 1)
})

test('T-FR-133 stage processor blocks unapproved cost before preparing or calling the provider', async () => {
  const workflow = runningDiarizationWorkflow()
  const checkpoint = workflow.stages.find(
    (stage) => stage.stage === 'diarization',
  )
  const fixture = repositoryFixture({
    context: {
      stageInputHash: checkpoint.inputHash,
      stageIdempotencyKey: checkpoint.idempotencyKey,
    },
  })
  let touchedExternalInput = false
  const processor = createSpeakerDiarizationStageProcessor({
    repository: fixture.repository,
    audio: {
      async prepare() {
        touchedExternalInput = true
        throw new Error('must not run')
      },
      async cleanup() {},
    },
    providers: {
      resolveDiarization() {
        return {
          identity: {
            provider: 'openai',
            model: 'gpt-4o-transcribe-diarize',
            version: 'diarized-json/v1',
          },
          pricingMinorUnitsPerHour: 1000,
          create() {
            return {
              async diarize() {
                touchedExternalInput = true
                throw new Error('must not run')
              },
            }
          },
        }
      },
    },
    createRunId: () => 'diarization-run-budget',
  })
  await assert.rejects(
    processor.process({
      workflow,
      checkpoint,
      lease: {
        operationId: fixture.context.operationId,
        owner: 'worker-diarization',
        attempt: 1,
      },
      signal: new AbortController().signal,
      authenticationAudit: {},
      heartbeat: async () => true,
    }),
    (error) => error.code === 'PRECONDITION_REQUIRED',
  )
  assert.equal(touchedExternalInput, false)
})
