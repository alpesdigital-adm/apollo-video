import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  createProofNeedRun,
  hydrateProofNeedRun,
} from '../../src/v2/domain/proof-need.ts'
import {
  stableSerialize,
} from '../../src/v2/domain/canonical-hash.ts'

const hash = (character) => character.repeat(64)

const golden = JSON.parse(fs.readFileSync(
  new URL('../fixtures/proof-needs/stories.json', import.meta.url),
  'utf8',
))

function recipe() {
  const claimBlockId = 'story-block-argument'
  const proofBlockId = 'story-block-proof'
  const ctaBlockId = 'story-block-cta'
  const blocks = [
    {
      id: claimBlockId,
      actId: 'development',
      role: 'argument',
      intent: 'develop-claim',
      dependencies: [],
      sourceCandidateIds: ['take-body'],
      durationTargetMs: { min: 3_000, ideal: 3_000, max: 3_000 },
      content: {
        claimIds: ['claim-main'],
        qualifierIds: [],
        proofIds: [],
      },
      presentation: 'source-video',
      sourceRangeId: 'segment-body',
    },
    {
      id: proofBlockId,
      actId: 'development',
      role: 'proof',
      intent: 'support-claim',
      dependencies: [claimBlockId],
      sourceCandidateIds: ['take-proof'],
      durationTargetMs: { min: 2_000, ideal: 2_000, max: 2_000 },
      content: {
        claimIds: [],
        qualifierIds: [],
        proofIds: ['take-proof'],
      },
      presentation: 'source-video',
      sourceRangeId: 'segment-proof',
    },
    {
      id: ctaBlockId,
      actId: 'resolution',
      role: 'cta',
      intent: 'close',
      dependencies: [proofBlockId],
      sourceCandidateIds: ['take-cta'],
      durationTargetMs: { min: 2_000, ideal: 2_000, max: 2_000 },
      content: {
        claimIds: [],
        qualifierIds: [],
        proofIds: [],
        ctaId: 'cta-main',
      },
      presentation: 'source-video',
      sourceRangeId: 'segment-cta',
    },
  ]
  return {
    id: 'variant-recipe-proof-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    batchId: 'production-batch-1',
    status: 'selected',
    objective: 'sale',
    runHash: hash('a'),
    storyPlan: {
      id: 'story-plan-1',
      schemaVersion: 1,
      compilerVersion: 'variant-recipe-compiler/v1',
      objective: 'sale',
      targetDurationMs: { min: 7_000, max: 7_000 },
      acts: [
        {
          id: 'development',
          role: 'development',
          blockIds: [claimBlockId, proofBlockId],
        },
        {
          id: 'resolution',
          role: 'resolution',
          blockIds: [ctaBlockId],
        },
      ],
      blocks,
      storyHash: hash('b'),
    },
    editPlan: {
      fps: 30,
      videoTracks: [{
        id: 'video-track-1',
        kind: 'base-video',
        clips: [
          {
            storyBlockId: claimBlockId,
            timelineRangeFrames: [0, 90],
          },
          {
            storyBlockId: proofBlockId,
            timelineRangeFrames: [90, 150],
          },
          {
            storyBlockId: ctaBlockId,
            timelineRangeFrames: [150, 210],
          },
        ],
      }],
    },
  }
}

function candidate(category, patch = {}) {
  return {
    id: `evidence-${category}`,
    evidenceHash: hash('c'),
    category,
    sourceArtifactId: 'artifact-evidence-1',
    sourceRangeMs: [1_000, 3_000],
    contextRangeMs: [500, 3_500],
    credibilityScore: .92,
    specificityScore: .9,
    authenticityScore: .95,
    reuseAllowed: true,
    reuseReasons: [],
    ...patch,
  }
}

function createRun(story, evidenceCandidates = []) {
  return createProofNeedRun({
    id: `proof-need-run-${story.id}`,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    batchId: 'production-batch-1',
    targetRecipe: recipe(),
    declarations: [{
      storyBlockId: 'story-block-argument',
      claimId: 'claim-main',
      claimText: story.claimText,
      claimKind: story.claimKind,
    }],
    evidenceCandidates: [evidenceCandidates],
    createdByClientId: 'api-client-1',
    createdAt: '2026-07-29T03:00:00.000Z',
  })
}

test('T-FR-130 golden StoryPlans declare testimonial, data, demonstration and no proof', () => {
  assert.equal(golden.schemaVersion, 'proof-need-golden-stories/v1')
  assert.equal(golden.stories.length, 4)
  for (const story of golden.stories) {
    const candidates = story.evidenceCategory
      ? [candidate(story.evidenceCategory)]
      : []
    const run = createRun(story, candidates)
    const item = run.items[0]
    assert.equal(item.type, story.expectedType)
    assert.equal(item.function, story.expectedFunction)
    assert.equal(item.resolution, story.expectedResolution)
    assert.equal(item.genericCardGenerated, false)
    assert.equal(
      run.storyPlan.proofNeeds[0].type,
      story.expectedType,
    )
    assert.equal(
      item.moment.placement,
      story.claimKind === 'low-risk'
        ? 'not-applicable'
        : 'existing-proof-block',
    )
    assert.equal(item.moment.timelineFrame, 90)
    assert.equal(item.moment.timelineMs, 3_000)
  }
})

test('T-FR-130 searches compatible EvidenceSegments first and selects the strongest exact type', () => {
  const story = golden.stories[0]
  const incompatible = candidate('testimonial', {
    id: 'evidence-incompatible',
    reuseAllowed: false,
    reuseReasons: ['CLAIM_DRIFT'],
  })
  const weak = candidate('case-study', {
    id: 'evidence-weak',
    credibilityScore: .6,
    specificityScore: .6,
    authenticityScore: .6,
  })
  const strongest = candidate('testimonial', {
    id: 'evidence-strong',
    credibilityScore: .99,
    specificityScore: .98,
    authenticityScore: .97,
  })
  const run = createRun(story, [incompatible, weak, strongest])
  const item = run.items[0]
  assert.equal(item.search.strategy, 'evidence-first')
  assert.equal(item.search.attempted, true)
  assert.deepEqual(item.search.categories, ['testimonial', 'case-study'])
  assert.equal(item.resolution, 'selected-evidence')
  assert.equal(item.selectedEvidence.id, 'evidence-strong')
  assert.deepEqual(
    item.search.rejectedEvidence,
    [{
      evidenceId: 'evidence-incompatible',
      reasons: ['CLAIM_DRIFT'],
    }],
  )
  assert.equal(run.summary.selectedEvidenceCount, 1)
  assert.equal(run.summary.genericCardCount, 0)
})

test('T-FR-130 emits proof-unavailable and never fabricates a generic card', () => {
  const run = createRun(golden.stories[2], [])
  const item = run.items[0]
  assert.equal(item.required, true)
  assert.equal(item.search.attempted, true)
  assert.equal(item.resolution, 'proof-unavailable')
  assert.equal(item.proofUnavailable, true)
  assert.equal(item.selectedEvidence, undefined)
  assert.equal(item.genericCardGenerated, false)
  assert.equal(run.summary.proofUnavailableCount, 1)
  assert.equal(run.summary.genericCardCount, 0)
})

test('T-FR-130 hydration rejects fabricated cards or divergent StoryPlan declarations', () => {
  const run = createRun(
    golden.stories[1],
    [candidate('financial-result')],
  )
  assert.equal(hydrateProofNeedRun(run).runHash, run.runHash)
  assert.throws(() => hydrateProofNeedRun({
    ...run,
    items: [{
      ...run.items[0],
      genericCardGenerated: true,
    }],
  }))
  assert.throws(() => hydrateProofNeedRun({
    ...run,
    storyPlan: {
      ...run.storyPlan,
      proofNeeds: [{
        ...run.storyPlan.proofNeeds[0],
        type: 'testimonial',
      }],
    },
  }))
})

test('T-FR-130 hydrates a canonical persistence round-trip independently of JSON key order', () => {
  const run = createRun(golden.stories[0], [])
  const persisted = JSON.parse(stableSerialize(run))
  assert.equal(hydrateProofNeedRun(persisted).runHash, run.runHash)
})
