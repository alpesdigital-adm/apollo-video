import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  stableSerialize,
} from '../../src/v2/domain/canonical-hash.ts'
import {
  createCatalogedEvidenceSegment,
} from '../../src/v2/domain/evidence-segment.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import {
  createProofIntegrityRun,
  hydrateProofIntegrityRun,
  PROOF_INTEGRITY_PERIOD_CLAIM_KEY,
  PROOF_INTEGRITY_PERSON_CLAIM_KEY,
} from '../../src/v2/domain/proof-integrity.ts'
import {
  createProofNeedRun,
} from '../../src/v2/domain/proof-need.ts'
import {
  catalogSpeechSegments,
} from '../../src/v2/domain/speech-segment-catalog.ts'

const hash = (character) => character.repeat(64)
const evaluatedAt = '2026-07-29T14:00:00.000Z'
const claim = 'O método aumentou a conversão em 20%.'

const policyEval = JSON.parse(fs.readFileSync(
  new URL(
    '../fixtures/proof-needs/integrity-policy-cases.json',
    import.meta.url,
  ),
  'utf8',
))

function sourceSpeechSegment() {
  const transcript = createMediaTranscript({
    language: 'pt-BR',
    text: 'O método aumentou a conversão em vinte por cento.',
    provider: 'fixture',
    model: 'proof-integrity-alignment-v1',
    words: [
      { word: 'O', start: 1, end: 1.1 },
      { word: 'método', start: 1.1, end: 1.4 },
      { word: 'aumentou', start: 1.4, end: 1.8 },
      { word: 'a', start: 1.8, end: 1.9 },
      { word: 'conversão', start: 1.9, end: 2.3 },
      { word: 'em', start: 2.3, end: 2.4 },
      { word: 'vinte', start: 2.4, end: 2.6 },
      { word: 'por', start: 2.6, end: 2.7 },
      { word: 'cento.', start: 2.7, end: 3 },
    ],
    segments: [{
      id: 1,
      start: 1,
      end: 3,
      text: 'O método aumentou a conversão em vinte por cento.',
      confidence: .99,
    }],
  })
  return catalogSpeechSegments({
    workspaceId: 'workspace-proof-integrity',
    projectId: 'project-proof-integrity',
    catalogRunId: 'speech-catalog-proof-integrity',
    sourceTranscriptId: 'transcript-proof-integrity',
    sourceArtifactId: 'artifact-proof-integrity',
    transcript,
    annotations: [{
      sourceSegmentId: 1,
      speaker: { value: 'person-client-a', confidence: .99 },
    }],
    producer: {
      provider: 'apollo',
      model: 'speech-catalog',
      version: '1.0.0',
      confidence: .99,
    },
    createdAt: evaluatedAt,
    createSegmentId: () => 'speech-segment-proof-integrity',
  })[0]
}

function evidenceFor(kind) {
  return createCatalogedEvidenceSegment({
    id: `evidence-proof-integrity-${kind}`,
    workspaceId: 'workspace-proof-integrity',
    projectId: 'project-proof-integrity',
    sourceSpeechSegment: sourceSpeechSegment(),
    transcriptDurationMs: 5_000,
    rights: {
      id: 'rights-proof-integrity',
      rightsStatus: 'approved',
      consentStatus: 'approved',
    },
    category: 'testimonial',
    claim: {
      value: kind === 'claim-drift'
        ? 'A receita dobrou.'
        : kind === 'normalized-text-match'
          ? 'o METODO aumentou a conversao em 20'
          : claim,
      confidence: .99,
    },
    context: {
      value: 'Resultado medido no período declarado.',
      confidence: .99,
    },
    qualifiers: [{
      value: kind === 'period-drift'
        ? 'period:2024'
        : 'period:2025',
      confidence: .99,
    }],
    subject: {
      value: kind === 'person-drift' ? 'Cliente B' : 'Cliente A',
      confidence: .99,
    },
    attribution: {
      value: 'Depoimento de Cliente A',
      confidence: .99,
    },
    compatibleOfferIds: [
      kind === 'product-drift' ? 'offer-other' : 'offer-apollo',
    ],
    compatibleAudienceTags: [
      kind === 'audience-drift' ? 'estudantes' : 'gestores',
    ],
    compatibleObjections: [],
    credibilityScore: .98,
    specificityScore: .97,
    authenticityScore: .99,
    contextRangeMs: [500, 3_500],
    frameRefs: ['frame-proof-integrity'],
    adjacentEvidenceIds: ['evidence-adjacent-proof-integrity'],
    requiresContext: true,
    producer: {
      provider: 'apollo',
      model: 'evidence-catalog',
      version: '1.0.0',
      confidence: .99,
    },
    actorId: 'api-client-proof-integrity',
    createdAt: evaluatedAt,
  })
}

function recipe() {
  const blocks = [
    {
      id: 'story-block-proof-claim',
      actId: 'development',
      role: 'argument',
      intent: 'develop-claim',
      dependencies: [],
      sourceCandidateIds: ['take-body-proof-integrity'],
      durationTargetMs: { min: 3_000, ideal: 3_000, max: 3_000 },
      content: {
        claimIds: ['claim-main'],
        qualifierIds: [],
        proofIds: [],
      },
      presentation: 'source-video',
      sourceRangeId: 'segment-body-proof-integrity',
    },
    {
      id: 'story-block-proof-slot',
      actId: 'development',
      role: 'proof',
      intent: 'support-claim',
      dependencies: ['story-block-proof-claim'],
      sourceCandidateIds: ['take-proof-integrity'],
      durationTargetMs: { min: 2_000, ideal: 2_000, max: 2_000 },
      content: {
        claimIds: [],
        qualifierIds: [],
        proofIds: ['take-proof-integrity'],
      },
      presentation: 'source-video',
      sourceRangeId: 'segment-proof-integrity',
    },
  ]
  return {
    id: 'variant-recipe-proof-integrity',
    workspaceId: 'workspace-proof-integrity',
    projectId: 'project-proof-integrity',
    batchId: 'batch-proof-integrity',
    status: 'selected',
    objective: 'sale',
    runHash: hash('a'),
    storyPlan: {
      id: 'story-plan-proof-integrity',
      schemaVersion: 1,
      compilerVersion: 'variant-recipe-compiler/v1',
      objective: 'sale',
      targetDurationMs: { min: 5_000, max: 5_000 },
      acts: [{
        id: 'development',
        role: 'development',
        blockIds: blocks.map((block) => block.id),
      }],
      blocks,
      storyHash: hash('b'),
    },
    editPlan: {
      fps: 30,
      videoTracks: [{
        id: 'video-track-proof-integrity',
        kind: 'base-video',
        clips: [
          {
            storyBlockId: blocks[0].id,
            timelineRangeFrames: [0, 90],
          },
          {
            storyBlockId: blocks[1].id,
            timelineRangeFrames: [90, 150],
          },
        ],
      }],
    },
  }
}

function proofNeed(kind, evidence) {
  const lowRisk = kind === 'no-proof-needed'
  const candidates =
    lowRisk || kind === 'proof-unavailable'
      ? []
      : [{
          id: evidence.id,
          evidenceHash: evidence.evidenceHash,
          category: evidence.category,
          sourceArtifactId: evidence.sourceArtifactId,
          sourceRangeMs: evidence.sourceRangeMs,
          contextRangeMs: evidence.contextRangeMs,
          credibilityScore: evidence.credibilityScore,
          specificityScore: evidence.specificityScore,
          authenticityScore: evidence.authenticityScore,
          reuseAllowed: true,
          reuseReasons: [],
        }]
  return createProofNeedRun({
    id: `proof-need-run-integrity-${kind}`,
    workspaceId: 'workspace-proof-integrity',
    projectId: 'project-proof-integrity',
    batchId: 'batch-proof-integrity',
    targetRecipe: recipe(),
    declarations: [{
      storyBlockId: 'story-block-proof-claim',
      claimId: 'claim-main',
      claimText: kind === 'normalized-text-match'
        ? 'O MÉTODO aumentou a conversão em 20'
        : claim,
      claimKind: lowRisk ? 'low-risk' : 'outcome',
    }],
    evidenceCandidates: [candidates],
    createdByClientId: 'api-client-proof-integrity',
    createdAt: evaluatedAt,
  })
}

function recipeNode(kind) {
  const claims = [
    {
      key: 'claim-main',
      value: kind === 'normalized-text-match'
        ? 'o metodo AUMENTOU a conversão em 20!'
        : claim,
    },
    ...(kind === 'recipe-person-unspecified'
      ? []
      : [{
          key: PROOF_INTEGRITY_PERSON_CLAIM_KEY,
          value: 'Cliente A',
        }]),
    {
      key: PROOF_INTEGRITY_PERIOD_CLAIM_KEY,
      value: '2025',
    },
  ]
  return {
    id: 'compatibility-node-proof-integrity',
    takeId: 'take-body-proof-integrity',
    takeHash: hash('c'),
    groupId: 'take-group-proof-integrity',
    scriptBlockId: 'script-block-proof-integrity',
    role: 'body',
    sourceArtifactId: 'artifact-body-proof-integrity',
    sourceHash: hash('d'),
    sourceRangeMs: [0, 3_000],
    durationMs: 3_000,
    offerId: 'offer-apollo',
    audienceTags: ['gestores'],
    claims,
    personaId: 'persona-manager',
    locale: 'pt-BR',
    continuityProvides: [],
    continuityRequires: [],
    narrativeTags: ['conversion'],
    tone: .7,
    energy: .7,
    visual: .7,
    experiment: .2,
    evidenceRefs: ['fixture-proof-integrity'],
    contextHash: hash('e'),
    nodeHash: hash('f'),
  }
}

function runFor(kind) {
  const evidence = evidenceFor(kind)
  const need = proofNeed(kind, evidence)
  const use = {
    proofNeedItemId: need.items[0].id,
    ...(kind === 'context-missing'
      ? {}
      : {
          includedContextRangeMs: kind === 'context-incomplete'
            ? [1_000, 3_000]
            : [500, 3_500],
        }),
    includedAdjacentEvidenceIds:
      kind === 'adjacent-context-missing'
        ? []
        : ['evidence-adjacent-proof-integrity'],
  }
  const currentRights = {
    id: kind === 'rights-snapshot-stale'
      ? 'rights-proof-integrity-superseded'
      : evidence.rightsSnapshotId,
    rightsStatus: 'approved',
    consentStatus: 'approved',
    ...(kind === 'rights-expired'
      ? { rightsExpiresAt: '2026-07-29T13:59:59.000Z' }
      : {}),
    ...(kind === 'consent-expired'
      ? { consentExpiresAt: '2026-07-29T13:59:59.000Z' }
      : {}),
  }
  return createProofIntegrityRun({
    id: `proof-integrity-run-${kind}`,
    workspaceId: 'workspace-proof-integrity',
    projectId: 'project-proof-integrity',
    proofNeedRun: need,
    sources: [{
      item: need.items[0],
      ...(need.items[0].resolution === 'selected-evidence'
        ? {
            recipeNode: recipeNode(kind),
            evidence,
            currentRights,
            use,
          }
        : {}),
    }],
    createdByClientId: 'api-client-proof-integrity',
    createdAt: evaluatedAt,
  })
}

test('T-FR-131 policy eval controls critical false positives and false negatives', () => {
  assert.equal(
    policyEval.schemaVersion,
    'proof-integrity-policy-eval/v1',
  )
  assert.equal(policyEval.cases.length, 16)
  for (const policyCase of policyEval.cases) {
    const run = runFor(policyCase.kind)
    const evaluation = run.evaluations[0]
    assert.equal(
      evaluation.outcome,
      policyCase.expectedOutcome,
      policyCase.id,
    )
    for (const reason of policyCase.expectedReasons) {
      assert.ok(
        evaluation.issue?.reasonCodes.includes(reason),
        `${policyCase.id} should include ${reason}`,
      )
    }
    if (evaluation.outcome === 'approved') {
      assert.equal(evaluation.allowedForAssembly, true)
      assert.equal(evaluation.issue, undefined)
    } else {
      assert.equal(evaluation.allowedForAssembly, false)
    }
    assert.equal(evaluation.fabricationSuggested, false)
    assert.equal(
      evaluation.issue?.fabricationSuggested ?? false,
      false,
    )
  }
})

test('T-FR-131 blocks stale and expired rights snapshots by dimension', () => {
  const approvedRights = runFor('canonical-match').evaluations[0]
    .comparisons.find((entry) => entry.dimension === 'rights')
  assert.equal(approvedRights.outcome, 'match')
  assert.equal(approvedRights.reasonCode, undefined)

  const stale = runFor('rights-snapshot-stale').evaluations[0]
  const staleRights = stale.comparisons.find((entry) =>
    entry.dimension === 'rights')
  assert.equal(stale.outcome, 'blocked')
  assert.equal(stale.allowedForAssembly, false)
  assert.equal(staleRights.outcome, 'mismatch')
  assert.equal(staleRights.reasonCode, 'RIGHTS_SNAPSHOT_STALE')
  assert.ok(stale.issue.actions.includes('renew-rights-or-consent'))
  assert.equal(stale.issue.fabricationSuggested, false)

  const expired = runFor('rights-expired').evaluations[0]
  const expiredRights = expired.comparisons.find((entry) =>
    entry.dimension === 'rights')
  assert.equal(expired.outcome, 'blocked')
  assert.equal(expired.allowedForAssembly, false)
  assert.equal(expiredRights.outcome, 'expired')
  assert.equal(expiredRights.reasonCode, 'RIGHTS_EXPIRED')
  assert.equal(
    expired.issue.reasonCodes.includes('RIGHTS_NOT_APPROVED'),
    false,
    'an expired right must not be reported as a merely unapproved right',
  )
  assert.ok(expired.issue.actions.includes('renew-rights-or-consent'))

  for (const kind of ['rights-snapshot-stale', 'rights-expired']) {
    const run = runFor(kind)
    assert.equal(
      hydrateProofIntegrityRun(JSON.parse(stableSerialize(run))).runHash,
      run.runHash,
    )
    assert.equal(run.summary.readyForAssembly, false)
    assert.equal(run.summary.fabricationSuggestionCount, 0)
  }
})

test('T-FR-131 preserves exact qualifier and attribution in visual and verbal contracts', () => {
  const evaluation = runFor('canonical-match').evaluations[0]
  assert.equal(evaluation.outcome, 'approved')
  assert.deepEqual(
    evaluation.presentation.visual,
    evaluation.presentation.verbal,
  )
  assert.deepEqual(
    evaluation.presentation.visual.qualifiers,
    ['period:2025'],
  )
  assert.equal(
    evaluation.presentation.visual.attribution,
    'Depoimento de Cliente A',
  )
  assert.deepEqual(
    evaluation.presentation.requiredContextRangeMs,
    [500, 3_500],
  )
  assert.deepEqual(
    evaluation.presentation.requiredAdjacentEvidenceIds,
    ['evidence-adjacent-proof-integrity'],
  )
})

test('T-FR-131 emits actionable hard issues that never suggest fabricated evidence', () => {
  const issue = runFor('claim-drift').evaluations[0].issue
  assert.equal(issue.code, 'PROOF_INTEGRITY_BLOCKED')
  assert.equal(issue.severity, 'hard')
  assert.ok(issue.actions.includes('select-compatible-existing-evidence'))
  assert.equal(issue.fabricationSuggested, false)
  assert.doesNotMatch(
    `${issue.message} ${issue.actions.join(' ')}`,
    /fabricat(?:e|ion)|generate-proof/i,
  )
})

test('T-FR-131 canonical persistence round-trip rejects integrity tampering', () => {
  const run = runFor('canonical-match')
  const hydrated = hydrateProofIntegrityRun(
    JSON.parse(stableSerialize(run)),
  )
  assert.equal(hydrated.runHash, run.runHash)
  assert.throws(
    () => hydrateProofIntegrityRun({
      ...JSON.parse(stableSerialize(run)),
      summary: {
        ...run.summary,
        fabricationSuggestionCount: 1,
      },
    }),
    /summary or run hash is invalid/,
  )
  assert.throws(
    () => hydrateProofIntegrityRun({
      ...JSON.parse(stableSerialize(run)),
      evaluations: [{
        ...run.evaluations[0],
        allowedForAssembly: false,
      }],
    }),
    /evaluation 1 is invalid/,
  )
})
