import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLongFormTranscriptStageProcessor,
} from '../../src/v2/application/long-form-transcript-stage-processor.ts'
import {
  createLongFormIndexWorkflow,
  startLongFormIndexStage,
} from '../../src/v2/domain/long-form-index-workflow.ts'
import {
  createMediaTranscript,
} from '../../src/v2/domain/media-transcript.ts'

const sha = (value) =>
  Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)

const versions = Object.freeze(Object.fromEntries(
  ['probe', 'transcript', 'diarization', 'chunks', 'moments'].map(
    (stage) => [stage, Object.freeze({
      provider: stage === 'transcript' ? 'groq' : 'apollo',
      model: stage === 'transcript'
        ? 'whisper-large-v3'
        : `${stage}-model`,
      version: stage === 'transcript'
        ? 'groq-audio-transcriptions/v1'
        : '1.0.0',
    })],
  ),
))

const stageBudgets = Object.freeze(Object.fromEntries(
  ['probe', 'transcript', 'diarization', 'chunks', 'moments'].map(
    (stage) => [stage, Object.freeze({
      estimatedCostMinorUnits:
        stage === 'transcript' ? 50 : 0,
      maximumCostMinorUnits: stage === 'transcript' ? 100 : 10,
      maximumElapsedMs: 60_000,
    })],
  ),
))

function runningWorkflow() {
  const created = createLongFormIndexWorkflow({
    id: 'long-form-workflow-transcript',
    workspaceId: 'workspace-transcript',
    projectId: 'project-transcript',
    sourceArtifactId: 'artifact-transcript',
    sourceArtifactSha256: sha('artifact'),
    sourceManifestId: 'manifest-transcript',
    sourceManifestHash: sha('manifest'),
    durationMs: 7_200_000,
    versions,
    stageBudgets,
    reusableOutputs: {
      probe: {
        outputHash: sha('probe'),
        outputEntityId: 'manifest-transcript',
        resultCount: 1,
      },
    },
    budget: {
      currency: 'USD',
      maximumCostMinorUnits: 1_000,
      maximumElapsedMs: 3_600_000,
      maximumConcurrency: 1,
    },
    createdByClientId: 'client-transcript',
    createdAt: '2026-07-30T12:00:00.000Z',
  })
  return startLongFormIndexStage({
    workflow: created,
    stage: 'transcript',
    expectedRunHash: created.runHash,
    startedAt: '2026-07-30T12:00:01.000Z',
  })
}

function transcriptFixture() {
  return createMediaTranscript({
    language: 'pt-BR',
    text: 'Uma fala longa de teste.',
    words: [
      { word: 'Uma', start: 0, end: 0.2 },
      { word: 'fala', start: 0.2, end: 0.5 },
    ],
    segments: [{
      id: 0,
      start: 0,
      end: 0.5,
      text: 'Uma fala longa de teste.',
    }],
    provider: 'groq',
    model: 'whisper-large-v3',
  })
}

function fixture(options = {}) {
  const workflow = runningWorkflow()
  const checkpoint = workflow.stages.find(
    (stage) => stage.stage === 'transcript',
  )
  const transcript = transcriptFixture()
  let providerCalls = 0
  let persistCalls = 0
  let cleanupCalls = 0
  const repository = {
    async readTranscriptStageContext() {
      return {
        operationId: 'operation-transcript',
        createdByClientId: workflow.createdByClientId,
        sourceArtifactId: workflow.sourceArtifactId,
        sourceArtifactKey: 'masters/source.mp4',
        sourceArtifactByteSize: 1_024n,
        sourceArtifactSha256: workflow.sourceArtifactSha256,
        sourceManifestId: workflow.sourceManifestId,
        sourceManifestHash: workflow.sourceManifestHash,
        durationMs: workflow.durationMs,
        language: 'pt-BR',
        stageStatus: 'running',
        stageInputHash: checkpoint.inputHash,
        stageIdempotencyKey: checkpoint.idempotencyKey,
      }
    },
    async findTranscriptStageReplay() {
      return options.replay
        ? { id: 'transcript-replay', transcript }
        : null
    },
    async persistTranscriptWithLease(input) {
      persistCalls += 1
      options.onPersist?.(input)
      return options.leaseLost
        ? null
        : {
            id: input.transcriptId,
            transcript: input.transcript,
            replayed: false,
          }
    },
  }
  const processor = createLongFormTranscriptStageProcessor({
    repository,
    providers: {
      resolveTranscription() {
        return {
          identity: versions.transcript,
          pricingMinorUnitsPerHour: 25,
          create() {
            return {
              async transcribe() {
                providerCalls += 1
                return transcript
              },
            }
          },
        }
      },
    },
    audio: {
      async prepare() {
        return {
          audioPath: 'C:/temp/provider-input.mp3',
          sha256: sha('audio'),
          byteSize: 2_048,
          durationMs: workflow.durationMs,
          preparation: {
            toolId: 'ffmpeg',
            toolVersion: 'test',
            configurationHash: sha('configuration'),
          },
        }
      },
      async cleanup() {
        cleanupCalls += 1
      },
    },
    createTranscriptId: (hash) => `transcript-${hash}`,
    monotonicClock: (() => {
      let value = 0
      return () => (value += 10)
    })(),
    clock: () => new Date('2026-07-30T12:00:10.000Z'),
  })
  return {
    workflow,
    checkpoint,
    processor,
    getProviderCalls: () => providerCalls,
    getPersistCalls: () => persistCalls,
    getCleanupCalls: () => cleanupCalls,
  }
}

function input(value, heartbeat = async () => true) {
  return {
    workflow: value.workflow,
    checkpoint: value.checkpoint,
    lease: {
      operationId: 'operation-transcript',
      owner: 'worker-transcript',
      attempt: 1,
    },
    signal: new AbortController().signal,
    authenticationAudit: {},
    heartbeat,
  }
}

test('T-FR-133 transcript stage materializes, transcribes and persists behind the operation lease', async () => {
  let persisted
  const value = fixture({
    onPersist(input) {
      persisted = input
    },
  })
  const result = await value.processor.process(input(value))
  assert.equal(value.getProviderCalls(), 1)
  assert.equal(value.getPersistCalls(), 1)
  assert.equal(value.getCleanupCalls(), 1)
  assert.equal(result.outputHash, persisted.transcript.transcriptHash)
  assert.equal(result.outputEntityId, persisted.transcriptId)
  assert.equal(result.costMinorUnits, 50)
  assert.equal(persisted.expectedStageInputHash, value.checkpoint.inputHash)
  assert.equal(persisted.leaseOwner, 'worker-transcript')
})

test('T-FR-133 transcript stage reuses exact source/provider output without paid execution', async () => {
  const value = fixture({ replay: true })
  const result = await value.processor.process(input(value))
  assert.equal(result.outputEntityId, 'transcript-replay')
  assert.equal(result.costMinorUnits, 0)
  assert.equal(value.getProviderCalls(), 0)
  assert.equal(value.getPersistCalls(), 1)
  assert.equal(value.getCleanupCalls(), 0)
})

test('T-FR-133 transcript stage does not publish after lease loss', async () => {
  const value = fixture({ leaseLost: true })
  await assert.rejects(
    value.processor.process(input(value)),
    /lease was lost before persistence/,
  )
  assert.equal(value.getProviderCalls(), 1)
  assert.equal(value.getPersistCalls(), 1)
  assert.equal(value.getCleanupCalls(), 1)
})
