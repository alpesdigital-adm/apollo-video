import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSourceDeconstructionReport,
  hydrateSourceDeconstructionReport,
} from '../../src/v2/domain/source-deconstruction.ts'

const sha = (character) => character.repeat(64)

function speechEvidence() {
  return [
    {
      id: 'speech-opening',
      sourceSegmentId: 0,
      exactText: 'Pare de rolar.',
      normalizedText: 'pare de rolar',
      rangeMs: [0, 1_000],
      completeThoughtScore: 0.98,
      classification: 'complete-thought',
      intentions: [{
        value: 'abertura',
        confidence: 0.99,
        provenance: 'director@semantic-v1',
      }],
      segmentHash: sha('1'),
    },
    {
      id: 'speech-hook',
      sourceSegmentId: 1,
      exactText: 'Se você anuncia, precisa evitar este erro.',
      normalizedText: 'se voce anuncia precisa evitar este erro',
      rangeMs: [1_000, 2_500],
      completeThoughtScore: 0.97,
      classification: 'complete-thought',
      intentions: [{
        value: 'hook',
        confidence: 0.99,
        provenance: 'director@semantic-v1',
      }],
      segmentHash: sha('2'),
    },
    {
      id: 'speech-body',
      sourceSegmentId: 2,
      exactText: 'O problema começa quando você otimiza cedo demais.',
      normalizedText:
        'o problema comeca quando voce otimiza cedo demais',
      rangeMs: [2_500, 4_000],
      completeThoughtScore: 0.96,
      classification: 'complete-thought',
      intentions: [{
        value: 'corpo',
        confidence: 0.98,
        provenance: 'director@semantic-v1',
      }],
      segmentHash: sha('3'),
    },
    {
      id: 'speech-cta',
      sourceSegmentId: 3,
      exactText: 'Clique no link e baixe o material.',
      normalizedText: 'clique no link e baixe o material',
      rangeMs: [4_000, 5_000],
      completeThoughtScore: 0.99,
      classification: 'complete-thought',
      intentions: [{
        value: 'cta',
        confidence: 0.99,
        provenance: 'director@semantic-v1',
      }],
      segmentHash: sha('4'),
    },
    {
      id: 'speech-tail',
      sourceSegmentId: 4,
      exactText: 'É isso, até a próxima.',
      normalizedText: 'e isso ate a proxima',
      rangeMs: [5_000, 6_000],
      completeThoughtScore: 0.97,
      classification: 'complete-thought',
      intentions: [{
        value: 'cauda',
        confidence: 0.99,
        provenance: 'director@semantic-v1',
      }],
      segmentHash: sha('5'),
    },
  ]
}

function createReport(overrides = {}) {
  return createSourceDeconstructionReport({
    id: 'source-deconstruction-report-golden',
    workspaceId: 'workspace-golden',
    projectId: 'project-golden',
    sourceArtifactId: 'artifact-golden-reel',
    sourceArtifactSha256: sha('a'),
    sourceTranscriptId: 'transcript-golden-reel',
    sourceTranscriptHash: sha('b'),
    sourceDurationMs: 6_500,
    desiredRole: 'hook',
    validationScope: 'opening-edit',
    targetComposition: {
      objective: 'content-distribution',
      outputSpecId: '9:16',
      targetDurationMs: 15_000,
    },
    boundaryPolicy: {
      preRollMs: 100,
      postRollMs: 100,
      maxJoinGapMs: 250,
      maxContextGapMs: 500,
      minCompleteThoughtScore: 0.7,
    },
    speechEvidence: speechEvidence(),
    createdByClientId: 'client-golden',
    createdAt: '2026-07-28T16:00:00.000Z',
    ...overrides,
  })
}

test('T-FR-120 isolates a validated hook envelope and removable published material', () => {
  const report = createReport()

  assert.deepEqual(report.hookEnvelope?.rangeMs, [0, 2_500])
  assert.deepEqual(
    report.cleanCandidateRanges.map((candidate) =>
      candidate.rangeMs),
    [[0, 2_600]],
  )
  assert.deepEqual(
    report.cleanCandidateRanges[0].sourceSpeechSegmentIds,
    ['speech-opening', 'speech-hook'],
  )
  assert.equal(
    report.comparison.cleanTranscript,
    'Pare de rolar. Se você anuncia, precisa evitar este erro.',
  )
  assert.equal(report.comparison.sourceSegmentCount, 5)
  assert.equal(report.comparison.includedSegmentCount, 2)
  assert.equal(report.comparison.excludedSegmentCount, 3)
  assert.equal(report.comparison.cleanDurationMs, 2_600)
  assert.equal(report.comparison.removedDurationMs, 3_900)
  assert.deepEqual(report.comparison.removedRangesMs, [
    [2_600, 6_500],
  ])
  assert.deepEqual(
    report.semanticContaminants.map((item) => item.kind),
    ['non-target-body', 'prior-cta', 'removable-tail'],
  )
  assert.equal(report.contextPreserved, true)
  assert.equal(report.decision, 'automatic')
  assert.ok(report.confidence > 0.9)
  assert.ok(report.editabilityScore >= 90)
  assert.match(report.reportHash, /^[a-f0-9]{64}$/)
})

test('T-FR-120 keeps body context until a complete thought boundary', () => {
  const evidence = speechEvidence()
  evidence[2] = {
    ...evidence[2],
    exactText: 'O problema começa porque',
    normalizedText: 'o problema comeca porque',
    completeThoughtScore: 0.35,
    classification: 'incomplete',
  }
  evidence[3] = {
    ...evidence[3],
    exactText: 'você otimiza cedo demais.',
    normalizedText: 'voce otimiza cedo demais',
    intentions: [{
      value: 'contexto',
      confidence: 0.96,
      provenance: 'director@semantic-v1',
    }],
  }
  const report = createReport({
    desiredRole: 'body',
    validationScope: 'copy',
    speechEvidence: evidence,
  })

  assert.equal(report.contextPreserved, true)
  assert.equal(report.cleanCandidateRanges.length, 1)
  assert.deepEqual(
    report.cleanCandidateRanges[0].sourceSpeechSegmentIds,
    ['speech-body', 'speech-cta'],
  )
  assert.equal(
    report.segments.find((segment) =>
      segment.sourceSpeechSegmentId === 'speech-cta')
      .includedForContext,
    false,
  )
  assert.equal(
    report.cleanCandidateRanges[0].boundaryReasonCodes
      .includes('complete-thought-end'),
    true,
  )
})

test('T-FR-120 complete composition preserves hook, body and CTA but removes the tail', () => {
  const report = createReport({
    desiredRole: 'complete',
    validationScope: 'full',
  })

  assert.equal(report.comparison.includedSegmentCount, 4)
  assert.equal(report.comparison.excludedSegmentCount, 1)
  assert.deepEqual(report.bodyRanges, [[2_500, 4_000]])
  assert.deepEqual(report.ctaRanges, [[4_000, 5_000]])
  assert.deepEqual(
    report.semanticContaminants.map((item) => item.kind),
    ['removable-tail'],
  )
})

test('T-FR-120 complete composition removes a published wrapper but keeps a real pattern interruption', () => {
  const wrapperEvidence = speechEvidence()
  wrapperEvidence[0] = {
    ...wrapperEvidence[0],
    exactText: 'Antes de começar, deixa eu me apresentar.',
    normalizedText: 'antes de comecar deixa eu me apresentar',
    segmentHash: sha('6'),
  }
  const cleaned = createReport({
    desiredRole: 'complete',
    validationScope: 'full',
    speechEvidence: wrapperEvidence,
  })
  const retained = createReport({
    desiredRole: 'complete',
    validationScope: 'full',
  })

  assert.equal(cleaned.segments[0].role, 'opening')
  assert.equal(cleaned.segments[0].included, false)
  assert.equal(cleaned.comparison.includedSegmentCount, 3)
  assert.deepEqual(
    cleaned.semanticContaminants.map((item) => item.kind),
    ['prior-opening', 'removable-tail'],
  )
  assert.equal(retained.segments[0].included, true)
})

test('T-FR-120 report hydration is canonical and rejects stored projection tampering', () => {
  const report = createReport()
  assert.deepEqual(hydrateSourceDeconstructionReport(report), report)
  assert.throws(
    () => hydrateSourceDeconstructionReport({
      ...report,
      comparison: {
        ...report.comparison,
        cleanDurationMs: report.comparison.cleanDurationMs + 1,
      },
    }),
    /inconsistent/,
  )
})
