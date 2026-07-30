import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  createLongFormMomentTranscriptEvidence,
} from '../../src/v2/domain/long-form-transcript-evidence.ts'

const sha = (value) => value.repeat(64).slice(0, 64)

function span(overrides = {}) {
  const content = {
    id: 'evidence-span-transcript-1',
    sourceSegmentId: 1,
    rangeMs: [10_000, 40_000],
    text: 'Uma frase completa preservada.',
    textHash: calculateCanonicalHash(
      'Uma frase completa preservada.',
    ),
    wordCount: 4,
    chunkIds: ['hierarchical-chunk-1'],
    ...overrides,
  }
  return {
    ...content,
    spanHash: calculateCanonicalHash(content),
  }
}

function evidence(overrides = {}) {
  return createLongFormMomentTranscriptEvidence({
    id: 'moment-transcript-evidence-1',
    workspaceId: 'workspace-transcript-evidence',
    projectId: 'project-transcript-evidence',
    indexRunId: 'index-transcript-evidence',
    indexRunHash: sha('a'),
    momentId: 'moment-transcript-evidence',
    momentHash: sha('b'),
    hierarchicalRunId: 'hierarchical-transcript-evidence',
    hierarchicalRunHash: sha('c'),
    sourceTranscriptId: 'transcript-evidence',
    sourceTranscriptHash: sha('d'),
    spans: [span()],
    ...overrides,
  })
}

test('T-FR-134 transcript sidecar binds exact canonical spans and lineage', () => {
  const value = evidence()
  assert.equal(value.spanCount, 1)
  assert.equal(value.wordCount, 4)
  assert.deepEqual(value.rangeMs, [10_000, 40_000])
  assert.match(value.evidenceHash, /^[a-f0-9]{64}$/)
})

test('T-FR-134 transcript sidecar rejects tampered text, span hash and lineage', () => {
  assert.throws(
    () => evidence({
      spans: [{ ...span(), text: 'Texto adulterado.' }],
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => evidence({
      spans: [{ ...span(), spanHash: sha('9') }],
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => evidence({ sourceTranscriptHash: sha('z') }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})
