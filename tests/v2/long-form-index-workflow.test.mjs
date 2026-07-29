import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeLongFormIndexStage,
  createLongFormIndexWorkflow,
  failLongFormIndexStage,
  hydrateLongFormIndexWorkflow,
  resumeLongFormIndexWorkflow,
  startLongFormIndexStage,
} from '../../src/v2/domain/long-form-index-workflow.ts'

const sha = (character) => character.repeat(64)
const at = (second) =>
  `2026-07-29T20:00:${String(second).padStart(2, '0')}.000Z`

const versions = Object.freeze({
  probe: { provider: 'ffprobe', model: 'probe', version: '8.0.0' },
  transcript: {
    provider: 'groq',
    model: 'whisper-large-v3',
    version: '2026-07',
  },
  diarization: {
    provider: 'diarization-provider',
    model: 'speaker-segments',
    version: '1.0.0',
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

const stageBudgets = Object.freeze({
  probe: {
    estimatedCostMinorUnits: 0,
    maximumCostMinorUnits: 0,
    maximumElapsedMs: 30_000,
  },
  transcript: {
    estimatedCostMinorUnits: 300,
    maximumCostMinorUnits: 400,
    maximumElapsedMs: 900_000,
  },
  diarization: {
    estimatedCostMinorUnits: 120,
    maximumCostMinorUnits: 200,
    maximumElapsedMs: 600_000,
  },
  chunks: {
    estimatedCostMinorUnits: 20,
    maximumCostMinorUnits: 40,
    maximumElapsedMs: 120_000,
  },
  moments: {
    estimatedCostMinorUnits: 80,
    maximumCostMinorUnits: 120,
    maximumElapsedMs: 300_000,
  },
})

function fixture(overrides = {}) {
  return {
    id: 'long-form-workflow-run-1',
    workspaceId: 'workspace-long-form',
    projectId: 'project-long-form',
    sourceArtifactId: 'artifact-long-form',
    sourceArtifactSha256: sha('a'),
    sourceManifestId: 'manifest-long-form',
    sourceManifestHash: sha('b'),
    durationMs: 7_200_000,
    versions,
    stageBudgets,
    reusableOutputs: {
      probe: { outputHash: sha('c'), resultCount: 1 },
      transcript: { outputHash: sha('d'), resultCount: 1_800 },
    },
    budget: {
      currency: 'USD',
      maximumCostMinorUnits: 600,
      maximumElapsedMs: 1_800_000,
      maximumConcurrency: 4,
    },
    createdByClientId: 'api-client-long-form',
    createdAt: at(0),
    ...overrides,
  }
}

function runStage(workflow, stage, second, output, resultCount, cost) {
  const running = startLongFormIndexStage({
    workflow,
    stage,
    expectedRunHash: workflow.runHash,
    startedAt: at(second),
  })
  return completeLongFormIndexStage({
    workflow: running,
    stage,
    expectedRunHash: running.runHash,
    expectedInputHash:
      running.stages.find((item) => item.stage === stage).inputHash,
    outputHash: output,
    resultCount,
    costMinorUnits: cost,
    elapsedMs: 100,
    completedAt: at(second + 1),
  })
}

test('T-FR-133 plans five ordered stages for a two-hour source', () => {
  const workflow = createLongFormIndexWorkflow(fixture())
  assert.deepEqual(
    workflow.stages.map((stage) => [
      stage.stage,
      stage.status,
      stage.execution,
    ]),
    [
      ['probe', 'succeeded', 'reuse'],
      ['transcript', 'succeeded', 'reuse'],
      ['diarization', 'ready', 'process'],
      ['chunks', 'pending', 'process'],
      ['moments', 'pending', 'process'],
    ],
  )
  assert.equal(workflow.status, 'partial')
  assert.equal(workflow.summary.nextStage, 'diarization')
  assert.equal(workflow.summary.searchableStageCount, 1)
  assert.equal(
    workflow.stages.find((stage) => stage.stage === 'chunks')
      .concurrency,
    4,
  )
  assert.equal(workflow.summary.duplicateSegments, false)
  assert.equal(workflow.summary.resumable, true)
})

test('T-FR-133 publishes transcript, chunks and moments incrementally', () => {
  let workflow = createLongFormIndexWorkflow(fixture())
  workflow = runStage(
    workflow,
    'diarization',
    1,
    sha('e'),
    3,
    100,
  )
  assert.equal(workflow.summary.nextStage, 'chunks')
  workflow = runStage(workflow, 'chunks', 3, sha('f'), 24, 20)
  assert.equal(workflow.summary.searchableStageCount, 2)
  assert.equal(workflow.summary.nextStage, 'moments')
  workflow = runStage(workflow, 'moments', 5, sha('1'), 41, 70)
  assert.equal(workflow.status, 'succeeded')
  assert.equal(workflow.summary.searchableStageCount, 3)
  assert.equal(workflow.summary.costMinorUnits, 190)
  assert.equal(workflow.summary.resultCount, 1_869)
  assert.equal(workflow.summary.nextStage, undefined)
})

test('T-FR-133 resumes after restart without changing stage identity', () => {
  let workflow = createLongFormIndexWorkflow(fixture())
  workflow = runStage(
    workflow,
    'diarization',
    1,
    sha('e'),
    2,
    100,
  )
  workflow = runStage(workflow, 'chunks', 3, sha('f'), 24, 20)
  const beforeRestart = workflow.stages.find((stage) =>
    stage.stage === 'chunks')
  const hydrated = hydrateLongFormIndexWorkflow(
    structuredClone(workflow),
  )
  const afterRestart = hydrated.stages.find((stage) =>
    stage.stage === 'chunks')
  assert.equal(afterRestart.idempotencyKey, beforeRestart.idempotencyKey)
  assert.equal(afterRestart.outputHash, beforeRestart.outputHash)
  assert.equal(afterRestart.resultCount, 24)
  assert.equal(hydrated.summary.duplicateSegments, false)
  assert.throws(
    () => startLongFormIndexStage({
      workflow: hydrated,
      stage: 'chunks',
      expectedRunHash: hydrated.runHash,
      startedAt: at(5),
    }),
    /Only the next ready/,
  )
})

test('T-FR-133 retries only the failed stage with the same input', () => {
  const workflow = createLongFormIndexWorkflow(fixture())
  const running = startLongFormIndexStage({
    workflow,
    stage: 'diarization',
    expectedRunHash: workflow.runHash,
    startedAt: at(1),
  })
  const failed = failLongFormIndexStage({
    workflow: running,
    stage: 'diarization',
    expectedRunHash: running.runHash,
    code: 'provider_timeout',
    message: 'Diarization provider timed out',
    retryable: true,
    failedAt: at(2),
  })
  const failedStage = failed.stages.find((stage) =>
    stage.stage === 'diarization')
  const resumed = resumeLongFormIndexWorkflow({
    workflow: failed,
    expectedRunHash: failed.runHash,
    resumedAt: at(3),
  })
  const resumedStage = resumed.stages.find((stage) =>
    stage.stage === 'diarization')
  assert.equal(resumedStage.status, 'ready')
  assert.equal(resumedStage.attempt, 1)
  assert.equal(resumedStage.inputHash, failedStage.inputHash)
  assert.equal(resumedStage.idempotencyKey, failedStage.idempotencyKey)
  assert.equal(
    resumed.stages.find((stage) => stage.stage === 'chunks').status,
    'pending',
  )
})

test('T-FR-133 blocks a stage before exceeding the global budget', () => {
  const workflow = createLongFormIndexWorkflow(fixture({
    reusableOutputs: {
      probe: { outputHash: sha('c'), resultCount: 1 },
      transcript: { outputHash: sha('d'), resultCount: 1_800 },
      diarization: { outputHash: sha('e'), resultCount: 2 },
    },
    budget: {
      currency: 'USD',
      maximumCostMinorUnits: 50,
      maximumElapsedMs: 1_800_000,
      maximumConcurrency: 3,
    },
  }))
  assert.equal(
    workflow.stages.find((stage) => stage.stage === 'chunks').status,
    'ready',
  )
  const afterChunks = runStage(
    workflow,
    'chunks',
    1,
    sha('f'),
    24,
    20,
  )
  assert.equal(
    afterChunks.stages.find((stage) =>
      stage.stage === 'moments').status,
    'budget-blocked',
  )
})

test('T-FR-133 rejects stale completion and persisted tampering', () => {
  const workflow = createLongFormIndexWorkflow(fixture())
  const running = startLongFormIndexStage({
    workflow,
    stage: 'diarization',
    expectedRunHash: workflow.runHash,
    startedAt: at(1),
  })
  assert.throws(
    () => completeLongFormIndexStage({
      workflow: running,
      stage: 'diarization',
      expectedRunHash: workflow.runHash,
      expectedInputHash:
        running.stages.find((stage) =>
          stage.stage === 'diarization').inputHash,
      outputHash: sha('e'),
      resultCount: 2,
      costMinorUnits: 100,
      elapsedMs: 100,
      completedAt: at(2),
    }),
    /changed before stage completion/,
  )
  const tampered = structuredClone(workflow)
  tampered.stages[2].concurrency = 31
  assert.throws(
    () => hydrateLongFormIndexWorkflow(tampered),
    /hash is invalid/,
  )
})
