import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_NOVELTY_BUDGET_POLICY,
  acceptedNoveltyCandidates,
  assertNoveltyBudgetDecision,
  createNoveltyBudgetDecision,
  createNoveltyBudgetPolicy,
  evaluateNoveltyBudget,
  noveltyGroupForMode,
  noveltyGrossUnits,
} from '../../src/v2/domain/novelty-budget.ts'

const POLICY = DEFAULT_NOVELTY_BUDGET_POLICY

function candidate(overrides) {
  return {
    id: 'candidate-1',
    briefId: 'transformation-brief-1',
    mode: 'background-replacement',
    intensityBps: 10_000,
    startFrame: 0,
    endFrame: 90,
    fps: 30,
    servedFromCache: false,
    ...overrides,
  }
}

test('T-FR-114 the decision does not depend on the order candidates arrive in', () => {
  // The whole reason this policy is integer-only. Floating-point addition is
  // not associative, so a float budget could flip a candidate across a
  // threshold purely because the database returned rows in a different order.
  const candidates = [
    candidate({ id: 'c-world', startFrame: 0, endFrame: 90 }),
    candidate({ id: 'c-camera', mode: 'camera-motion', startFrame: 400, endFrame: 460 }),
    candidate({ id: 'c-style', mode: 'stylization', startFrame: 900, endFrame: 1_020 }),
    candidate({ id: 'c-insert', mode: 'cutaway', startFrame: 1_500, endFrame: 1_590 }),
  ]
  const forward = evaluateNoveltyBudget({ policy: POLICY, candidates })
  const reversed = evaluateNoveltyBudget({ policy: POLICY, candidates: [...candidates].reverse() })
  const shuffled = evaluateNoveltyBudget({
    policy: POLICY,
    candidates: [candidates[2], candidates[0], candidates[3], candidates[1]],
  })

  assert.deepEqual(forward.lines, reversed.lines)
  assert.deepEqual(forward.lines, shuffled.lines)
  assert.equal(forward.acceptedUnits, reversed.acceptedUnits)
  assert.equal(forward.densityUnits, shuffled.densityUnits)
})

test('T-FR-114 cooldown is half-open and does not drift at the boundary', () => {
  // Every other rule is neutralised on purpose. A test that means to isolate
  // one rule has to say so: the first draft of this one failed on the window
  // budget overflowing by twenty units, which would have made it pass or fail
  // for a reason its own name did not describe.
  const policy = createNoveltyBudgetPolicy({
    ...POLICY, id: 'cooldown-probe', cooldownFrames: 240, minimumSeparationFrames: 0,
    proximityPenaltyBps: 0, repetitionPenaltyBps: 0, diversityFloor: 0,
    totalUnits: 1_000_000, windowUnits: 1_000_000, maximumPerGroup: 1_000,
  })
  const first = candidate({ id: 'first', startFrame: 0, endFrame: 90 })

  // Exactly `cooldownFrames` after the first one ends: allowed.
  const exact = evaluateNoveltyBudget({
    policy,
    candidates: [first, candidate({ id: 'exact', startFrame: 90 + 240, endFrame: 90 + 240 + 90 })],
  })
  assert.equal(exact.lines[1].outcome, 'accepted')

  // One frame earlier: refused. The rule is `< cooldownFrames`, and stating it
  // as half-open is what makes the boundary reproducible instead of a coin flip.
  const oneEarly = evaluateNoveltyBudget({
    policy,
    candidates: [first, candidate({ id: 'early', startFrame: 90 + 239, endFrame: 90 + 239 + 90 })],
  })
  assert.equal(oneEarly.lines[1].outcome, 'blocked')
  assert.equal(oneEarly.lines[1].blockedBecause, 'cooldown-active')
})

test('T-FR-114 duration cost is exact at frame boundaries', () => {
  const policy = createNoveltyBudgetPolicy({
    ...POLICY, id: 'duration-probe',
    baseUnitsByGroup: { world: 0, style: 0, insert: 0, camera: 0, light: 0 },
    unitsPerSecond: 100,
  })
  // Seconds are ceilinged: 31 frames at 30fps is two seconds of screen time.
  // Rounding down would make one frame over a boundary cheaper than one frame
  // under it, which is a real drift and not a rounding curiosity.
  assert.equal(noveltyGrossUnits(policy, candidate({ startFrame: 0, endFrame: 30 })), 100)
  assert.equal(noveltyGrossUnits(policy, candidate({ startFrame: 0, endFrame: 31 })), 200)
  assert.equal(noveltyGrossUnits(policy, candidate({ startFrame: 0, endFrame: 60 })), 200)
  assert.equal(noveltyGrossUnits(policy, candidate({ startFrame: 0, endFrame: 61 })), 300)
  // Intensity is applied in basis points with a single floor, so half intensity
  // of an odd cost is exact and reproducible.
  assert.equal(noveltyGrossUnits(policy, candidate({ startFrame: 0, endFrame: 31, intensityBps: 5_000 })), 100)
  assert.equal(noveltyGrossUnits(policy, candidate({ startFrame: 0, endFrame: 31, intensityBps: 3_333 })), 66)
})

test('T-FR-114 a zero budget blocks everything and says why', () => {
  const policy = createNoveltyBudgetPolicy({ ...POLICY, id: 'zero-budget', totalUnits: 0, windowUnits: 0 })
  const result = evaluateNoveltyBudget({ policy, candidates: [candidate({ id: 'only' })] })

  assert.equal(result.lines[0].outcome, 'blocked')
  assert.equal(result.lines[0].blockedBecause, 'budget-is-zero')
  assert.match(result.lines[0].reason, /no novelty budget at all/)
  assert.equal(result.acceptedUnits, 0)
  // Nothing accepted means nothing to submit. This is the property that keeps a
  // blocked candidate from ever reaching a provider.
  assert.deepEqual(
    acceptedNoveltyCandidates(createNoveltyBudgetDecision({
      workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
      treatmentPlanId: 'treatment-1', storyPlanId: 'story-1',
      policy, candidates: [candidate({ id: 'only' })], evaluatedAt: '2029-03-01T10:00:00.000Z',
    })),
    [],
  )
})

test('T-FR-114 a cache hit costs nothing but still occupies narrative density', () => {
  const policy = createNoveltyBudgetPolicy({
    ...POLICY, id: 'cache-probe', proximityPenaltyBps: 0, repetitionPenaltyBps: 0,
    cooldownFrames: 0, minimumSeparationFrames: 0, diversityFloor: 0,
  })
  const generated = evaluateNoveltyBudget({ policy, candidates: [candidate({ id: 'fresh' })] })
  const reused = evaluateNoveltyBudget({ policy, candidates: [candidate({ id: 'cached', servedFromCache: true })] })

  assert.equal(reused.acceptedUnits, 0)
  assert.equal(reused.lines[0].chargedUnits, 0)
  // The viewer sees the same effect either way, so density is identical.
  // Treating a reused effect as free density is how a video ends up visually
  // exhausting and technically under budget.
  assert.equal(reused.densityUnits, generated.densityUnits)
  assert.equal(reused.lines[0].grossUnits, generated.lines[0].grossUnits)
  assert.match(reused.lines[0].reason, /no new provider call/)
})

test('T-FR-114 the three treatments separate sober, balanced and excessive', () => {
  const spaced = [0, 1_200, 2_400].map((startFrame, index) => candidate({
    id: `sober-${index}`, mode: ['camera-motion', 'relight', 'cutaway'][index],
    startFrame, endFrame: startFrame + 45, intensityBps: 4_000,
  }))
  const sober = evaluateNoveltyBudget({ policy: POLICY, candidates: spaced })
  assert.equal(sober.treatment, 'sober')
  assert.equal(sober.blockedCount, 0)

  const balanced = evaluateNoveltyBudget({
    policy: POLICY,
    candidates: [
      candidate({ id: 'b-0', mode: 'background-replacement', startFrame: 0, endFrame: 120, intensityBps: 8_000 }),
      candidate({ id: 'b-1', mode: 'camera-motion', startFrame: 700, endFrame: 790, intensityBps: 6_000 }),
      candidate({ id: 'b-2', mode: 'stylization', startFrame: 1_500, endFrame: 1_620, intensityBps: 7_000 }),
    ],
  })
  assert.equal(balanced.treatment, 'balanced')

  // Excess: same group, back to back, at full intensity. The policy has to
  // refuse these before the provider, not after the invoice.
  const excessive = evaluateNoveltyBudget({
    policy: POLICY,
    candidates: [0, 100, 200, 300, 400, 500].map((startFrame, index) => candidate({
      id: `x-${index}`, mode: 'background-replacement',
      startFrame, endFrame: startFrame + 90, intensityBps: 10_000,
    })),
  })
  assert.ok(excessive.blockedCount >= 4, `expected most of the pile-up blocked, got ${excessive.blockedCount}`)
  assert.ok(excessive.lines.some((line) => line.blockedBecause === 'cooldown-active'))
})

test('T-FR-114 the decision is content-addressed and rejects tampering', () => {
  const decision = createNoveltyBudgetDecision({
    workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    treatmentPlanId: 'treatment-1', storyPlanId: 'story-1',
    policy: POLICY,
    candidates: [candidate({ id: 'only' })],
    evaluatedAt: '2029-03-01T10:00:00.000Z',
  })
  assert.equal(assertNoveltyBudgetDecision(decision), decision)
  assert.equal(decision.policyHash, POLICY.policyHash)
  assert.equal(decision.id, `novelty-budget-decision-${decision.decisionHash.slice(0, 32)}`)

  assert.throws(
    () => assertNoveltyBudgetDecision({ ...decision, acceptedUnits: decision.acceptedUnits + 1 }),
    /hash does not match/,
  )
  assert.throws(
    () => assertNoveltyBudgetDecision({ ...decision, id: 'novelty-budget-decision-forged' }),
    /id does not match/,
  )
})

test('T-FR-114 modes collapse into the effect groups a viewer actually perceives', () => {
  // Two consecutive background replacements read as the same trick even when
  // the prompts differ, so cooldown counts the group and not the mode.
  assert.equal(noveltyGroupForMode('background-replacement'), 'world')
  assert.equal(noveltyGroupForMode('object-environment-change'), 'world')
  assert.equal(noveltyGroupForMode('stylization'), 'style')
  assert.equal(noveltyGroupForMode('cutaway'), 'insert')
  assert.equal(noveltyGroupForMode('camera-motion'), 'camera')
  assert.equal(noveltyGroupForMode('relight'), 'light')

  const policy = createNoveltyBudgetPolicy({
    ...POLICY, id: 'group-probe', cooldownFrames: 300, minimumSeparationFrames: 0, diversityFloor: 0,
  })
  const crossMode = evaluateNoveltyBudget({
    policy,
    candidates: [
      candidate({ id: 'first', mode: 'background-replacement', startFrame: 0, endFrame: 60 }),
      candidate({ id: 'second', mode: 'object-environment-change', startFrame: 100, endFrame: 160 }),
    ],
  })
  assert.equal(crossMode.lines[1].blockedBecause, 'cooldown-active')
})
