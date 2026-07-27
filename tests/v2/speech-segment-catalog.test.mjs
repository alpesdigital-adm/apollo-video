import assert from 'node:assert/strict'
import test from 'node:test'

import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import {
  catalogSpeechSegments,
  normalizeSpeechText,
} from '../../src/v2/domain/speech-segment-catalog.ts'

const createdAt = '2026-07-27T12:00:00.000Z'

function fixtureTranscript() {
  return createMediaTranscript({
    language: 'pt-BR',
    text: [
      'Uma reflexão completa.',
      'Mas porque',
      'Eu estava explicando...',
      'Outra pessoa conclui a ideia!',
    ].join(' '),
    provider: 'fixture',
    model: 'aligned-transcript-v1',
    words: [
      { word: 'Uma', start: 0, end: 0.2 },
      { word: 'reflexão', start: 0.21, end: 0.5 },
      { word: 'completa.', start: 0.51, end: 0.9 },
      { word: 'Mas', start: 1, end: 1.2 },
      { word: 'porque', start: 1.21, end: 1.5 },
      { word: 'Eu', start: 2, end: 2.1 },
      { word: 'estava', start: 2.11, end: 2.3 },
      { word: 'explicando...', start: 2.31, end: 2.8 },
      { word: 'Outra', start: 3, end: 3.2 },
      { word: 'pessoa', start: 3.21, end: 3.5 },
      { word: 'conclui', start: 3.51, end: 3.8 },
      { word: 'a', start: 3.81, end: 3.9 },
      { word: 'ideia!', start: 3.91, end: 4.3 },
    ],
    segments: [
      {
        id: 10,
        start: 0,
        end: 0.9,
        text: 'Uma reflexão completa.',
        confidence: 0.98,
      },
      {
        id: 20,
        start: 1,
        end: 1.5,
        text: 'Mas porque',
        confidence: 0.84,
      },
      {
        id: 30,
        start: 2,
        end: 2.8,
        text: 'Eu estava explicando...',
        confidence: 0.91,
      },
      {
        id: 40,
        start: 3,
        end: 4.3,
        text: 'Outra pessoa conclui a ideia!',
        confidence: 0.96,
      },
    ],
  })
}

function catalog() {
  const transcript = fixtureTranscript()
  return catalogSpeechSegments({
    workspaceId: 'workspace-speech-fixture',
    projectId: 'project-speech-fixture',
    catalogRunId: 'speech-catalog-run-fixture',
    sourceTranscriptId: 'transcript-speech-fixture',
    sourceArtifactId: 'artifact-speech-fixture',
    transcript,
    producer: {
      provider: 'apollo',
      model: 'speech-catalog',
      version: '1.0.0',
      confidence: 0.9,
    },
    annotations: [
      {
        sourceSegmentId: 10,
        speaker: { value: 'person-specialist', confidence: 0.99 },
        visual: {
          emotion: { value: 'Confiante', confidence: 0.91 },
          expression: { value: 'Sorriso leve', confidence: 0.88 },
          wardrobe: { value: 'Camisa azul', confidence: 0.95 },
          setting: { value: 'Estúdio claro', confidence: 0.93 },
          colors: [
            { value: 'Azul', confidence: 0.9 },
            { value: 'Dourado', confidence: 0.82 },
          ],
        },
        intentions: [
          { value: 'Hook de autoridade', confidence: 0.94 },
        ],
      },
      {
        sourceSegmentId: 40,
        speaker: { value: 'person-guest', confidence: 0.97 },
        intentions: [
          { value: 'Conclusão', confidence: 0.9 },
        ],
      },
    ],
    createdAt,
    createSegmentId: (sourceSegmentId) =>
      `speech-segment-fixture-${sourceSegmentId}`,
  })
}

test('T-FR-043 catalogs complete, incomplete, interrupted and multi-speaker fixtures as virtual ranges', () => {
  const segments = catalog()
  assert.equal(segments.length, 4)
  assert.deepEqual(
    segments.map((segment) => segment.classification),
    ['complete-thought', 'incomplete', 'interrupted', 'complete-thought'],
  )
  assert.ok(
    segments[0].completeThoughtScore > segments[1].completeThoughtScore,
  )
  assert.ok(
    segments[0].completeThoughtScore > segments[2].completeThoughtScore,
  )
  assert.deepEqual(
    segments.map((segment) => segment.speakerId),
    [
      'person-specialist',
      'speaker-unknown',
      'speaker-unknown',
      'person-guest',
    ],
  )
  assert.deepEqual(segments[0].rangeMs, [0, 900])
  assert.equal(segments[0].physicalMaterialized, false)
  assert.equal('artifactKey' in segments[0], false)
  assert.equal('byteSize' in segments[0], false)
})

test('T-FR-043 preserves exact text, normalized text and word-level alignment', () => {
  const [segment] = catalog()
  assert.equal(segment.exactText, 'Uma reflexão completa.')
  assert.equal(segment.normalizedText, 'uma reflexao completa')
  assert.equal(segment.words.length, 3)
  assert.deepEqual(segment.words[1], {
    word: 'reflexão',
    startMs: 210,
    endMs: 500,
    confidence: 0.98,
  })
  assert.equal(normalizeSpeechText('  GESTÃO — Medieval!  '), 'gestao medieval')
})

test('T-FR-043 aligns ordered text across overlapping provider timestamps and expands the virtual range', () => {
  const transcript = createMediaTranscript({
    language: 'pt-BR',
    text: 'Comunicação do Brasil. Eu continuo.',
    provider: 'fixture',
    model: 'provider-rounded-boundaries',
    words: [
      { word: 'Comunicação', start: 0, end: 0.42 },
      { word: 'do', start: 0.42, end: 0.5 },
      { word: 'Brasil.', start: 0.5, end: 1.2 },
      { word: 'Eu', start: 1.1, end: 1.2 },
      { word: 'continuo.', start: 1.2, end: 1.8 },
    ],
    segments: [
      {
        id: 1,
        start: 0,
        end: 0.98,
        text: 'Comunicação do Brasil.',
        confidence: 0.95,
      },
      {
        id: 2,
        start: 1.1,
        end: 1.8,
        text: 'Eu continuo.',
        confidence: 0.95,
      },
    ],
  })
  const segments = catalogSpeechSegments({
    workspaceId: 'workspace-speech-boundary',
    projectId: 'project-speech-boundary',
    catalogRunId: 'speech-catalog-run-boundary',
    sourceTranscriptId: 'transcript-speech-boundary',
    sourceArtifactId: 'artifact-speech-boundary',
    transcript,
    producer: {
      provider: 'apollo',
      model: 'speech-catalog',
      version: '1.0.0',
      confidence: 0.95,
    },
    annotations: [],
    createdAt,
    createSegmentId: (sourceSegmentId) =>
      `speech-segment-boundary-${sourceSegmentId}`,
  })

  assert.deepEqual(
    segments.map((segment) => segment.words.map((word) => word.word)),
    [
      ['Comunicação', 'do', 'Brasil.'],
      ['Eu', 'continuo.'],
    ],
  )
  assert.deepEqual(segments[0].rangeMs, [0, 1200])
  assert.deepEqual(segments[1].rangeMs, [1100, 1800])
})

test('T-FR-043 attaches confidence and provenance to visual, speaker and intention observations', () => {
  const [segment] = catalog()
  assert.equal(segment.visual.emotion.value, 'Confiante')
  assert.equal(segment.visual.emotion.normalizedValue, 'confiante')
  assert.equal(segment.visual.emotion.provenance.source, 'catalog-observation')
  assert.equal(segment.visual.emotion.provenance.provider, 'apollo')
  assert.equal(segment.visual.emotion.provenance.confidence, 0.91)
  assert.equal(segment.speaker.provenance.confidence, 0.99)
  assert.equal(segment.intentions[0].value, 'Hook de autoridade')
  assert.equal(segment.intentions[0].provenance.confidence, 0.94)
  assert.match(segment.segmentHash, /^[a-f0-9]{64}$/)
})

test('T-FR-043 fails closed for unknown annotation targets and missing word alignment', () => {
  const transcript = fixtureTranscript()
  const base = {
    workspaceId: 'workspace-speech-fixture',
    projectId: 'project-speech-fixture',
    catalogRunId: 'speech-catalog-run-fixture',
    sourceTranscriptId: 'transcript-speech-fixture',
    sourceArtifactId: 'artifact-speech-fixture',
    transcript,
    producer: {
      provider: 'apollo',
      model: 'speech-catalog',
      version: '1.0.0',
      confidence: 0.9,
    },
    createdAt,
    createSegmentId: (sourceSegmentId) =>
      `speech-segment-fixture-${sourceSegmentId}`,
  }
  assert.throws(
    () => catalogSpeechSegments({
      ...base,
      annotations: [{ sourceSegmentId: 999 }],
    }),
    /unknown transcript segment/,
  )
  assert.throws(
    () => catalogSpeechSegments({
      ...base,
      transcript: {
        ...transcript,
        words: transcript.words.slice(3),
      },
      annotations: [],
    }),
    /does not match its word alignment/,
  )
  assert.throws(
    () => catalogSpeechSegments({
      ...base,
      transcript: {
        ...transcript,
        segments: transcript.segments.map((segment) =>
          segment.id === 10
            ? { ...segment, text: 'Texto divergente.' }
            : segment),
      },
      annotations: [],
    }),
    /does not match its word alignment/,
  )
})
