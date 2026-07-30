import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createContiguousEvaluationEvidence,
} from '../../src/v2/domain/contiguous-evaluation-evidence.ts'

const sha = (value) => value.repeat(64).slice(0, 64)

function evidence(overrides = {}) {
  return createContiguousEvaluationEvidence({
    id: 'contiguous-audio-evidence-1',
    sourceIndexRunId: 'long-form-index-run-1',
    sourceIndexRunHash: sha('a'),
    sourceMomentId: 'long-form-moment-1',
    sourceMomentHash: sha('b'),
    kind: 'audio-analysis',
    dimensions: ['audio'],
    rangeMs: [5_000, 125_000],
    producer: {
      provider: 'apollo',
      model: 'ffmpeg-audio-quality',
      version: '1.0.0',
      inputHash: sha('c'),
      outputHash: sha('d'),
    },
    facts: {
      clippingRatio: 0,
      integratedLufs: -16,
      measured: true,
    },
    ...overrides,
  })
}

test('T-FR-134 evidence hash binds source, analyzer, range and canonical facts', () => {
  const first = evidence()
  const replay = evidence({
    facts: {
      measured: true,
      integratedLufs: -16,
      clippingRatio: 0,
    },
  })
  const changed = evidence({
    producer: {
      ...first.producer,
      outputHash: sha('e'),
    },
  })

  assert.equal(first.evidenceHash, replay.evidenceHash)
  assert.notEqual(first.evidenceHash, changed.evidenceHash)
  assert.deepEqual(Object.keys(first.facts), [
    'clippingRatio',
    'integratedLufs',
    'measured',
  ])
})

test('T-FR-134 evidence kinds cannot claim an unrelated quality dimension', () => {
  assert.throws(
    () => evidence({ dimensions: ['visual'] }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => evidence({
      kind: 'transcript-density',
      dimensions: ['density', 'selfContained'],
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

test('T-FR-134 evidence rejects invalid lineage, analyzer hashes and non-finite facts', () => {
  assert.throws(
    () => evidence({ sourceMomentHash: sha('z') }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => evidence({
      producer: {
        ...evidence().producer,
        inputHash: sha('z'),
      },
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => evidence({ facts: { loudness: Number.NaN } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})
