import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSyntheticBlockGeneration,
  createSyntheticBlockVoiceKey,
} from '../../src/v2/domain/synthetic-block-generation.ts'

const digest = (character) => character.repeat(64)

const voice = createSyntheticBlockVoiceKey({
  adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0', voiceId: 'voice_a', voiceVersion: 1,
  modelRef: null, outputFormat: 'mp3', synthesisConfig: { outputFormat: 'mp3' },
})

const base = {
  id: 'generation-superseded-hit', workspaceId: 'workspace-1', projectId: 'project-1',
  planId: 'plan-1', blockId: 'block-1', attempt: 2,
  cacheKey: digest('a'), scriptHash: digest('b'), profileSnapshotId: 'ana:v2', voice,
  audioArtifactId: 'artifact-audio', alignmentArtifactId: 'artifact-alignment',
  attemptBudget: 3, deadlineAt: '2029-01-01T00:00:00.000Z', createdAt: '2029-01-01T00:00:00.000Z',
}

test('T-FR-105 a superseded cache hit stays readable instead of poisoning its plan', () => {
  // A reuse later replaced by a regeneration is still a reuse. Pinning
  // `hit-reuse` to `approved` made the row unreadable the moment supersession
  // wrote `superseded`, and every later read of the plan that contained it
  // answered 422 — permanently. The combined production journey found it.
  const superseded = createSyntheticBlockGeneration({
    ...base,
    status: 'superseded',
    cacheDecision: 'hit-reuse',
    decisionReason: 'cache hit later replaced by an explicit regeneration',
    sourceGenerationId: 'generation-source',
  })
  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.cacheDecision, 'hit-reuse')
  assert.equal(superseded.sourceGenerationId, 'generation-source')

  const approved = createSyntheticBlockGeneration({
    ...base,
    status: 'approved',
    cacheDecision: 'hit-reuse',
    decisionReason: 'cache hit reusing an approved generation with valid blob and rights',
    sourceGenerationId: 'generation-source',
  })
  assert.equal(approved.status, 'approved')

  // What actually defines a hit still holds: it never owns a provider job and
  // always reuses its source artifacts.
  assert.throws(
    () => createSyntheticBlockGeneration({
      ...base, status: 'approved', cacheDecision: 'hit-reuse',
      decisionReason: 'a hit that claims its own provider job',
      sourceGenerationId: 'generation-source', providerJobId: 'provider-job-1',
    }),
    /without a provider job/,
  )
  assert.throws(
    () => createSyntheticBlockGeneration({
      ...base, status: 'approved', cacheDecision: 'hit-reuse',
      decisionReason: 'a hit with no source generation', sourceGenerationId: undefined,
    }),
    /must reference its source generation/,
  )
  for (const status of ['pending', 'failed']) {
    assert.throws(
      () => createSyntheticBlockGeneration({
        ...base, status, cacheDecision: 'hit-reuse',
        decisionReason: 'a hit that never settled', sourceGenerationId: 'generation-source',
      }),
      /must reference its source generation/,
    )
  }
})
