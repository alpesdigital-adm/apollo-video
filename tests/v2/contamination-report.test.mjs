import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createContaminationReport,
  hydrateContaminationReport,
} from '../../src/v2/domain/contamination-report.ts'
import {
  createSourceDeconstructionReport,
} from '../../src/v2/domain/source-deconstruction.ts'

const sha = (character) => character.repeat(64)

function sourceDeconstruction() {
  const evidence = [
    {
      id: 'speech-opening',
      sourceSegmentId: 0,
      exactText: 'Antes de comecar, deixa eu me apresentar.',
      normalizedText: 'antes de comecar deixa eu me apresentar',
      rangeMs: [0, 900],
      completeThoughtScore: 0.99,
      classification: 'complete-thought',
      intentions: [{
        value: 'abertura',
        confidence: 0.99,
        provenance: 'fixture/v1',
      }],
      segmentHash: sha('1'),
    },
    {
      id: 'speech-hook',
      sourceSegmentId: 1,
      exactText: 'Se o anuncio nao prende atencao.',
      normalizedText: 'se o anuncio nao prende atencao',
      rangeMs: [900, 2_300],
      completeThoughtScore: 0.99,
      classification: 'complete-thought',
      intentions: [{
        value: 'hook',
        confidence: 0.99,
        provenance: 'fixture/v1',
      }],
      segmentHash: sha('2'),
    },
    {
      id: 'speech-body',
      sourceSegmentId: 2,
      exactText: 'Tres formas de estruturar a mensagem.',
      normalizedText: 'tres formas de estruturar a mensagem',
      rangeMs: [2_300, 4_000],
      completeThoughtScore: 0.99,
      classification: 'complete-thought',
      intentions: [{
        value: 'corpo',
        confidence: 0.99,
        provenance: 'fixture/v1',
      }],
      segmentHash: sha('3'),
    },
    {
      id: 'speech-cta',
      sourceSegmentId: 3,
      exactText: 'Clique no link e entre para a aula.',
      normalizedText: 'clique no link e entre para a aula',
      rangeMs: [4_000, 5_100],
      completeThoughtScore: 0.99,
      classification: 'complete-thought',
      intentions: [{
        value: 'cta',
        confidence: 0.99,
        provenance: 'fixture/v1',
      }],
      segmentHash: sha('4'),
    },
    {
      id: 'speech-tail',
      sourceSegmentId: 4,
      exactText: 'Um abraco e ate a proxima.',
      normalizedText: 'um abraco e ate a proxima',
      rangeMs: [5_100, 6_200],
      completeThoughtScore: 0.99,
      classification: 'complete-thought',
      intentions: [{
        value: 'cauda',
        confidence: 0.99,
        provenance: 'fixture/v1',
      }],
      segmentHash: sha('5'),
    },
  ]
  return createSourceDeconstructionReport({
    id: 'source-deconstruction-contamination-golden',
    workspaceId: 'workspace-contamination',
    projectId: 'project-contamination',
    sourceArtifactId: 'artifact-contamination',
    sourceArtifactSha256: sha('a'),
    sourceTranscriptId: 'transcript-contamination',
    sourceTranscriptHash: sha('b'),
    sourceDurationMs: 6_200,
    desiredRole: 'complete',
    validationScope: 'full',
    targetComposition: {
      objective: 'content-distribution',
      outputSpecId: '9:16',
      targetDurationMs: 30_000,
    },
    boundaryPolicy: {
      preRollMs: 0,
      postRollMs: 0,
      maxJoinGapMs: 0,
      maxContextGapMs: 500,
      minCompleteThoughtScore: 0.7,
    },
    speechEvidence: evidence,
    createdByClientId: 'client-contamination',
    createdAt: '2026-07-28T20:00:00.000Z',
  })
}

const detector = {
  provider: 'apollo',
  model: 'contamination-golden',
  version: '1.0.0',
}

const policy = {
  minObservationConfidence: 0.5,
  minAutomaticConfidence: 0.85,
  protectedIntersectionReviewRatio: 0.1,
  protectedIntersectionDestructiveRatio: 0.35,
  lowConfidenceRequiresReview: true,
}

function observations() {
  return [
    {
      id: 'observation-burned-caption',
      kind: 'burned-caption',
      rangeMs: [900, 2_300],
      region: { x: 0.1, y: 0.8, width: 0.8, height: 0.12 },
      confidence: 0.98,
      detector,
      signals: {
        text: 'Se o anuncio nao prende atencao',
        textTrackMatch: 0.99,
        frameCoverage: 0.96,
        foregroundContrast: 0.92,
      },
    },
    {
      id: 'observation-logo-watermark',
      kind: 'logo-watermark',
      rangeMs: [0, 6_200],
      region: { x: 0.79, y: 0.03, width: 0.18, height: 0.08 },
      confidence: 0.95,
      detector,
      signals: {
        label: 'APOLLO',
        logoMatch: 0.98,
        frameCoverage: 1,
        opacity: 0.7,
      },
    },
    {
      id: 'observation-music',
      kind: 'music',
      rangeMs: [900, 4_000],
      region: null,
      confidence: 0.96,
      detector,
      signals: {
        musicLikelihood: 0.98,
        speechLikelihood: 0.91,
        separableStem: false,
        spectralPersistence: 0.94,
      },
    },
    {
      id: 'observation-border',
      kind: 'border',
      rangeMs: [0, 6_200],
      region: { x: 0, y: 0, width: 1, height: 0.07 },
      confidence: 0.97,
      detector,
      signals: {
        edges: ['top'],
        uniformity: 0.99,
        thicknessRatio: 0.07,
        frameCoverage: 1,
      },
    },
    {
      id: 'observation-overlay',
      kind: 'overlay',
      rangeMs: [2_300, 4_000],
      region: { x: 0.28, y: 0.2, width: 0.44, height: 0.5 },
      confidence: 0.93,
      detector,
      signals: {
        overlayClass: 'promo-card',
        frameCoverage: 0.88,
        opacity: 0.72,
        occludesSubject: true,
      },
    },
  ]
}

function createReport(overrides = {}) {
  const source = sourceDeconstruction()
  return createContaminationReport({
    id: 'contamination-report-golden',
    sourceDeconstruction: source,
    expectedSourceDeconstructionReportHash: source.reportHash,
    analyzer: detector,
    policy,
    observations: observations(),
    protectedRegions: [{
      id: 'protected-speaker-face',
      kind: 'face',
      rangeMs: [900, 5_100],
      region: { x: 0.3, y: 0.18, width: 0.4, height: 0.5 },
      confidence: 0.99,
      source: 'face-detector/v1',
    }],
    createdByClientId: 'client-contamination',
    createdAt: '2026-07-28T20:05:00.000Z',
    ...overrides,
  })
}

test('T-FR-121 detects all five contamination kinds with exact temporal and spatial evidence', () => {
  const report = createReport()

  assert.deepEqual(
    Object.entries(report.summary.countsByKind),
    [
      ['burned-caption', 1],
      ['logo-watermark', 1],
      ['music', 1],
      ['border', 1],
      ['overlay', 1],
    ],
  )
  assert.equal(report.findings.length, 5)
  assert.equal(report.observations.length, 5)
  for (const finding of report.findings) {
    assert.ok(finding.rangeMs[1] > finding.rangeMs[0])
    assert.ok(finding.confidence >= 0.9)
    assert.match(finding.observationHash, /^[a-f0-9]{64}$/)
    assert.match(finding.findingHash, /^[a-f0-9]{64}$/)
    if (finding.kind === 'music') {
      assert.equal(finding.region, null)
    } else {
      assert.ok(finding.region.width > 0)
      assert.ok(finding.region.height > 0)
    }
  }
})

test('T-FR-121 marks removal that destroys essential speech or protected subject pixels', () => {
  const report = createReport()
  const music = report.findings.find((item) =>
    item.kind === 'music')
  const overlay = report.findings.find((item) =>
    item.kind === 'overlay')
  const caption = report.findings.find((item) =>
    item.kind === 'burned-caption')

  assert.equal(music.removalWouldDestroyEssential, true)
  assert.ok(music.reasonCodes.includes(
    'mixed-with-essential-speech',
  ))
  assert.equal(overlay.removalWouldDestroyEssential, true)
  assert.ok(overlay.protectedRegionIntersectionRatio > 0.9)
  assert.equal(caption.removalImpact, 'safe')
  assert.equal(caption.overlapsEssentialTime, true)
})

test('T-FR-121 exposes separate Director and human-review diagnostics with overlap targets', () => {
  const report = createReport()

  assert.equal(report.decision, 'manual-preservation-required')
  assert.equal(report.humanReviewRequired, true)
  assert.equal(report.diagnostics.director.length, 5)
  assert.equal(report.diagnostics.humanReview.length, 5)
  assert.ok(report.diagnostics.director.some((item) =>
    item.severity === 'blocking' &&
    item.removalDecision === 'blocked'))
  assert.ok(report.diagnostics.humanReview.every((item) =>
    item.compareSource === true))
  assert.ok(report.overlaps.length > 0)
  assert.ok(report.overlaps.some((item) =>
    item.intersectionRegion !== null))
  assert.ok(report.diagnostics.director.some((item) =>
    item.message ===
      'Música mixada não pode ser removida sem afetar conteúdo essencial.'))
  assert.ok(report.diagnostics.humanReview.some((item) =>
    item.question ===
      'A remoção da música mixada destruiria conteúdo essencial; manter a fonte ou rejeitar o trecho?'))
  assert.ok(report.diagnostics.humanReview.every((item) =>
    !/\b(burned-caption|logo-watermark|music|border)\b/.test(
      item.question,
    )))
})

test('T-FR-121 clean observation set is explicitly cleanup eligible', () => {
  const source = sourceDeconstruction()
  const report = createReport({
    observations: [],
    protectedRegions: [],
    expectedSourceDeconstructionReportHash: source.reportHash,
    sourceDeconstruction: source,
  })

  assert.equal(report.decision, 'cleanup-eligible')
  assert.equal(report.humanReviewRequired, false)
  assert.equal(report.confidence, 1)
  assert.equal(report.summary.findingCount, 0)
})

test('T-FR-121 hydration is canonical and rejects projection tampering', () => {
  const report = createReport()
  const source = sourceDeconstruction()

  assert.deepEqual(
    hydrateContaminationReport(report, source),
    report,
  )
  assert.throws(
    () => hydrateContaminationReport({
      ...report,
      summary: {
        ...report.summary,
        destructiveCount: report.summary.destructiveCount + 1,
      },
    }, source),
    /inconsistent/,
  )
})
