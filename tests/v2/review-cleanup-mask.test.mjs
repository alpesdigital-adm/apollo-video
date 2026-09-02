import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'

import {
  assertReviewCleanupMask,
  assertReviewCleanupMaskExecutable,
  calculateReviewAnnotationHash,
  createReviewCleanupMask,
  projectReviewCleanupMaskProviderInput,
  refineReviewCleanupMask,
} from '../../src/v2/domain/review-cleanup-mask.ts'
import { createTransformationBrief } from '../../src/v2/domain/transformation-brief.ts'

const HASH = (value) => value.repeat(64)

function brief(overrides = {}) {
  return createTransformationBrief({
    workspaceId: 'workspace-review-mask',
    projectId: 'project-review-mask',
    projectVersionId: 'project-version-review-mask',
    storyPlanId: 'story-plan-review-mask',
    storyPlanHash: HASH('1'),
    sourceArtifactId: 'artifact-source-review-mask',
    sourceArtifactHash: HASH('2'),
    sourceRange: { startFrame: 30, endFrame: 150 },
    intent: 'world-shift',
    editorialIntent: 'Remover a legenda queimada preservando a pessoa.',
    mode: 'object-environment-change',
    prompt: 'Reconstruir somente o fundo sob a legenda queimada.',
    negativeConstraints: ['não alterar a pessoa'],
    preserve: ['identity', 'speech'],
    allowedChanges: ['burned-in-subtitle', 'background-pixels-under-mask'],
    target: { cleanup: 'inpaint' },
    outputSpecIds: ['output-spec-vertical'],
    intensityBps: 1_500,
    noveltyBps: 500,
    safety: ['no-face-change'],
    safeZones: [{ x: 0.3, y: 0.05, width: 0.4, height: 0.55, purpose: 'subject' }],
    fallbackLadder: ['source-unchanged'],
    rightsSnapshotId: 'rights-review-mask',
    rightsSnapshotHash: HASH('3'),
    identitySnapshotId: 'identity-review-mask',
    identitySnapshotHash: HASH('4'),
    createdAt: '2026-09-01T20:00:00.000Z',
    ...overrides,
  })
}

function annotation(overrides = {}) {
  return {
    id: '5e87ff95-9de3-4aef-9166-eae8739ed25b',
    projectVersionId: 'project-version-review-mask',
    proxyArtifactId: 'artifact-proxy-review-mask',
    proxyHash: HASH('5'),
    frame: 60,
    timeRangeMs: [2_000, 3_000],
    screenshotRef: 'data:image/png;base64,AA==',
    scope: 'region',
    region: { x: 0.12, y: 0.78, width: 0.76, height: 0.12 },
    targetIds: [],
    applicationScope: {
      kind: 'region', targetIds: ['clip-review-mask'], formatIds: ['output-spec-vertical'],
      localeIds: ['pt-BR'], recipeIds: [], global: false,
    },
    affectedCount: 1,
    text: 'Remover a legenda queimada.',
    author: { id: 'api-client-review-mask', name: 'Reviewer', type: 'api-client' },
    status: 'open',
    createdAt: '2026-09-01T20:01:00.000Z',
    ...overrides,
  }
}

function mask(overrides = {}) {
  const sourceBrief = brief()
  return createReviewCleanupMask({
    id: 'review-mask-snapshot-one',
    rootId: 'review-mask-root-one',
    workspaceId: sourceBrief.workspaceId,
    projectId: sourceBrief.projectId,
    annotation: annotation(),
    brief: sourceBrief,
    sourceArtifactId: sourceBrief.sourceArtifactId,
    sourceArtifactHash: sourceBrief.sourceArtifactHash,
    format: { outputSpecId: 'output-spec-vertical', width: 540, height: 960 },
    fps: 30,
    trackingConfidenceBps: 9_000,
    createdByClientId: 'api-client-review-mask',
    createdAt: '2026-09-01T20:02:00.000Z',
    ...overrides,
  })
}

test('T-FR-218 creates a content-addressed normalized mask from a regional annotation', () => {
  const sourceAnnotation = annotation()
  const result = mask({ annotation: sourceAnnotation })
  assert.equal(result.range.startFrame, 60)
  assert.equal(result.range.endFrame, 90)
  assert.deepEqual(result.region, sourceAnnotation.region)
  assert.equal(result.annotationHash, calculateReviewAnnotationHash(sourceAnnotation))
  assert.equal(result.revision, 1)
  assert.equal(result.sourceArtifactHash, HASH('2'))
  assert.equal(result.keyframes[0].frame, 60)
  assert.equal(assertReviewCleanupMask(result), result)
})

test('T-FR-218 rejects masks that overlap protected preserve regions', () => {
  assert.throws(
    () => mask({ annotation: annotation({ region: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 } }) }),
    /protected preserve region/,
  )
})

test('T-FR-218 refinement is append-only and supports deterministic tracking keyframes', () => {
  const prior = mask()
  const refined = refineReviewCleanupMask({
    prior,
    id: 'review-mask-snapshot-two',
    region: { x: 0.1, y: 0.76, width: 0.78, height: 0.14 },
    range: { startFrame: 60, endFrame: 90 },
    keyframes: [
      { frame: 60, region: { x: 0.1, y: 0.76, width: 0.78, height: 0.14 } },
      { frame: 75, region: { x: 0.11, y: 0.77, width: 0.77, height: 0.13 } },
    ],
    trackingStatus: 'tracked',
    trackingConfidenceBps: 8_700,
    createdByClientId: 'api-client-review-mask',
    createdAt: '2026-09-01T20:03:00.000Z',
  })
  assert.equal(refined.revision, 2)
  assert.equal(refined.supersedesId, prior.id)
  assert.equal(refined.rootId, prior.rootId)
  assert.equal(refined.keyframes.length, 2)
  assert.notEqual(refined.maskHash, prior.maskHash)
  assert.equal(prior.revision, 1)
})

test('T-FR-218 format change requires acknowledgement and remains uncertain', () => {
  const prior = mask()
  const common = {
    prior,
    id: 'review-mask-format-two',
    region: prior.region,
    range: prior.range,
    keyframes: prior.keyframes,
    trackingConfidenceBps: 6_000,
    format: { outputSpecId: 'output-spec-square', width: 1080, height: 1080 },
    createdByClientId: 'api-client-review-mask',
    createdAt: '2026-09-01T20:04:00.000Z',
  }
  assert.throws(
    () => refineReviewCleanupMask({ ...common, trackingStatus: 'uncertain' }),
    /reprojection acknowledgement/,
  )
  assert.throws(
    () => refineReviewCleanupMask({ ...common, trackingStatus: 'tracked', acknowledgeFormatChange: true }),
    /remains uncertain/,
  )
  const reprojected = refineReviewCleanupMask({
    ...common,
    trackingStatus: 'uncertain',
    acknowledgeFormatChange: true,
  })
  assert.equal(reprojected.formatChange.acknowledged, true)
  assert.throws(
    () => assertReviewCleanupMaskExecutable({
      mask: reprojected,
      brief: brief(),
      outputSpecId: 'output-spec-square',
    }),
    /requires review/,
  )
})

test('T-FR-218 provider projection excludes screenshot, annotation copy and author', () => {
  const result = mask()
  const projected = projectReviewCleanupMaskProviderInput(result)
  const serialized = JSON.stringify(projected)
  assert.equal(projected.maskHash, result.maskHash)
  assert.doesNotMatch(serialized, /screenshot|Reviewer|legenda queimada/)
  assert.deepEqual(Object.keys(projected), [
    'schemaVersion', 'maskId', 'maskHash', 'format', 'range', 'region',
    'keyframes', 'preserveRegions', 'tracking',
  ])
})

test('T-FR-218 executable gate binds exact brief, source, output and tracking confidence', () => {
  const result = mask()
  assert.equal(assertReviewCleanupMaskExecutable({
    mask: result,
    brief: brief(),
    outputSpecId: 'output-spec-vertical',
  }), result)
  assert.throws(
    () => assertReviewCleanupMaskExecutable({
      mask: result,
      brief: brief(),
      outputSpecId: 'output-spec-horizontal',
    }),
    /requested output format/,
  )
  assert.throws(
    () => assertReviewCleanupMaskExecutable({
      mask: result,
      brief: brief(),
      outputSpecId: 'output-spec-vertical',
      minimumTrackingConfidenceBps: 9_500,
    }),
    /requires review/,
  )
})

test('T-FR-218 stored mask tampering fails closed', () => {
  const result = mask()
  assert.throws(
    () => assertReviewCleanupMask({ ...result, region: { ...result.region, x: 0.13 } }),
    /hash is invalid/,
  )
  const { maskHash: _maskHash, ...body } = result
  const invalidBody = { ...body, region: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } }
  assert.throws(
    () => assertReviewCleanupMask({ ...invalidBody, maskHash: calculateCanonicalHash(invalidBody) }),
    /invariants are invalid/,
  )
})
