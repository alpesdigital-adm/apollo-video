import assert from 'node:assert/strict'
import test from 'node:test'

import {
  catalogValidatedSegment,
  evaluateValidatedSegmentReuse,
} from '../../src/v2/domain/validated-segment.ts'

const createdAt = '2026-07-27T16:00:00.000Z'
const artifactHash = 'a'.repeat(64)
const manifestHash = 'b'.repeat(64)
const segmentHash = 'c'.repeat(64)

const source = {
  sourceArtifactId: 'artifact-validated',
  sourceArtifactSha256: artifactHash,
  sourceManifestId: 'manifest-validated',
  sourceManifestHash: manifestHash,
  durationMs: 120_000,
  rightsSnapshotId: 'rights-validated',
  rightsStatus: 'approved',
  consentStatus: 'not-required',
  sourceSpeechSegment: {
    id: 'speech-segment-hook',
    hash: segmentHash,
    exactText: 'Este hook foi observado no material publicado.',
    speakerId: 'person-specialist',
    rangeMs: [2_000, 9_000],
  },
}

const validationSource = {
  platform: 'instagram',
  publicationRef: 'reel-validated-001',
  accountRef: '@especialista',
  url: 'https://www.instagram.com/reel/validated-001/',
  observedAt: '2026-07-01T12:00:00.000Z',
}

const performance = {
  metric: 'three-second-hold-rate',
  value: 0.81,
  unit: 'ratio',
  sampleSize: 25_000,
  period: {
    start: '2026-07-01T12:00:00.000Z',
    end: '2026-07-08T12:00:00.000Z',
  },
  comparison: {
    label: 'Median of the previous ten publications',
    value: 0.56,
    unit: 'ratio',
  },
}

function validated(overrides = {}) {
  return catalogValidatedSegment({
    id: 'validated-segment-fixture',
    workspaceId: 'workspace-validated',
    projectId: 'project-validated',
    source,
    scope: { unit: 'hook', evidenceScope: 'opening-edit' },
    validationSource,
    performance,
    validatedAt: '2026-07-10T12:00:00.000Z',
    expiresAt: '2027-01-10T12:00:00.000Z',
    actor: { type: 'api-client', id: 'client-validated' },
    createdAt,
    ...overrides,
  })
}

const currentRights = {
  id: 'rights-validated',
  status: 'approved',
  consentStatus: 'not-required',
}

const recipe = {
  id: 'recipe-new-ad',
  role: 'hook',
  objective: 'lead-generation',
  format: '9:16',
  locale: 'pt-BR',
}

test('T-FR-046 models source, explicit scope, date, performance evidence and expiry as immutable history', () => {
  const item = validated()
  assert.equal(item.source.platform, 'instagram')
  assert.equal(item.scope.unit, 'hook')
  assert.equal(item.scope.evidenceScope, 'opening-edit')
  assert.equal(item.performance.metric, 'three-second-hold-rate')
  assert.equal(item.performance.sampleSize, 25_000)
  assert.equal(item.validatedAt, '2026-07-10T12:00:00.000Z')
  assert.equal(item.expiresAt, '2027-01-10T12:00:00.000Z')
  assert.match(item.validatedSegmentHash, /^[a-f0-9]{64}$/)
  assert.equal(item.physicalMaterialized, false)
  assert.ok(Object.isFrozen(item))
  assert.ok(Object.isFrozen(item.performance))
  assert.ok(Object.isFrozen(item.performance.period))
  assert.ok(Object.isFrozen(item.performance.comparison))
  assert.ok(Object.isFrozen(item.protectedEnvelope))
  assert.ok(Object.isFrozen(item.protectedEnvelope.protectedAspects))
  assert.throws(
    () => validated({
      performance: {
        ...performance,
        comparison: {
          ...performance.comparison,
          value: 1.01,
        },
      },
    }),
    /performance\.comparison\.value ratio must be between 0 and 1/,
  )
})

test('T-FR-046 derives wholeVideoValidated only from the explicit validation unit', () => {
  assert.equal(validated().wholeVideoValidated, false)
  const whole = validated({
    id: 'validated-segment-whole',
    source: {
      ...source,
      sourceSpeechSegment: undefined,
    },
    scope: {
      unit: 'whole-video',
      evidenceScope: 'opening-edit',
    },
  })
  assert.equal(whole.wholeVideoValidated, true)
  assert.deepEqual(whole.protectedEnvelope.sourceRangeMs, [0, 120_000])
  assert.throws(
    () => validated({
      scope: {
        unit: 'whole-video',
        evidenceScope: 'opening-edit',
      },
    }),
    /cannot identify one SpeechSegment/,
  )
})

test('T-FR-046 derives the protected copy, take, timing and opening envelope from evidence scope', () => {
  const copy = validated({
    id: 'validated-segment-copy',
    scope: { unit: 'hook', evidenceScope: 'copy' },
  })
  const take = validated({
    id: 'validated-segment-take',
    scope: { unit: 'hook', evidenceScope: 'spoken-take' },
  })
  const opening = validated()
  assert.deepEqual(copy.protectedEnvelope.protectedAspects, ['copy'])
  assert.deepEqual(
    take.protectedEnvelope.protectedAspects,
    ['copy', 'take'],
  )
  assert.deepEqual(
    opening.protectedEnvelope.protectedAspects,
    ['copy', 'take', 'timing', 'opening'],
  )
  assert.equal(
    opening.protectedEnvelope.sourceSpeechSegmentHash,
    segmentHash,
  )
  assert.equal(
    opening.protectedEnvelope.exactCopy,
    source.sourceSpeechSegment.exactText,
  )
})

test('T-FR-046 never permits a causal performance claim regardless of scope', () => {
  for (const unit of ['hook', 'segment', 'whole-video']) {
    const item = validated({
      id: `validated-segment-${unit}`,
      source: unit === 'whole-video'
        ? { ...source, sourceSpeechSegment: undefined }
        : source,
      scope: {
        unit,
        evidenceScope: 'copy',
      },
    })
    const decision = evaluateValidatedSegmentReuse({
      segment: item,
      currentRights,
      targetRecipe: {
        ...recipe,
        role: unit === 'whole-video' ? 'whole-video' : 'hook',
      },
      requestedChanges: [],
      claim: 'causality',
      evaluatedAt: createdAt,
    })
    assert.equal(decision.compatible, false)
    assert.equal(decision.causalClaimAllowed, false)
    assert.equal(
      decision.performanceInterpretation,
      'historical-association',
    )
    assert.ok(decision.reasons.includes('CAUSALITY_NOT_SUPPORTED'))
  }
})

test('T-FR-046 accepts a compatible new recipe and blocks protected, role, expiry and rights drift', () => {
  const item = validated()
  const compatible = evaluateValidatedSegmentReuse({
    segment: item,
    currentRights,
    targetRecipe: recipe,
    requestedChanges: [],
    claim: 'historical-association',
    evaluatedAt: createdAt,
  })
  assert.equal(compatible.compatible, true)
  assert.deepEqual(compatible.reasons, [])

  const incompatible = evaluateValidatedSegmentReuse({
    segment: item,
    currentRights: { ...currentRights, id: 'rights-rotated' },
    targetRecipe: { ...recipe, role: 'body' },
    requestedChanges: ['copy', 'timing'],
    claim: 'causality',
    evaluatedAt: '2027-02-01T00:00:00.000Z',
  })
  assert.equal(incompatible.compatible, false)
  assert.deepEqual(incompatible.reasons, [
    'VALIDATION_EXPIRED',
    'RIGHTS_SNAPSHOT_STALE',
    'VALIDATION_UNIT_HOOK_ONLY',
    'PROTECTED_COPY',
    'PROTECTED_TIMING',
    'CAUSALITY_NOT_SUPPORTED',
  ])
})
