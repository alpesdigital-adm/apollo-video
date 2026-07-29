import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  createPostCleanupReview,
  createSourceCleanupPlan,
  defaultSourceCleanupPolicy,
  hydratePostCleanupReview,
  hydrateSourceCleanupPlan,
} from '../../src/v2/domain/source-cleanup.ts'

const sha = (value) => calculateCanonicalHash({ value })

function reportWithFinding(overrides = {}, protectedRegions = []) {
  const finding = {
    id: 'finding-cleanup-1',
    observationId: 'observation-cleanup-1',
    kind: 'overlay',
    rangeMs: [2_000, 4_000],
    region: { x: 0.4, y: 0.4, width: 0.08, height: 0.08 },
    confidence: 0.96,
    detector: { provider: 'fixture', model: 'cleanup', version: '1' },
    signals: { overlayClass: 'sticker', frameCoverage: 0.2, opacity: 1, occludesSubject: false },
    overlapsEssentialTime: false,
    essentialOverlapRatio: 0,
    protectedRegionIds: [],
    protectedRegionIntersectionRatio: 0,
    removalImpact: 'safe',
    removalWouldDestroyEssential: false,
    requiresHumanReview: false,
    reasonCodes: [],
    observationHash: sha('observation'),
    findingHash: sha('finding'),
    ...overrides,
  }
  return Object.freeze({
    schemaVersion: 'contamination-report/v1',
    id: 'contamination-report-cleanup-1',
    workspaceId: 'workspace-cleanup',
    projectId: 'project-cleanup',
    sourceDeconstructionReportId: 'deconstruction-cleanup',
    sourceDeconstructionReportHash: sha('deconstruction'),
    sourceArtifactId: 'artifact-source-cleanup',
    sourceArtifactSha256: sha('source'),
    sourceDurationMs: 10_000,
    analyzer: { provider: 'fixture', model: 'cleanup', version: '1', observationBatchHash: sha('batch') },
    policy: {
      version: 'source-contamination/v1',
      minObservationConfidence: 0.5,
      minAutomaticConfidence: 0.8,
      protectedIntersectionReviewRatio: 0.05,
      protectedIntersectionDestructiveRatio: 0.25,
      lowConfidenceRequiresReview: true,
    },
    observations: [],
    protectedRegions,
    findings: [finding],
    overlaps: [],
    summary: {
      findingCount: 1,
      observationCount: 1,
      protectedRegionCount: protectedRegions.length,
      overlapCount: 0,
      countsByKind: { 'burned-caption': 0, 'logo-watermark': 0, music: 0, border: 0, overlay: 1 },
      safeCount: finding.removalImpact === 'safe' ? 1 : 0,
      reviewCount: finding.removalImpact === 'review-required' ? 1 : 0,
      destructiveCount: finding.removalImpact === 'destructive' ? 1 : 0,
    },
    diagnostics: { director: [], humanReview: [] },
    decision: finding.removalImpact === 'safe' ? 'cleanup-eligible' : 'manual-preservation-required',
    humanReviewRequired: finding.requiresHumanReview,
    confidence: finding.confidence,
    createdByClientId: 'client-cleanup',
    createdAt: '2026-07-28T20:00:00.000Z',
    reportHash: sha(`report-${finding.kind}-${finding.rangeMs.join('-')}-${JSON.stringify(finding.region)}`),
  })
}

const allowedRights = Object.freeze({
  outcome: 'allow',
  reasonCodes: [],
  rightsSnapshotId: 'rights-source-cleanup',
  rightsSnapshotHash: sha('rights-source'),
})

function plan(report, patch = {}) {
  return createSourceCleanupPlan({
    id: 'cleanup-plan-1',
    report,
    expectedReportHash: report.reportHash,
    findingId: report.findings[0].id,
    sourceManifestId: 'manifest-source-cleanup-test',
    policy: defaultSourceCleanupPolicy(),
    rights: allowedRights,
    createdByClientId: 'client-cleanup',
    createdAt: '2026-07-28T21:00:00.000Z',
    ...patch,
  })
}

test('T-FR-122 selects semantic trim only at a safe timeline edge', () => {
  const report = reportWithFinding({
    kind: 'burned-caption',
    rangeMs: [0, 1_000],
    region: { x: 0.1, y: 0.82, width: 0.8, height: 0.12 },
  })
  const cleanup = plan(report)
  assert.equal(cleanup.selectedStrategy, 'trim')
  assert.deepEqual(cleanup.selectedAction.keepRangeMs, [1_000, 10_000])
  assert.equal(cleanup.sourceImmutable, true)
  assert.equal(cleanup.postCleanupReviewRequired, true)
  assert.match(cleanup.operationId, /^operation-cleanup-/)
})

test('T-FR-122 selects crop/reframe only when the edge crop preserves protected regions', () => {
  const report = reportWithFinding({
    kind: 'border',
    rangeMs: [500, 9_500],
    region: { x: 0, y: 0, width: 1, height: 0.15 },
    signals: { edges: ['top'], uniformity: 1, thicknessRatio: 0.15, frameCoverage: 0.9 },
  }, [{
    id: 'protected-subject',
    kind: 'speaker',
    rangeMs: [0, 10_000],
    region: { x: 0.2, y: 0.25, width: 0.6, height: 0.6 },
    confidence: 0.98,
    source: 'fixture',
    regionHash: sha('protected'),
  }])
  const cleanup = plan(report)
  assert.equal(cleanup.selectedStrategy, 'crop-reframe')
  assert.deepEqual(cleanup.selectedAction.crop, { x: 0, y: 0.15, width: 1, height: 0.85 })
  assert.ok(cleanup.predictedResidualQuality >= 0.8)
})

test('T-FR-122 selects bounded cover for a small internal visual contaminant', () => {
  const report = reportWithFinding()
  const cleanup = plan(report)
  assert.equal(cleanup.selectedStrategy, 'cover')
  assert.deepEqual(cleanup.selectedAction.rangeMs, [2_000, 4_000])
  assert.equal(cleanup.selectedAction.color, '#111111')
})

test('T-FR-122 rejects mixed music and destructive visual removal inside the MVP', () => {
  const music = reportWithFinding({
    kind: 'music',
    region: null,
    signals: { musicLikelihood: 0.99, speechLikelihood: 0.8, separableStem: false, spectralPersistence: 0.9 },
  })
  const destructive = reportWithFinding({
    removalImpact: 'destructive',
    removalWouldDestroyEssential: true,
    overlapsEssentialTime: true,
    essentialOverlapRatio: 0.8,
    protectedRegionIntersectionRatio: 0.7,
  })
  assert.equal(plan(music).selectedStrategy, 'reject')
  assert.equal(plan(destructive).selectedStrategy, 'reject')
  assert.equal(plan(music).postCleanupReviewRequired, false)
})

test('T-FR-122 fails closed when source rights do not allow editing', () => {
  const cleanup = plan(reportWithFinding(), {
    rights: {
      outcome: 'deny',
      reasonCodes: ['RIGHTS_USE_NOT_ALLOWED'],
      rightsSnapshotId: 'rights-source-cleanup',
      rightsSnapshotHash: sha('rights-source'),
    },
  })
  assert.equal(cleanup.selectedStrategy, 'reject')
  assert.ok(cleanup.selectedAction.reasonCodes.includes('RIGHTS_REEVALUATION_DENIED'))
  assert.equal(cleanup.operationId, undefined)
})

test('T-FR-122 requires visual and rights reevaluation before accepting a derivative', () => {
  const report = reportWithFinding()
  const cleanup = plan(report)
  const review = createPostCleanupReview({
    plan: cleanup,
    outputArtifactId: cleanup.outputArtifactId,
    outputArtifactSha256: sha('cleaned-output'),
    outputManifestId: cleanup.outputManifestId,
    outputRightsSnapshotId: 'rights-cleaned-output',
    outputRightsSnapshotHash: sha('rights-output'),
    visual: {
      passed: true,
      contaminationRemoved: true,
      outputPlayable: true,
      durationAligned: true,
      framingPreserved: true,
      residualQuality: 0.97,
      reasonCodes: [],
    },
    reviewedAt: '2026-07-28T21:01:00.000Z',
  })
  assert.equal(review.passed, true)
  assert.equal(review.rights.passed, true)
  assert.equal(hydrateSourceCleanupPlan(cleanup, report).planHash, cleanup.planHash)
  assert.equal(hydratePostCleanupReview(review, cleanup).reviewHash, review.reviewHash)
})
