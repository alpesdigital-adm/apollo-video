import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planCleanup,
} from '../../src/v2/domain/source-deconstruction.ts'
import {
  PROOF_VISUAL_GOLDENS,
  declareProofNeed,
  extractContiguous,
  planLongFormWorkflow,
  planProofMode,
  proofIntegrityGate,
  querySemanticRepository,
  selectProof,
} from '../../src/v2/application/proof-and-longform.ts'
import {
  createEvidenceSegment,
} from '../../src/v2/domain/semantic-reuse.ts'

const cleanupContaminations = Object.freeze([
  {
    id: 'caption',
    rangeMs: [0, 800],
    region: { x: 0.1, y: 0.8, width: 0.2, height: 0.1 },
    confidence: 0.95,
    overlapsEssential: false,
  },
  {
    id: 'logo',
    rangeMs: [1_000, 1_800],
    region: { x: 0, y: 0.8, width: 0.2, height: 0.1 },
    confidence: 0.95,
    overlapsEssential: false,
  },
  {
    id: 'music',
    rangeMs: [2_000, 2_800],
    region: { x: 0.1, y: 0.8, width: 0.2, height: 0.1 },
    confidence: 0.95,
    overlapsEssential: false,
  },
  {
    id: 'border',
    rangeMs: [3_000, 3_800],
    region: { x: 0, y: 0.8, width: 0.2, height: 0.1 },
    confidence: 0.95,
    overlapsEssential: false,
  },
  {
    id: 'overlay',
    rangeMs: [4_000, 4_800],
    region: { x: 0.1, y: 0.8, width: 0.2, height: 0.1 },
    confidence: 0.95,
    overlapsEssential: true,
  },
])

const evidence = (patch = {}) => createEvidenceSegment({
  id: 'e',
  artifactId: 'a',
  claim: 'Melhorou conversão',
  qualifier: 'No período medido',
  subject: 'Cliente',
  attribution: 'Cliente A',
  consent: 'approved',
  contextWindowMs: [0, 5_000],
  transcript: 'texto',
  frameRefs: ['f'],
  adjacentEvidenceIds: [],
  category: 'testimonial',
  integrity: 'valid',
  requiresContext: true,
  ...patch,
})

test(
  'T-FR-122 selects cleanup, keeps source immutable and rechecks visual/rights',
  () => {
    const strategies = new Set()

    for (const [index, contamination] of cleanupContaminations.entries()) {
      const result = planCleanup({
        sourceArtifactId: 's',
        contamination: {
          ...contamination,
          region: index === 1
            ? { x: 0, y: 0, width: 0.1, height: 0.1 }
            : contamination.region,
        },
        residualQuality: index === 4 ? 0.2 : 0.95,
        integrity: index === 0 ? 0.95 : 0.7,
        costs: { trim: 0.1, 'crop-reframe': 0.2, cover: 0.3 },
        maxCost: 1,
      })
      strategies.add(result.selected)
      if (result.derivative) {
        assert.equal(result.derivative.sourceImmutable, true)
      }
    }

    assert.ok(strategies.has('reject'))
    assert.ok([...strategies].some((strategy) => strategy !== 'reject'))
  },
)

test(
  'T-FR-130 declares proof needs and searches evidence before generic cards',
  () => {
    const needs = [
      declareProofNeed({
        objective: 'sale',
        claimRisk: 0.8,
        momentMs: 1_000,
      }),
      declareProofNeed({
        objective: 'awareness',
        claimRisk: 0.8,
        momentMs: 1_000,
      }),
      declareProofNeed({
        objective: 'warming',
        claimRisk: 0.8,
        momentMs: 1_000,
      }),
      declareProofNeed({
        objective: 'sale',
        claimRisk: 0.1,
        momentMs: 1_000,
      }),
    ]
    assert.deepEqual(
      needs.map((need) => need.type),
      ['testimonial', 'data', 'demonstration', 'none'],
    )
    assert.equal(selectProof(needs[0], [evidence()]).decision, 'use-evidence')
    assert.equal(selectProof(needs[0], []).generatedGenericCard, false)
  },
)

test(
  'T-FR-131 blocks incompatible proof and preserves attribution',
  () => {
    const item = evidence()
    const recipe = {
      claim: item.claim,
      product: 'Apollo',
      person: 'A',
      period: '2026',
      audience: 'gestores',
      consentRequired: true,
    }
    const ok = proofIntegrityGate(item, recipe, {
      product: 'Apollo',
      person: 'A',
      period: '2026',
      audience: 'gestores',
      expired: false,
    })
    assert.equal(ok.allowed, true)
    assert.equal(ok.presentation.qualifier, item.qualifier)

    const bad = proofIntegrityGate(item, recipe, {
      product: 'Outro',
      person: 'B',
      period: '2025',
      audience: 'alunos',
      expired: true,
    })
    assert.equal(bad.allowed, false)
    assert.equal(bad.issue.fabricationSuggested, false)
    assert.ok(bad.reasons.length >= 4)
  },
)

test(
  'T-FR-132 plans proof presentation and supports manual override',
  () => {
    assert.equal(PROOF_VISUAL_GOLDENS.length, 15)
    assert.equal(
      planProofMode({
        media: 'video',
        format: '9:16',
        rhythm: 'fast',
        contextRequired: false,
      }).mode,
      'cutaway',
    )
    assert.equal(
      planProofMode({
        media: 'image',
        format: '1:1',
        rhythm: 'measured',
        contextRequired: true,
      }).mode,
      'split-screen',
    )
    assert.equal(
      planProofMode({
        media: 'text',
        format: '21:9',
        rhythm: 'measured',
        contextRequired: false,
      }).mode,
      'proof-card',
    )
    assert.equal(
      planProofMode({
        media: 'video',
        format: '4:5',
        rhythm: 'fast',
        contextRequired: false,
        override: 'proof-card',
      }).overrideApplied,
      true,
    )
  },
)

test(
  'T-FR-133 resumable 2h workflow publishes partial tiers within budget',
  () => {
    const workflow = planLongFormWorkflow({
      jobId: 'j',
      durationMs: 7_200_000,
      completedTiers: ['probe', 'transcript'],
      partialCounts: { chunks: 10 },
      tierCosts: {
        probe: 1,
        transcript: 2,
        diarization: 2,
        chunks: 1,
        moments: 3,
      },
      budget: 6,
      maxConcurrency: 4,
    })
    assert.equal(workflow.resumable, true)
    assert.equal(workflow.duplicateSegments, false)
    assert.equal(
      workflow.tiers.find((tier) => tier.tier === 'chunks')
        .partialSearchable,
      true,
    )
    assert.ok(workflow.estimatedCost <= 6)
    assert.equal(workflow.concurrency, 2)
  },
)

test(
  'T-FR-134 extracts semantic contiguous 2min window from 2h',
  () => {
    const moments = [
      {
        id: 'm',
        topic: 'ads',
        objective: 'education',
        rangeMs: [3_500_000, 3_610_000],
        semanticStartMs: 3_495_000,
        semanticEndMs: 3_615_000,
        scores: {
          selfContained: 0.9,
          density: 0.8,
          integrity: 1,
          audio: 0.9,
          visual: 0.8,
        },
      },
      {
        id: 'x',
        topic: 'other',
        objective: 'education',
        rangeMs: [0, 1_000],
        semanticStartMs: 0,
        semanticEndMs: 1_000,
        scores: {
          selfContained: 1,
          density: 1,
          integrity: 1,
          audio: 1,
          visual: 1,
        },
      },
    ]
    const result = extractContiguous({
      moments,
      topic: 'ads',
      objective: 'education',
      targetDurationMs: 120_000,
      toleranceMs: 15_000,
    })
    assert.deepEqual(result.best.rangeMs, [3_495_000, 3_615_000])
    assert.equal(result.editPlan.synthesizedRanges, false)
  },
)

test(
  'T-FR-136 queries unified repository rights-first with audit',
  () => {
    const kinds = ['asset', 'segment', 'moment', 'speech', 'evidence']
    const entities = kinds.map((kind, index) => ({
      id: `entity-${index}`,
      workspaceId: 'w',
      kind,
      rights: index === 4 ? 'blocked' : 'approved',
      consent: 'not-required',
      intention: ['proof'],
      atmosphere: 'confiante',
      personIds: ['p'],
      speech: 'resultado',
      visual: 'dashboard',
      latencyMs: 5 + index,
    }))
    const result = querySemanticRepository(entities, {
      workspaceId: 'w',
      intention: 'proof',
      atmosphere: 'confiante',
      personId: 'p',
      speech: 'resultado',
      visual: 'dashboard',
    })
    assert.equal(
      new Set(result.candidates.map((candidate) => candidate.entity.kind))
        .size,
      4,
    )
    assert.equal(result.rejected[0].reasons[0], 'RIGHTS')
    assert.ok(result.metrics.precisionAtK >= 0)
    assert.equal(result.latencyMs, 9)
    assert.ok(result.reusedIds.length)
  },
)
