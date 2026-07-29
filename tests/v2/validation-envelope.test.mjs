import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createInitialValidationEnvelopeDecision,
  createValidationEnvelopeReusePlan,
  decideValidationEnvelopeExit,
} from '../../src/v2/domain/validation-envelope.ts'

const hash = (value) => value.repeat(64)

function validatedSegment(evidenceScope = 'opening-edit') {
  return {
    id: 'validated-segment-hook-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sourceArtifactId: 'artifact-validated-hook',
    sourceArtifactSha256: hash('a'),
    sourceManifestId: 'manifest-hook-1',
    sourceManifestHash: hash('b'),
    sourceSpeechSegmentId: 'speech-segment-hook-1',
    sourceSpeechSegmentHash: hash('c'),
    scope: { unit: 'hook', evidenceScope },
    wholeVideoValidated: false,
    source: {
      platform: 'instagram',
      publicationRef: 'reel-1',
      observedAt: '2026-07-01T00:00:00.000Z',
    },
    performance: {
      metric: 'hold-rate',
      value: 0.8,
      unit: 'ratio',
      sampleSize: 1000,
      period: {
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-06-30T00:00:00.000Z',
      },
    },
    protectedEnvelope: {
      schemaVersion: 'protected-validation-envelope/v1',
      sourceArtifactId: 'artifact-validated-hook',
      sourceArtifactSha256: hash('a'),
      sourceRangeMs: [1_000, 4_000],
      sourceSpeechSegmentId: 'speech-segment-hook-1',
      sourceSpeechSegmentHash: hash('c'),
      exactCopy: 'Pare de desperdiçar verba com criativos fracos.',
      speakerId: 'speaker-1',
      protectedAspects: evidenceScope === 'copy'
        ? ['copy']
        : evidenceScope === 'spoken-take'
          ? ['copy', 'take']
          : ['copy', 'take', 'timing', 'opening'],
      copyProtected: true,
      takeProtected: evidenceScope !== 'copy',
      timingProtected: evidenceScope === 'opening-edit',
      openingProtected: evidenceScope === 'opening-edit',
      envelopeHash: hash('d'),
    },
    rightsSnapshotId: 'rights-1',
    rightsStatus: 'approved',
    consentStatus: 'approved',
    validatedAt: '2026-07-01T00:00:00.000Z',
    claimPolicyVersion: 'historical-association/v1',
    causalClaimAllowed: false,
    policyVersion: 'validated-segment/v1',
    physicalMaterialized: false,
    createdBy: { type: 'api-client', id: 'api-client-1' },
    createdAt: '2026-07-01T00:00:00.000Z',
    validatedSegmentHash: hash('e'),
  }
}

function sourceSegment(role, ordinal) {
  return {
    id: `recipe-segment-${role}-${ordinal}`,
    usage: 'primary',
    role,
    nodeId: `node-${role}-${ordinal}`,
    takeId: `take-${role}-${ordinal}`,
    takeHash: hash(String(ordinal)),
    scriptBlockId: `script-block-${role}-${ordinal}`,
    sourceArtifactId: `artifact-${role}-${ordinal}`,
    sourceHash: hash(String(ordinal + 1)),
    sourceRangeMs: [ordinal * 10_000, ordinal * 10_000 + 5_000],
    durationMs: 5_000,
    segmentHash: hash(String(ordinal + 2)),
  }
}

function targetRecipe() {
  return {
    id: 'variant-recipe-target-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    batchId: 'production-batch-1',
    objective: 'lead-generation',
    runHash: hash('f'),
    sourceSegments: [
      sourceSegment('hook', 1),
      sourceSegment('body', 2),
      sourceSegment('proof', 3),
      sourceSegment('cta', 4),
      {
        ...sourceSegment('body', 5),
        id: 'recipe-segment-cold-open',
        usage: 'cold-open',
        role: 'body',
      },
    ],
  }
}

function createPlan(patch = {}) {
  return createValidationEnvelopeReusePlan({
    id: 'validation-envelope-reuse-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    batchId: 'production-batch-1',
    validatedSegment: validatedSegment(),
    targetRecipe: targetRecipe(),
    requestedChanges: [],
    createdByClientId: 'api-client-1',
    createdAt: '2026-07-28T20:00:00.000Z',
    ...patch,
  })
}

test('T-FR-124 represents copy, take, framing, timing and opening explicitly', () => {
  const opening = createPlan()
  assert.deepEqual(
    opening.aspectRules.map(({ aspect, state }) => ({ aspect, state })),
    [
      { aspect: 'copy', state: 'protected' },
      { aspect: 'take', state: 'protected' },
      { aspect: 'framing', state: 'protected' },
      { aspect: 'timing', state: 'protected' },
      { aspect: 'opening', state: 'protected' },
    ],
  )

  const copy = createPlan({
    validatedSegment: validatedSegment('copy'),
  })
  assert.deepEqual(copy.protectedAspects, ['copy'])
  assert.deepEqual(
    copy.mutableAspects,
    ['take', 'framing', 'timing', 'opening'],
  )
})

test('T-FR-124 protects optional envelope changes automatically', () => {
  const plan = createPlan({
    requestedChanges: [
      {
        aspect: 'copy',
        required: false,
        rationale: 'Ajustar uma palavra sem necessidade editorial.',
      },
    ],
  })
  const decision = createInitialValidationEnvelopeDecision({
    id: 'validation-envelope-decision-1',
    plan,
  })
  assert.equal(plan.approvalRequired, false)
  assert.deepEqual(plan.autoProtectedChanges, ['copy'])
  assert.equal(decision.validation, 'preserved')
  assert.deepEqual(decision.blockedChanges, ['copy'])
})

test('T-FR-124 requires explicit approval to leave the envelope and logs loss', () => {
  const plan = createPlan({
    requestedChanges: [
      {
        aspect: 'opening',
        required: true,
        rationale: 'Inserir uma prova antes do hook validado.',
      },
    ],
  })
  const initial = createInitialValidationEnvelopeDecision({
    id: 'validation-envelope-decision-1',
    plan,
  })
  assert.equal(initial.outcome, 'approval-required')
  assert.equal(initial.validation, 'pending-approval')

  const approved = decideValidationEnvelopeExit({
    id: 'validation-envelope-decision-2',
    plan,
    action: 'approve',
    note: 'Aprovo conscientemente a perda da validação histórica.',
    actorClientId: 'api-client-2',
    createdAt: '2026-07-28T20:01:00.000Z',
  })
  assert.equal(approved.validation, 'lost')
  assert.deepEqual(approved.lostAspects, ['opening'])

  const rejected = decideValidationEnvelopeExit({
    id: 'validation-envelope-decision-3',
    plan,
    action: 'reject',
    note: 'Preservar o hook validado sem alteração na abertura.',
    actorClientId: 'api-client-2',
    createdAt: '2026-07-28T20:01:00.000Z',
  })
  assert.equal(rejected.validation, 'preserved')
  assert.deepEqual(rejected.blockedChanges, ['opening'])
})

test('T-FR-124 reuses only the exact hook envelope with new body and CTA', () => {
  const plan = createPlan()
  const composition = plan.composition
  assert.deepEqual(composition.orderedRoles, [
    'hook',
    'body',
    'proof',
    'cta',
  ])
  assert.deepEqual(
    composition.clips[0].sourceRangeMs,
    validatedSegment().protectedEnvelope.sourceRangeMs,
  )
  assert.equal(composition.targetRecipeHookExcluded, true)
  assert.equal(
    composition.excludedTargetRecipeSegmentIds.includes(
      'recipe-segment-hook-1',
    ),
    true,
  )
  assert.equal(
    composition.excludedTargetRecipeSegmentIds.includes(
      'recipe-segment-cold-open',
    ),
    true,
  )
  assert.equal(
    composition.validatedSourceOutsideEnvelopeIncluded,
    false,
  )
  assert.equal(composition.excessMaterialIncluded, false)
})
